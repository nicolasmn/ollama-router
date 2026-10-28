// audio.ts - POST /v1/audio/speech, /v1/audio/transcriptions, /v1/audio/translations
// OpenAI-compatible audio endpoints (Ollama v0.40.8+). Raw passthrough to the
// node hosting the requested model: speech bodies are JSON, transcriptions and
// translations are multipart/form-data — both are forwarded byte-for-byte with
// the original Content-Type, and the upstream response (streamed WAV/PCM for
// speech, JSON for transcriptions) is piped straight back to the client.
import { request } from 'undici'
import { pipeline } from 'node:stream/promises'
import pino from 'pino'
import type { Application, Request, Response } from 'express'
import { INFERENCE_TIMEOUT } from '../config.js'
import type { DiscoveryManager } from '../discovery-manager.js'
import { findNodeForModel } from './ollama.js'

const logger = pino()

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

async function passthroughAudio(
  req: Request,
  res: Response,
  discoveryManager: DiscoveryManager,
  endpoint: string,
): Promise<void> {
  const abortController = new AbortController()
  const onClientClose = () => abortController.abort()
  res.once('close', onClientClose)
  try {
    const raw = await readRawBody(req)
    const contentType = req.headers['content-type'] ?? 'application/json'
    const modelName = extractModel(raw, contentType)
    if (!modelName) {
      res.status(400).json({ error: 'model is required' })
      return
    }
    const nodeHost = findNodeForModel(discoveryManager, modelName)
    if (!nodeHost) {
      res.status(404).json({ error: `model '${modelName}' not found` })
      return
    }
    const upstream = await request(`${nodeHost}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: raw,
      headersTimeout: INFERENCE_TIMEOUT,
      bodyTimeout: INFERENCE_TIMEOUT,
      signal: abortController.signal,
    })
    if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
      const detail = await upstream.body.text().catch(() => '')
      logger.warn(
        { endpoint, nodeHost, modelName, status: upstream.statusCode, detail: detail.slice(0, 300) },
        'Audio upstream error',
      )
      if (res.headersSent) return
      res.status(upstream.statusCode).type('application/json').send(detail || 'Upstream error')
      return
    }
    res.status(upstream.statusCode)
    const outContentType = upstream.headers['content-type']
    if (outContentType) res.setHeader('Content-Type', outContentType)
    await pipeline(upstream.body, res)
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

export function setupAudioRoutes(app: Application, discoveryManager: DiscoveryManager): void {
  app.post('/v1/audio/speech', (req, res) =>
    passthroughAudio(req, res, discoveryManager, '/v1/audio/speech'))
  app.post('/v1/audio/transcriptions', (req, res) =>
    passthroughAudio(req, res, discoveryManager, '/v1/audio/transcriptions'))
  app.post('/v1/audio/translations', (req, res) =>
    passthroughAudio(req, res, discoveryManager, '/v1/audio/translations'))
}
