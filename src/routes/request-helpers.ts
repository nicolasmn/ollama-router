// request-helpers.ts - Shared request handling utilities
import { request } from 'undici'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import type { Response } from 'express'
import { INFERENCE_TIMEOUT } from '../config.js'
import { createLogger } from '../logger.js'
import type { DiscoveryManager } from '../discovery-manager.js'
import type { LoadManager } from '../load-manager.js'
import type { RequestHistoryManager } from '../request-history.js'
import type { RoutingCandidate, RouterError } from '../request-router.js'
import { cloudUsageStore } from '../cloud-usage.js'

export type { RouterError } from '../request-router.js'

const logger = createLogger('request')

/** Rough tokens-per-character estimate for SSE streams without eval stats. */
const APPROX_CHARS_PER_TOKEN = 4

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function makeRequestId(): string {
  return Math.random().toString(36).slice(2, 11)
}

function isLoadOnlyResponse(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false
  const r = obj as Record<string, unknown>
  return r.done === true && r.done_reason === 'load'
}

function rewriteModelField(result: unknown, requestedModel: string): unknown {
  if (!result || typeof result !== 'object') return result
  return { ...(result as Record<string, unknown>), model: requestedModel }
}

/** Ollama reports load_duration in nanoseconds; returns milliseconds, or 0 when absent. */
function extractLoadDurationMs(result: unknown): number {
  if (!result || typeof result !== 'object') return 0
  const ns = (result as Record<string, unknown>).load_duration
  if (typeof ns !== 'number' || !Number.isFinite(ns) || ns <= 0) return 0
  return Math.round(ns / 1e6)
}

/** Ollama reports eval_duration in nanoseconds; returns milliseconds, or 0 when absent/zero. */
function extractEvalDurationMs(result: unknown): number {
  if (!result || typeof result !== 'object') return 0
  const ns = (result as Record<string, unknown>).eval_duration
  if (typeof ns !== 'number' || !Number.isFinite(ns) || ns <= 0) return 0
  return Math.round(ns / 1e6)
}

/** Ollama reports the number of tokens in eval_count; 0 when absent/zero. */
function extractEvalCount(result: unknown): number {
  if (!result || typeof result !== 'object') return 0
  const count = (result as Record<string, unknown>).eval_count
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return 0
  return Math.round(count)
}

/**
 * Output text delta carried by a stream chunk, for token estimation when the
 * upstream does not send eval stats (OpenAI-format SSE). Handles native
 * Ollama NDJSON, OpenAI chat SSE, and the Responses API delta events.
 * Reasoning text counts too — Ollama's eval_count includes it.
 */
function streamDeltaText(parsed: Record<string, unknown>): string {
  const msg = parsed.message as Record<string, unknown> | undefined
  if (msg && typeof msg.content === 'string' && msg.content) return msg.content
  if (msg && typeof (msg as Record<string, unknown>).thinking === 'string') {
    const thinking = (msg as Record<string, unknown>).thinking as string
    if (thinking) return thinking
  }
  if (typeof parsed.response === 'string' && parsed.response) return parsed.response
  const choices = parsed.choices as Array<{ delta?: { content?: unknown } | null; text?: unknown }> | undefined
  const delta = choices?.[0]?.delta
  if (delta && typeof delta.content === 'string' && delta.content) return delta.content
  if (choices?.[0] && typeof choices[0].text === 'string' && choices[0].text) return choices[0].text
  if (parsed.type === 'response.output_text.delta' && typeof parsed.delta === 'string' && parsed.delta) {
    return parsed.delta
  }
  return ''
}

/** Fire-and-forget cloud usage refresh; only triggers when the node is a cloud node. */
function maybeRefreshCloudUsage(apiKey: string): void {
  if (!apiKey) return
  cloudUsageStore.refresh().catch(() => { /* ignore — background refresh */ })
}

export function handleSelectionError(
  err: RouterError,
  res: Response,
  requestId: string,
  contextMessage: string,
  routeLogger: ReturnType<typeof createLogger>,
): boolean {
  if (err?.statusCode === 404 || err?.code === 'MODEL_NOT_FOUND') {
    routeLogger.warn({ requestId, err: err.message }, contextMessage)
    res.status(404).json({ error: err.message })
    return true
  }
  if (err?.code === 'MODEL_NOT_DECISION') {
    routeLogger.warn({ requestId, err: err.message }, contextMessage)
    res.status(400).json({ error: err.message })
    return true
  }
  return false
}

function hasNoCandidates(
  candidates: RoutingCandidate[] | null,
): boolean {
  return !candidates || candidates.length === 0
}

function respondNoCandidates(
  requestId: string,
  taskType: string,
  res: Response,
  routeLogger: ReturnType<typeof createLogger>,
): void {
  routeLogger.warn({ requestId, taskType }, 'No suitable models available')
  res.status(503).json({ error: 'No suitable models available' })
}

export interface SelectCandidatesOptions {
  requestId: string
  reqBody: Record<string, unknown>
  taskType: string
  res: Response
  requestHistoryManager: RequestHistoryManager
  selectFn: (reqBody: Record<string, unknown>) => Promise<RoutingCandidate[] | null>
  selectionErrorMessage: string
  logger: ReturnType<typeof createLogger>
}

export async function selectCandidatesOrHandleError(
  opts: SelectCandidatesOptions,
): Promise<RoutingCandidate[] | null> {
  const { requestId, reqBody, taskType, res, requestHistoryManager, selectFn, selectionErrorMessage, logger: routeLogger } = opts
  try {
    const candidates = await selectFn(reqBody)
    if (hasNoCandidates(candidates)) {
      requestHistoryManager.finishRequest(requestId, {
        status: 'failed',
        responseStatus: 503,
        error: 'No suitable models available',
      })
      respondNoCandidates(requestId, taskType, res, routeLogger)
      return null
    }
    return candidates
  } catch (err) {
    const routerErr = err as RouterError
    const handled = handleSelectionError(routerErr, res, requestId, selectionErrorMessage, routeLogger)
    if (handled) {
      const isDecisionError = routerErr.code === 'MODEL_NOT_DECISION'
      requestHistoryManager.finishRequest(requestId, {
        status: 'failed',
        responseStatus: isDecisionError ? 400 : 404,
        error: routerErr.message,
        failureCategory: isDecisionError ? 'wrong_model_type' : 'model_not_found',
        retryHint: 'no_retry',
      })
      return null
    }
    throw err
  }
}

export function createAbortError(): Error {
  const err = new Error('Request aborted')
  err.name = 'AbortError'
  return err
}

export function isAbortError(err: RouterError | null | undefined): boolean {
  return (
    err?.name === 'AbortError' ||
    err?.code === 'ABORT_ERR' ||
    err?.code === 'ERR_ABORTED' ||
    err?.code === 'ECONNRESET' ||
    err?.code === 'ECONNABORTED'
  )
}

function bindAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => {}
  if (signal.aborted) { controller.abort(); return () => {} }
  const onAbort = () => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  return () => signal.removeEventListener('abort', onAbort)
}

/** Upstream decision models reject oversized questions with a 400 that states
 *  their own cap, e.g. `question "next": criteria must contain 2–26 candidates`. */
export function parseCriteriaCap(message: string): number | null {
  const m = /criteria must contain 2[–—-]\s*(\d+)/.exec(message || '')
  return m ? Number(m[1]) : null
}

function categorizeFailure(err: RouterError): { failureCategory: string; retryHint: string } {  const statusCode = typeof err?.statusCode === 'number' ? Number(err.statusCode) : 0
  if (isAbortError(err)) return { failureCategory: 'client_abort', retryHint: 'no_retry' }
  if (statusCode === 429 || statusCode === 503 || err?.message === 'Node busy')
    return { failureCategory: 'capacity', retryHint: 'retry_later' }
  if (err?.code === 'UND_ERR_HEADERS_TIMEOUT' || err?.code === 'UND_ERR_BODY_TIMEOUT' || err?.code === 'ETIMEDOUT')
    return { failureCategory: 'timeout', retryHint: 'switch_model' }
  if (err?.code === 'ECONNREFUSED' || err?.code === 'EAI_AGAIN' || err?.code === 'ENOTFOUND' || err?.code === 'ECONNRESET')
    return { failureCategory: 'network', retryHint: 'retry_later' }
  if (statusCode >= 500) return { failureCategory: 'upstream_error', retryHint: 'switch_model' }
  return { failureCategory: 'upstream_error', retryHint: 'retry_now' }
}

async function resolveImageUrls(content: unknown[]): Promise<unknown[]> {
  return Promise.all(
    content.map(async (part) => {
      if (!part || typeof part !== 'object') return part
      const p = part as Record<string, unknown>
      if (p.type !== 'image_url') return part
      const imageUrl = p.image_url as { url: string; detail?: string } | undefined
      if (!imageUrl?.url) return part
      const url = imageUrl.url
      if (!url.startsWith('http://') && !url.startsWith('https://')) return part
      try {
        const { fetch } = await import('undici')
        const resp = await fetch(url, { headers: { 'User-Agent': 'ollama-router/1.0' } })
        if (!resp.ok) {
          logger.warn({ url, status: resp.status }, 'Image URL fetch returned non-2xx, passing through')
          return part
        }
        const contentType = resp.headers.get('content-type') ?? 'image/jpeg'
        const mediaType = contentType.split(';')[0].trim()
        const buffer = Buffer.from(await resp.arrayBuffer())
        logger.debug({ url, bytes: buffer.length, mediaType }, 'Resolved image URL to base64')
        return { ...p, image_url: { ...imageUrl, url: `data:${mediaType};base64,${buffer.toString('base64')}` } }
      } catch (err) {
        logger.warn({ url, err: (err as Error).message }, 'Failed to fetch image URL, passing through')
        return part
      }
    }),
  )
}

async function sanitizeMessages(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!Array.isArray(body.messages)) return body
  const messages = await Promise.all(
    body.messages.map(async (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return msg
      const m = msg as Record<string, unknown>
      if (m.content === null) return { ...m, content: '' }
      if (!Array.isArray(m.content)) return m
      return { ...m, content: await resolveImageUrls(m.content) }
    }),
  )
  return { ...body, messages }
}

function buildHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  return headers
}

export async function forwardRequest(
  baseUrl: string,
  modelName: string,
  reqBody: Record<string, unknown>,
  endpoint: string,
  options: { signal?: AbortSignal; apiKey?: string } = {},
): Promise<unknown> {
  const body = await sanitizeMessages({ ...reqBody, model: modelName })

  const resp = await request(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: buildHeaders(options.apiKey ?? ''),
    body: JSON.stringify(body),
    headersTimeout: INFERENCE_TIMEOUT,
    bodyTimeout: INFERENCE_TIMEOUT,
    signal: options.signal,
  })
  if (resp.statusCode === 503) throw new Error('Node busy')
  if (resp.statusCode < 200 || resp.statusCode >= 300) {
    let detail = ''
    try { detail = await resp.body.text() } catch { /* ignore */ }
    throw Object.assign(new Error(`HTTP ${resp.statusCode}${detail ? ': ' + detail : ''}`), { statusCode: resp.statusCode }) as RouterError
  }
  return resp.body.json()
}

export interface StreamingRequestOptions {
  requestId: string
  reqBody: Record<string, unknown>
  candidate: RoutingCandidate
  endpoint: string
  forwardContentType?: boolean
  sseTerminator?: boolean
  res: Response
  discoveryManager: DiscoveryManager
  loadManager: LoadManager
  requestHistoryManager: RequestHistoryManager
  signal?: AbortSignal
}

// OpenAI-compatible upstreams frame stream events as `data: {...}` (SSE);
// native Ollama streams are bare NDJSON lines. Strip the framing so the
// capture path can parse both wire formats.
function parseStreamLine(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
  if (!payload || payload === '[DONE]') return null
  try {
    return JSON.parse(payload) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function handleStreamingRequest(
  opts: StreamingRequestOptions,
): Promise<void> {
  const {
    requestId,
    reqBody,
    candidate,
    endpoint,
    forwardContentType = false,
    sseTerminator = false,
    res,
    discoveryManager,
    loadManager,
    requestHistoryManager,
    signal,
  } = opts

  const { nodeHost, modelName } = candidate

  if (!nodeHost || !modelName) {
    logger.error({ requestId, endpoint }, 'Missing streaming candidate')
    requestHistoryManager.finishRequest(requestId, {
      status: 'failed',
      responseStatus: 503,
      error: 'No suitable models available',
    })
    res.status(503).json({ error: 'No suitable models available' })
    return
  }

  if (signal?.aborted) {
    requestHistoryManager.finishRequest(requestId, {
      status: 'aborted',
      responseStatus: 0,
      abortReason: 'client_disconnect',
      failureCategory: 'client_abort',
      retryHint: 'no_retry',
    })
    return
  }

  const abortController = new AbortController()
  const onClientClose = () => abortController.abort()
  const removeExternalAbortListener = bindAbortSignal(signal, abortController)
  res.once('close', onClientClose)

  try {
    if (signal?.aborted) {
      requestHistoryManager.finishRequest(requestId, {
        status: 'aborted',
        responseStatus: 0,
        abortReason: 'client_disconnect',
        failureCategory: 'client_abort',
        retryHint: 'no_retry',
        nodeHost,
        modelName,
      })
      return
    }

    try {
      loadManager.incrementLoad(nodeHost)
    } catch {
      logger.warn({ requestId, nodeHost }, 'Node capacity exceeded')
      requestHistoryManager.recordAttempt(requestId, { nodeHost, modelName, status: 'capacity' })
      requestHistoryManager.finishRequest(requestId, {
        status: 'failed',
        responseStatus: 429,
        error: 'Node at capacity',
        nodeHost,
        modelName,
      })
      res.status(429).json({ error: 'Node at capacity' })
      return
    }

    const apiKey = discoveryManager.getCloudApiKey(nodeHost)
    const body = await sanitizeMessages({ ...reqBody, model: modelName })
    const startTime = Date.now()
    let modelLoadMs = 0
    // Streaming telemetry, from either wire format:
    // - native Ollama streams carry eval stats on the final NDJSON chunk
    // - OpenAI-format SSE never does, so tokens are estimated from deltas
    let firstChunkMs = 0      // elapsed ms until first content-bearing chunk (TTFT)
    let streamEvalCount = 0
    let streamEvalDurMs = 0
    let contentChars = 0

    // Parse one raw line: forward it as-is, record timings/eval stats for
    // metrics, and rewrite the model field when the upstream renames it.
    const processStreamLine = (raw: string): { line: string; parsed: Record<string, unknown> | null } => {
      const trimmed = raw.trim()
      if (!trimmed) return { line: raw, parsed: null }
      try {
        let parsed = parseStreamLine(trimmed)
        if (!parsed) return { line: raw, parsed: null }
        if (firstChunkMs === 0 && !isLoadOnlyResponse(parsed)) {
          firstChunkMs = Date.now() - startTime
        }
        const chunkLoadMs = extractLoadDurationMs(parsed)
        if (chunkLoadMs > 0) modelLoadMs = chunkLoadMs
        const chunkEvalCount = extractEvalCount(parsed)
        if (chunkEvalCount > 0) streamEvalCount = chunkEvalCount
        const chunkEvalDurMs = extractEvalDurationMs(parsed)
        if (chunkEvalDurMs > 0) streamEvalDurMs = chunkEvalDurMs
        const deltaText = streamDeltaText(parsed)
        if (deltaText) contentChars += deltaText.length
        let line = raw
        if (modelName && parsed.model !== modelName) {
          parsed = { ...parsed, model: modelName }
          const encoded = JSON.stringify(parsed)
          line = trimmed.startsWith('data:') ? `data: ${encoded}` : encoded
        }
        return { line, parsed }
      } catch {
        return { line: raw, parsed: null }
      }
    }

    try {
      requestHistoryManager.recordAttempt(requestId, {
        nodeHost,
        modelName,
        status: 'waiting',
        attemptReason: 'first_try',
      })

      const resp = await request(`${nodeHost}${endpoint}`, {
        method: 'POST',
        headers: buildHeaders(apiKey),
        body: JSON.stringify(body),
        headersTimeout: INFERENCE_TIMEOUT,
        bodyTimeout: INFERENCE_TIMEOUT,
        signal: abortController.signal,
      })

      if (resp.statusCode === 503) throw new Error('Node busy')
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        let detail = ''
        try {
          detail = await resp.body.text()
        } catch {
          /* ignore */
        }
        throw Object.assign(
          new Error(`HTTP ${resp.statusCode}${detail ? ': ' + detail : ''}`),
          { statusCode: resp.statusCode },
        )
      }

      if (forwardContentType) {
        const ct = resp.headers['content-type']
        if (ct) res.setHeader('Content-Type', ct as string)
      } else {
        res.setHeader('Content-Type', 'application/x-ndjson')
      }
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('X-Accel-Buffering', 'no')

      let lineBuffer = ''
      const captureTransform = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          lineBuffer += chunk.toString('utf-8')
          let nl = lineBuffer.indexOf('\n')
          const outputLines: string[] = []
          while (nl !== -1) {
            const line = lineBuffer.slice(0, nl)
            lineBuffer = lineBuffer.slice(nl + 1)
            const { line: processed, parsed } = processStreamLine(line)
            if (parsed) {
              requestHistoryManager.applyStreamingEvent(requestId, parsed)
            }
            outputLines.push(processed + '\n')
            nl = lineBuffer.indexOf('\n')
          }
          callback(null, outputLines.join(''))
        },
        flush(callback) {
          const trimmed = lineBuffer.trim()
          if (trimmed) {
            const { line: processed, parsed } = processStreamLine(lineBuffer)
            if (parsed) {
              requestHistoryManager.applyStreamingEvent(requestId, parsed)
            }
            callback(null, processed)
            return
          }
          callback(null, lineBuffer)
        },
      })
      await pipeline(resp.body, captureTransform, res)

      const latency = Date.now() - startTime
      const ttftMs = firstChunkMs > 0 ? firstChunkMs : 0
      // Native Ollama streams report eval stats on the final chunk; for
      // OpenAI-format SSE estimate tokens from the delta text.
      const tokensGenerated =
        streamEvalCount > 0
          ? streamEvalCount
          : contentChars > 0
            ? Math.round(contentChars / APPROX_CHARS_PER_TOKEN)
            : 0
      const decodeMs =
        streamEvalDurMs > 0
          ? streamEvalDurMs
          : tokensGenerated > 0 && ttftMs > 0
            ? Math.max(1, latency - ttftMs)
            : 0
      discoveryManager.updateModelMetrics(nodeHost, modelName, latency, tokensGenerated, endpoint, {
        ttftMs,
        loadMs: modelLoadMs,
        decodeMs,
      })
      requestHistoryManager.recordAttempt(requestId, { nodeHost, modelName, status: 'success', latency })
      requestHistoryManager.finishRequest(requestId, { status: 'success', responseStatus: 200, latency, nodeHost, modelName, tokensGenerated, modelLoadMs })
      requestHistoryManager.finalizeStreamingResponse(requestId)
      maybeRefreshCloudUsage(apiKey)
      logger.info({ requestId, nodeHost, modelName, endpoint, latency }, 'Streaming request successful')
    } catch (err) {
      const typedErr = err as RouterError
      const clientDisconnected =
        isAbortError(typedErr) ||
        typedErr?.code === 'ERR_STREAM_DESTROYED' ||
        res.destroyed
      const latency = Date.now() - startTime

      if (clientDisconnected) {
        const abortReason = signal?.aborted || res.destroyed ? 'client_disconnect' : 'upstream_abort'
        logger.info({ requestId, nodeHost, modelName, latency }, 'Client disconnected during streaming')
        requestHistoryManager.recordAttempt(requestId, { nodeHost, modelName, status: 'aborted', latency })
        requestHistoryManager.finishRequest(requestId, { status: 'aborted', responseStatus: 0, latency, abortReason, failureCategory: 'client_abort', retryHint: 'no_retry', nodeHost, modelName, modelLoadMs })
        return
      }

      discoveryManager.recordModelFailure(nodeHost, modelName, typedErr as NodeJS.ErrnoException)
      requestHistoryManager.recordAttempt(requestId, { nodeHost, modelName, status: 'failed', latency, error: typedErr.message })

      const { failureCategory, retryHint } = categorizeFailure(typedErr)
      const responseStatus = res.headersSent ? res.statusCode : 503
      logger.error({ requestId, nodeHost, modelName, endpoint, err: typedErr.message }, 'Streaming request failed')
      requestHistoryManager.finishRequest(requestId, { status: 'failed', responseStatus, latency, failureCategory, retryHint, nodeHost, modelName, error: typedErr.message, modelLoadMs })
      if (!res.headersSent) {
        res.status(503).json({ error: typedErr.message })
      } else if (!res.writableEnded) {
        if (sseTerminator) res.write('data: [DONE]\n\n')
        res.end()
      }
    } finally {
      loadManager.decrementLoad(nodeHost)
    }
  } finally {
    removeExternalAbortListener()
    res.off('close', onClientClose)
  }
}

export interface TryCandidatesOptions {
  requestId: string
  candidates: RoutingCandidate[]
  reqBody: Record<string, unknown>
  endpoint: string
  tokensFromResult: (result: unknown) => number
  responseContentFrom?: ((result: unknown) => unknown) | null
  successLog?: string
  failureLog?: string
  res: Response
  discoveryManager: DiscoveryManager
  loadManager: LoadManager
  requestHistoryManager: RequestHistoryManager
  signal?: AbortSignal
}

export async function tryCandidatesWithRetry(opts: TryCandidatesOptions): Promise<boolean> {
  const {
    requestId, candidates, reqBody, endpoint,
    tokensFromResult, responseContentFrom,
    successLog, failureLog,
    res, discoveryManager, loadManager, requestHistoryManager, signal,
  } = opts

  let lastFailure: {
    responseStatus: number; error: string; failureCategory: string
    retryHint: string; nodeHost: string; modelName: string
  } | null = null

  if (signal?.aborted) {
    requestHistoryManager.finishRequest(requestId, { status: 'aborted', responseStatus: 0, abortReason: 'client_disconnect', failureCategory: 'client_abort', retryHint: 'no_retry' })
    return true
  }

  for (let index = 0; index < candidates.length; index += 1) {
    if (signal?.aborted) {
      requestHistoryManager.finishRequest(requestId, { status: 'aborted', responseStatus: 0, abortReason: 'client_disconnect', failureCategory: 'client_abort', retryHint: 'no_retry' })
      return true
    }
    const { nodeHost, modelName } = candidates[index]

    try {
      loadManager.incrementLoad(nodeHost)
    } catch {
      requestHistoryManager.recordAttempt(requestId, { nodeHost, modelName, status: 'capacity', attemptReason: index === 0 ? 'first_try' : 'fallback_capacity' })
      lastFailure = { responseStatus: 429, error: 'Node at capacity', failureCategory: 'capacity', retryHint: 'retry_later', nodeHost, modelName }
      logger.debug({ requestId, nodeHost }, 'Node capacity exceeded, trying next')
      continue
    }

    const apiKey = discoveryManager.getCloudApiKey(nodeHost)
    const startTime = Date.now()

    try {
      requestHistoryManager.recordAttempt(requestId, { nodeHost, modelName, status: 'waiting', attemptReason: index === 0 ? 'first_try' : 'fallback_error' })

      let result = await forwardRequest(nodeHost, modelName, reqBody, endpoint, { signal, apiKey })
      let modelLoadMs = extractLoadDurationMs(result)

      if (isLoadOnlyResponse(result)) {
        logger.info({ requestId, nodeHost, modelName }, 'Load-only response, retrying')
        requestHistoryManager.recordAttempt(requestId, { nodeHost, modelName, status: 'waiting', attemptReason: 'load_retry' })
        result = await forwardRequest(nodeHost, modelName, reqBody, endpoint, { signal, apiKey })
        modelLoadMs = extractLoadDurationMs(result) || modelLoadMs
      }

      // Always rewrite to the actual routed model name, not the originally requested model
      result = rewriteModelField(result, modelName)

      const latency = Date.now() - startTime
      if (responseContentFrom) requestHistoryManager.updateResponseContent(requestId, responseContentFrom(result))
      const tokensGenerated = tokensFromResult(result)
      discoveryManager.updateModelMetrics(nodeHost, modelName, latency, tokensGenerated, endpoint, {
        loadMs: modelLoadMs,
        decodeMs: extractEvalDurationMs(result),
      })
      requestHistoryManager.recordAttempt(requestId, { nodeHost, modelName, status: 'success', latency })
      requestHistoryManager.finishRequest(requestId, { status: 'success', responseStatus: 200, latency, nodeHost, modelName, tokensGenerated, modelLoadMs })
      maybeRefreshCloudUsage(apiKey)
      logger.info({ requestId, nodeHost, modelName, latency }, successLog ?? `${endpoint} successful`)
      res.json(result)
      return true
    } catch (err) {
      const typedErr = err as RouterError
      if (isAbortError(typedErr) || signal?.aborted) {
        const latency = Date.now() - startTime
        requestHistoryManager.recordAttempt(requestId, { nodeHost, modelName, status: 'aborted', latency, attemptReason: index === 0 ? 'first_try' : 'fallback_error' })
        requestHistoryManager.finishRequest(requestId, { status: 'aborted', responseStatus: 0, latency, abortReason: 'client_disconnect', failureCategory: 'client_abort', retryHint: 'no_retry', nodeHost, modelName })
        return true
      }
      const { failureCategory, retryHint } = categorizeFailure(typedErr)
      const responseStatus = typeof typedErr?.statusCode === 'number' ? typedErr.statusCode : 503
      const latency = Date.now() - startTime
      logger.warn({ requestId, nodeHost, modelName, err: typedErr.message }, failureLog ?? `${endpoint} failed, trying next`)
      discoveryManager.recordModelFailure(nodeHost, modelName, typedErr as NodeJS.ErrnoException)
      // The cap error is deterministic per (body, model) — recording it here
      // means the NEXT request of this size routes correctly on first try.
      const learnedCap = endpoint === '/v1/systemone' ? parseCriteriaCap(typedErr.message) : null
      if (learnedCap) discoveryManager.setSystemoneCriteriaCap(nodeHost, modelName, learnedCap)
      requestHistoryManager.recordAttempt(requestId, { nodeHost, modelName, status: 'failed', latency, error: typedErr.message, attemptReason: index === 0 ? 'first_try' : 'fallback_error' })
      lastFailure = { responseStatus, error: typedErr.message, failureCategory, retryHint, nodeHost, modelName }
    } finally {
      loadManager.decrementLoad(nodeHost)
    }
  }

  if (lastFailure) {
    requestHistoryManager.finishRequest(requestId, { status: 'failed', responseStatus: lastFailure.responseStatus, error: lastFailure.error, failureCategory: lastFailure.failureCategory, retryHint: lastFailure.retryHint, modelName: lastFailure.modelName, nodeHost: lastFailure.nodeHost })
  }
  return false
}
