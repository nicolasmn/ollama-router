// audio.ts - POST /v1/audio/speech, /v1/audio/transcriptions, /v1/audio/translations
// OpenAI-compatible audio endpoints (Ollama v0.40.8+). Raw passthrough to the
// node hosting the requested model: speech bodies are JSON, transcriptions and
// translations are multipart/form-data — both are forwarded with the original
// Content-Type, and the upstream response (streamed WAV/PCM for speech, JSON for
// transcriptions) is piped straight back to the client.
//
// Request lifecycle is tracked in RequestHistoryManager (dashboard visibility)
// and captured audio payloads are stored on disk for the dashboard playback
// endpoint. Model resolution supports virtual aliases (auto-fast) and unknown
// models: the best audio-capable model is selected and the forwarded payload's
// model field is rewritten.
import { request } from 'undici'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pino from 'pino'
import type { Application, Request, Response } from 'express'
import { INFERENCE_TIMEOUT, AUDIO_MAX_CAPTURE_BYTES, resolveAudioCaptureDir } from '../config.js'
import type { DiscoveryManager } from '../discovery-manager.js'
import type { LoadManager } from '../load-manager.js'
import type { RequestRouter } from '../request-router.js'
import type { RequestHistoryManager } from '../request-history.js'
import { makeRequestId } from './request-helpers.js'

const logger = pino()

const AUDIO_TASK_TYPES = ['speech', 'transcription', 'translation'] as const
type AudioTaskType = (typeof AUDIO_TASK_TYPES)[number]

function readRawBody(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Extract the `model` field from a JSON body or a multipart/form-data body. */
function extractModel(raw: Buffer, contentType: string): string | undefined {
  if (contentType.startsWith('application/json')) {
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as { model?: unknown }
      return typeof parsed.model === 'string' ? parsed.model : undefined
    } catch {
      return undefined
    }
  }
  // multipart/form-data: field values are ASCII-safe; scan the header parts.
  const text = raw.toString('latin1')
  const match = text.match(/name="model"\r\n\r\n([^\r\n]+)/)
  return match?.[1]
}

function safeJsonParse(raw: Buffer): Record<string, unknown> {
  try {
    return JSON.parse(raw.toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// multipart/form-data — parse boundary + parts, and rebuild with a new model
// field while preserving field values and file bytes byte-for-byte.
// ---------------------------------------------------------------------------

interface AudioMultipartPart {
  name: string
  filename?: string
  contentType?: string
  body: Buffer
}

function parseMultipart(
  raw: Buffer,
  contentType: string,
): { boundary: string; parts: AudioMultipartPart[] } | null {
  const boundaryMatch = /boundary=(?:"([^";]+)"|([^";]+))/i.exec(contentType)
  const boundary = boundaryMatch ? (boundaryMatch[1] ?? boundaryMatch[2]) : ''
  if (!boundary) return null
  const segments = raw.toString('latin1').split(`--${boundary}`)
  const parts: AudioMultipartPart[] = []
  // segments[0] is the preamble before the first boundary — not a part.
  for (let i = 1; i < segments.length; i += 1) {
    let segment = segments[i]
    if (segment.startsWith('\r\n')) segment = segment.slice(2)
    if (segment.startsWith('--')) break // closing boundary / epilogue
    const separatorIndex = segment.indexOf('\r\n\r\n')
    if (separatorIndex === -1) continue
    const headerBlock = segment.slice(0, separatorIndex)
    const body = Buffer.from(
      segment.slice(separatorIndex + 4).replace(/\r\n$/, ''),
      'latin1',
    )
    const lines = headerBlock.split('\r\n')
    const disposition =
      lines.find((line) => line.toLowerCase().startsWith('content-disposition')) ?? ''
    const nameMatch = /name="([^"]*)"/.exec(disposition)
    const fileMatch = /filename="([^"]*)"/.exec(disposition)
    const contentTypeLine = lines.find((line) => line.toLowerCase().startsWith('content-type'))
    parts.push({
      name: nameMatch?.[1] ?? '',
      filename: fileMatch?.[1],
      contentType: contentTypeLine
        ? contentTypeLine.split(':').slice(1).join(':').trim()
        : undefined,
      body,
    })
  }
  return { boundary, parts }
}

function buildMultipart(boundary: string, parts: AudioMultipartPart[]): Buffer {
  const chunks: Buffer[] = []
  const delimiter = `--${boundary}`
  for (const part of parts) {
    chunks.push(Buffer.from(`${delimiter}\r\n`))
    let header = `Content-Disposition: form-data; name="${part.name}"`
    if (part.filename) header += `; filename="${part.filename}"`
    if (part.contentType) header += `\r\nContent-Type: ${part.contentType}`
    header += '\r\n\r\n'
    chunks.push(Buffer.from(header))
    chunks.push(part.body)
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

/** Rebuild a multipart body with the selected model name, preserving the rest. */
function rebuildMultipartModel(raw: Buffer, contentType: string, selectedModel: string): Buffer {
  const parsed = parseMultipart(raw, contentType)
  if (!parsed) return raw
  const parts = parsed.parts.map((part) =>
    part.name === 'model' ? { ...part, body: Buffer.from(selectedModel, 'utf8') } : part,
  )
  return buildMultipart(parsed.boundary, parts)
}

// ---------------------------------------------------------------------------
// Captured-audio storage (dashboard playback), keyed by requestId.
// ---------------------------------------------------------------------------

async function storeAudioCapture(
  requestId: string,
  kind: string,
  contentType: string,
  bytes: Buffer,
): Promise<string | null> {
  if (bytes.length === 0 || bytes.length > AUDIO_MAX_CAPTURE_BYTES) return null
  const captureDir = resolveAudioCaptureDir()
  await mkdir(captureDir, { recursive: true })
  const path = join(captureDir, `${requestId}.bin`)
  await writeFile(path, bytes)
  logger.debug({ requestId, kind, contentType, bytes: bytes.length }, 'Audio capture stored')
  return path
}

function createCaptureTee(): { stream: Transform; chunks: Buffer[] } {
  const chunks: Buffer[] = []
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk)
      callback(null, chunk)
    },
  })
  return { stream, chunks }
}

// ---------------------------------------------------------------------------
// Audio request handling — history lifecycle + raw passthrough + capture.
// ---------------------------------------------------------------------------

async function handleAudioRequest(
  req: Request,
  res: Response,
  discoveryManager: DiscoveryManager,
  loadManager: LoadManager,
  requestRouter: RequestRouter,
  requestHistoryManager: RequestHistoryManager,
  endpoint: '/v1/audio/speech' | '/v1/audio/transcriptions' | '/v1/audio/translations',
): Promise<void> {
  const abortController = new AbortController()
  const onClientClose = () => abortController.abort()
  res.once('close', onClientClose)
  try {
    const requestId = makeRequestId()
    const raw = await readRawBody(req)
    const contentType = req.headers['content-type'] ?? 'application/json'
    const isMultipart = contentType.toLowerCase().startsWith('multipart/form-data')
    const taskType: AudioTaskType =
      endpoint === '/v1/audio/speech'
        ? 'speech'
        : endpoint.endsWith('/transcriptions')
          ? 'transcription'
          : 'translation'
    const requestedModel = extractModel(raw, contentType) ?? ''
    const reqBody: Record<string, unknown> = isMultipart
      ? { model: requestedModel }
      : { ...safeJsonParse(raw), model: requestedModel }
    const analysis = await requestRouter.analyzeRequest(reqBody, 'audio')

    requestHistoryManager.startRequest({
      requestId,
      endpointType: 'audio',
      reqBody,
      analysis: analysis ?? {},
    })
    requestHistoryManager.registerAbortController(requestId, abortController)

    if (!requestedModel) {
      requestHistoryManager.finishRequest(requestId, { status: 'failed', responseStatus: 400, error: 'model is required' })
      res.status(400).json({ error: 'model is required' })
      return
    }

    const candidates = await requestRouter.selectForAudio(taskType, reqBody, abortController.signal, analysis)
    if (!candidates || candidates.length === 0) {
      logger.warn({ requestId, taskType, endpoint }, 'No audio-capable model available')
      requestHistoryManager.finishRequest(requestId, {
        status: 'failed',
        responseStatus: 503,
        error: 'no audio-capable model available',
      })
      res.status(503).json({ error: 'no audio-capable model available' })
      return
    }

    requestHistoryManager.recordSelection(requestId, candidates)
    const candidate = candidates[0]
    const nodeHost = candidate.nodeHost
    const selectedModel = candidate.modelName
    requestHistoryManager.recordAttempt(requestId, { nodeHost, modelName: selectedModel, status: 'waiting', attemptReason: 'first_try' })

    try {
      loadManager.incrementLoad(nodeHost)
    } catch {
      requestHistoryManager.finishRequest(requestId, { status: 'failed', responseStatus: 429, error: 'Node at capacity', nodeHost, modelName: selectedModel })
      res.status(429).json({ error: 'Node at capacity' })
      return
    }

    const startTime = Date.now()
    const outboundBody = isMultipart
      ? rebuildMultipartModel(raw, contentType, selectedModel)
      : JSON.stringify({ ...reqBody, model: selectedModel })
    const upstream = await request(`${nodeHost}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': isMultipart ? contentType : 'application/json',
        ...(discoveryManager.getCloudApiKey(nodeHost)
          ? { Authorization: `Bearer ${discoveryManager.getCloudApiKey(nodeHost)}` }
          : {}),
      },
      body: outboundBody,
      headersTimeout: INFERENCE_TIMEOUT,
      bodyTimeout: INFERENCE_TIMEOUT,
      signal: abortController.signal,
    })
    logger.info({ nodeHost, selectedModel, endpoint }, 'Audio upstream dispatch')

    if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
      const detail = await upstream.body.text().catch(() => '')
      logger.warn(
        { requestId, endpoint, nodeHost, modelName: selectedModel, status: upstream.statusCode, detail: detail.slice(0, 300) },
        'Audio upstream error',
      )
      requestHistoryManager.finishRequest(requestId, { status: 'failed', responseStatus: upstream.statusCode, error: `HTTP ${upstream.statusCode}`, nodeHost, modelName: selectedModel })
      if (res.headersSent) return
      res.status(upstream.statusCode).type('application/json').send(detail || 'Upstream error')
      return
    }

    res.status(upstream.statusCode)
    const outContentType = upstream.headers['content-type']
    if (outContentType) res.setHeader('Content-Type', outContentType as string)

    if (taskType === 'speech') {
      const capture = createCaptureTee()
      await pipeline(upstream.body, capture.stream, res)
      const audioBuffer = Buffer.concat(capture.chunks)
      const audioContentType = (outContentType as string) || 'audio/wav'
      const audioPath = await storeAudioCapture(requestId, taskType, audioContentType, audioBuffer)
      if (audioPath) {
        requestHistoryManager.setAudioPayload(requestId, {
          kind: taskType,
          contentType: audioContentType,
          bytes: audioBuffer.length,
          path: audioPath,
          capturedAt: Date.now(),
        })
      }
    } else {
      await pipeline(upstream.body, res)
      if (isMultipart) {
        const parsed = parseMultipart(raw, contentType)
        const filePart = parsed?.parts.find((part) => part.filename)
        const captureContentType = filePart?.contentType ?? 'audio/wav'
        const captureBytes = filePart?.body ?? Buffer.alloc(0)
        if (captureBytes.length > 0 && captureBytes.length <= AUDIO_MAX_CAPTURE_BYTES) {
          const audioPath = await storeAudioCapture(requestId, taskType, captureContentType, captureBytes)
          if (audioPath) {
            requestHistoryManager.setAudioPayload(requestId, {
              kind: taskType,
              contentType: captureContentType,
              bytes: captureBytes.length,
              path: audioPath,
              capturedAt: Date.now(),
            })
          }
        }
      }
    }

    const latency = Date.now() - startTime
    discoveryManager.updateModelMetrics(nodeHost, selectedModel, latency, 0, endpoint)
    requestHistoryManager.recordAttempt(requestId, { nodeHost, modelName: selectedModel, status: 'success', latency })
    requestHistoryManager.finishRequest(requestId, { status: 'success', responseStatus: upstream.statusCode, latency, nodeHost, modelName: selectedModel })
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.name === 'AbortError' || abortController.signal.aborted) {
      if (!res.headersSent) res.status(499).json({ error: 'Request cancelled' })
      return
    }
    logger.error({ err, endpoint }, 'Audio passthrough error')
    if (!res.headersSent) res.status(503).json({ error: 'Upstream error' })
  } finally {
    res.off('close', onClientClose)
  }
}

export function setupAudioRoutes(
  app: Application,
  discoveryManager: DiscoveryManager,
  loadManager: LoadManager,
  requestRouter: RequestRouter,
  requestHistoryManager: RequestHistoryManager,
): void {
  app.post('/v1/audio/speech', (req, res) =>
    handleAudioRequest(req, res, discoveryManager, loadManager, requestRouter, requestHistoryManager, '/v1/audio/speech'),
  )
  app.post('/v1/audio/transcriptions', (req, res) =>
    handleAudioRequest(req, res, discoveryManager, loadManager, requestRouter, requestHistoryManager, '/v1/audio/transcriptions'),
  )
  app.post('/v1/audio/translations', (req, res) =>
    handleAudioRequest(req, res, discoveryManager, loadManager, requestRouter, requestHistoryManager, '/v1/audio/translations'),
  )
}
