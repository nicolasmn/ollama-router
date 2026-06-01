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

export type { RouterError } from '../request-router.js'

const logger = createLogger('request')

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
  return false
}

function hasNoCandidates(
  candidates: RoutingCandidate | RoutingCandidate[] | null,
): boolean {
  return !candidates || (Array.isArray(candidates) && candidates.length === 0)
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
  selectFn: (reqBody: Record<string, unknown>) => Promise<RoutingCandidate | RoutingCandidate[] | null>
  selectionErrorMessage: string
  logger: ReturnType<typeof createLogger>
}

export async function selectCandidatesOrHandleError(
  opts: SelectCandidatesOptions,
): Promise<RoutingCandidate | RoutingCandidate[] | null> {
  const { requestId, reqBody, taskType, res, selectFn, selectionErrorMessage, logger: routeLogger } = opts
  try {
    const candidates = await selectFn(reqBody)
    if (hasNoCandidates(candidates)) {
      respondNoCandidates(requestId, taskType, res, routeLogger)
      return null
    }
    return candidates
  } catch (err) {
    const handled = handleSelectionError(err as RouterError, res, requestId, selectionErrorMessage, routeLogger)
    if (handled) return null
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

function categorizeFailure(err: RouterError): { failureCategory: string; retryHint: string } {
  const statusCode = typeof err?.statusCode === 'number' ? Number(err.statusCode) : 0
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
  candidate: RoutingCandidate | RoutingCandidate[]
  endpoint: string
  forwardContentType?: boolean
  sseTerminator?: boolean
  res: Response
  discoveryManager: DiscoveryManager
  loadManager: LoadManager
  requestHistoryManager: RequestHistoryManager
  signal?: AbortSignal
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

  // Normalise to array — enables pre-header fallback across candidates
  const candidateList = Array.isArray(candidate) ? candidate : [candidate]
  const requestedModel =
    (reqBody.model as string | undefined) ?? candidateList[0]?.modelName

  if (!candidateList[0]?.nodeHost || !candidateList[0]?.modelName) {
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
    for (let index = 0; index < candidateList.length; index++) {
      const { nodeHost, modelName } = candidateList[index]

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
        requestHistoryManager.recordAttempt(requestId, {
          nodeHost,
          modelName,
          status: 'capacity',
        })
        if (index < candidateList.length - 1) continue
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

      try {
        requestHistoryManager.recordAttempt(requestId, {
          nodeHost,
          modelName,
          status: 'waiting',
          attemptReason: index === 0 ? 'first_try' : 'fallback_error',
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

        // ── Streaming begins — no fallback to another candidate after this point ──
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
              let line = lineBuffer.slice(0, nl)
              lineBuffer = lineBuffer.slice(nl + 1)
              const trimmed = line.trim()
              if (trimmed) {
                try {
                  let parsed = JSON.parse(trimmed) as Record<string, unknown>
                  if (requestedModel && parsed.model !== requestedModel) {
                    parsed = { ...parsed, model: requestedModel }
                    line = JSON.stringify(parsed)
                  }
                  requestHistoryManager.applyStreamingEvent(requestId, parsed)
                } catch {
                  /* pass through */
                }
              }
              outputLines.push(line + '\n')
              nl = lineBuffer.indexOf('\n')
            }
            callback(null, outputLines.join(''))
          },
          flush(callback) {
            const trimmed = lineBuffer.trim()
            if (trimmed) {
              try {
                let parsed = JSON.parse(trimmed) as Record<string, unknown>
                if (requestedModel && parsed.model !== requestedModel) {
                  parsed = { ...parsed, model: requestedModel }
                  lineBuffer = JSON.stringify(parsed)
                }
                requestHistoryManager.applyStreamingEvent(requestId, parsed)
              } catch {
                /* ignore */
              }
            }
            callback(null, lineBuffer)
          },
        })
        await pipeline(resp.body, captureTransform, res)

        const latency = Date.now() - startTime
        discoveryManager.updateModelMetrics(
          nodeHost,
          modelName,
          latency,
          0,
          endpoint,
        )
        requestHistoryManager.recordAttempt(requestId, {
          nodeHost,
          modelName,
          status: 'success',
          latency,
        })
        requestHistoryManager.finishRequest(requestId, {
          status: 'success',
          responseStatus: 200,
          latency,
          nodeHost,
          modelName,
        })
        requestHistoryManager.finalizeStreamingResponse(requestId)
        logger.info(
          { requestId, nodeHost, modelName, endpoint, latency },
          'Streaming request successful',
        )
        return
      } catch (err) {
        const typedErr = err as RouterError
        const clientDisconnected =
          isAbortError(typedErr) ||
          typedErr?.code === 'ERR_STREAM_DESTROYED' ||
          res.destroyed
        const latency = Date.now() - startTime

        if (clientDisconnected) {
          const abortReason =
            signal?.aborted || res.destroyed
              ? 'client_disconnect'
              : 'upstream_abort'
          logger.info(
            { requestId, nodeHost, modelName, latency },
            'Client disconnected during streaming',
          )
          requestHistoryManager.recordAttempt(requestId, {
            nodeHost,
            modelName,
            status: 'aborted',
            latency,
          })
          requestHistoryManager.finishRequest(requestId, {
            status: 'aborted',
            responseStatus: 0,
            latency,
            abortReason,
            failureCategory: 'client_abort',
            retryHint: 'no_retry',
            nodeHost,
            modelName,
          })
          return
        }

        discoveryManager.recordModelFailure(
          nodeHost,
          modelName,
          typedErr as NodeJS.ErrnoException,
        )
        requestHistoryManager.recordAttempt(requestId, {
          nodeHost,
          modelName,
          status: 'failed',
          latency,
          error: typedErr.message,
        })

        if (!res.headersSent && index < candidateList.length - 1) {
          logger.warn(
            { requestId, nodeHost, modelName, endpoint, err: typedErr.message },
            'Streaming attempt failed, trying next candidate',
          )
          continue
        }

        const { failureCategory, retryHint } = categorizeFailure(typedErr)
        const responseStatus = res.headersSent ? res.statusCode : 503
        logger.error(
          { requestId, nodeHost, modelName, endpoint, err: typedErr.message },
          'Streaming request failed',
        )
        requestHistoryManager.finishRequest(requestId, {
          status: 'failed',
          responseStatus,
          latency,
          failureCategory,
          retryHint,
          nodeHost,
          modelName,
          error: typedErr.message,
        })
        if (!res.headersSent) {
          res.status(503).json({ error: typedErr.message })
        } else if (!res.writableEnded) {
          if (sseTerminator) res.write('data: [DONE]\n\n')
          res.end()
        }
        return
      } finally {
        loadManager.decrementLoad(nodeHost)
      }
    }

    // All candidates were at capacity or exhausted without a successful response
    if (!res.headersSent) {
      requestHistoryManager.finishRequest(requestId, {
        status: 'failed',
        responseStatus: 503,
        error: 'No suitable models available',
      })
      res.status(503).json({ error: 'No suitable models available' })
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

  const requestedModel = reqBody.model as string | undefined

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

      if (isLoadOnlyResponse(result)) {
        logger.info({ requestId, nodeHost, modelName }, 'Load-only response, retrying')
        requestHistoryManager.recordAttempt(requestId, { nodeHost, modelName, status: 'waiting', attemptReason: 'load_retry' })
        result = await forwardRequest(nodeHost, modelName, reqBody, endpoint, { signal, apiKey })
      }

      result = rewriteModelField(result, requestedModel ?? modelName)

      const latency = Date.now() - startTime
      if (responseContentFrom) requestHistoryManager.updateResponseContent(requestId, responseContentFrom(result))
      const tokensGenerated = tokensFromResult(result)
      discoveryManager.updateModelMetrics(nodeHost, modelName, latency, tokensGenerated, endpoint)
      requestHistoryManager.recordAttempt(requestId, { nodeHost, modelName, status: 'success', latency })
      requestHistoryManager.finishRequest(requestId, { status: 'success', responseStatus: 200, latency, nodeHost, modelName, tokensGenerated })
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
