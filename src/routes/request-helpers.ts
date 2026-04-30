// request-helpers.ts - Shared request handling utilities
import { request } from 'undici'
import { pipeline } from 'node:stream/promises'
import type { Response } from 'express'
import { INFERENCE_TIMEOUT } from '../config.js'
import { createLogger } from '../logger.js'
import type { DiscoveryManager } from '../discovery-manager.js'
import type { LoadManager } from '../load-manager.js'
import type { RequestHistoryManager } from '../request-history.js'
import type { RoutingCandidate } from '../request-router.js'

const logger = createLogger('request')

export function makeRequestId(): string {
  return Math.random().toString(36).slice(2, 11)
}

export interface RouterError extends Error {
  statusCode?: number
  code?: string
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
  return (
    !candidates || (Array.isArray(candidates) && candidates.length === 0)
  )
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
  selectFn: (
    reqBody: Record<string, unknown>,
  ) => Promise<RoutingCandidate | RoutingCandidate[] | null>
  selectionErrorMessage: string
  logger: ReturnType<typeof createLogger>
}

export async function selectCandidatesOrHandleError(
  opts: SelectCandidatesOptions,
): Promise<RoutingCandidate | RoutingCandidate[] | null> {
  const {
    requestId,
    reqBody,
    taskType,
    res,
    selectFn,
    selectionErrorMessage,
    logger: routeLogger,
  } = opts
  try {
    const candidates = await selectFn(reqBody)
    if (hasNoCandidates(candidates)) {
      respondNoCandidates(requestId, taskType, res, routeLogger)
      return null
    }
    return candidates
  } catch (err) {
    const handled = handleSelectionError(
      err as RouterError,
      res,
      requestId,
      selectionErrorMessage,
      routeLogger,
    )
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

export async function forwardRequest(
  baseUrl: string,
  modelName: string,
  reqBody: Record<string, unknown>,
  endpoint: string,
  options: { signal?: AbortSignal } = {},
): Promise<unknown> {
  const resp = await request(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reqBody),
    headersTimeout: INFERENCE_TIMEOUT,
    bodyTimeout: INFERENCE_TIMEOUT,
    signal: options.signal,
  })
  if (resp.statusCode === 503) throw new Error('Node busy')
  if (resp.statusCode < 200 || resp.statusCode >= 300) {
    let detail = ''
    try { detail = await resp.body.text() } catch { /* ignore */ }
    const err = Object.assign(
      new Error(`HTTP ${resp.statusCode}${detail ? ': ' + detail : ''}`),
      { statusCode: resp.statusCode },
    ) as RouterError
    throw err
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
  } = opts

  const resolvedCandidate = Array.isArray(candidate) ? candidate[0] : candidate
  const { nodeHost, modelName } = resolvedCandidate || {}

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

  const startTime = Date.now()
  const abortController = new AbortController()
  const onClientClose = () => abortController.abort()
  res.once('close', onClientClose)

  try {
    requestHistoryManager.recordAttempt(requestId, {
      nodeHost,
      modelName,
      status: 'waiting',
    })

    const resp = await request(`${nodeHost}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...reqBody, model: modelName }),
      headersTimeout: INFERENCE_TIMEOUT,
      bodyTimeout: INFERENCE_TIMEOUT,
      signal: abortController.signal,
    })

    if (resp.statusCode === 503) throw new Error('Node busy')
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      let detail = ''
      try { detail = await resp.body.text() } catch { /* ignore */ }
      throw new Error(
        `HTTP ${resp.statusCode}${detail ? ': ' + detail : ''}`,
      )
    }

    if (forwardContentType) {
      const upstreamContentType = resp.headers['content-type']
      if (upstreamContentType)
        res.setHeader('Content-Type', upstreamContentType as string)
    } else {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Connection', 'keep-alive')
    }
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('X-Accel-Buffering', 'no')
    await pipeline(resp.body, res)

    const latency = Date.now() - startTime
    discoveryManager.updateModelMetrics(nodeHost, modelName, latency, 0, endpoint)
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
    logger.info(
      { requestId, nodeHost, modelName, endpoint, latency },
      'Streaming request successful',
    )
  } catch (err) {
    const typedErr = err as RouterError
    const clientDisconnected =
      isAbortError(typedErr) ||
      typedErr?.code === 'ERR_STREAM_DESTROYED' ||
      res.destroyed
    const latency = Date.now() - startTime

    if (clientDisconnected) {
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
        nodeHost,
        modelName,
      })
    } else {
      const responseStatus = res.headersSent ? res.statusCode : 503
      logger.error(
        { requestId, nodeHost, modelName, endpoint, err: typedErr.message },
        'Streaming request failed',
      )
      discoveryManager.recordModelFailure(nodeHost, modelName, typedErr as NodeJS.ErrnoException)
      requestHistoryManager.recordAttempt(requestId, {
        nodeHost,
        modelName,
        status: 'failed',
        latency,
        error: typedErr.message,
      })
      requestHistoryManager.finishRequest(requestId, {
        status: 'failed',
        responseStatus,
        latency,
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
    }
  } finally {
    res.off('close', onClientClose)
    loadManager.decrementLoad(nodeHost)
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

export async function tryCandidatesWithRetry(
  opts: TryCandidatesOptions,
): Promise<boolean> {
  const {
    requestId,
    candidates,
    reqBody,
    endpoint,
    tokensFromResult,
    responseContentFrom,
    successLog,
    failureLog,
    res,
    discoveryManager,
    loadManager,
    requestHistoryManager,
    signal,
  } = opts

  for (const candidate of candidates) {
    if (signal?.aborted) throw createAbortError()
    const { nodeHost, modelName } = candidate

    try {
      loadManager.incrementLoad(nodeHost)
    } catch {
      requestHistoryManager.recordAttempt(requestId, {
        nodeHost,
        modelName,
        status: 'capacity',
      })
      logger.debug({ requestId, nodeHost }, 'Node capacity exceeded, trying next')
      continue
    }

    const startTime = Date.now()

    try {
      requestHistoryManager.recordAttempt(requestId, {
        nodeHost,
        modelName,
        status: 'waiting',
      })
      const result = await forwardRequest(
        nodeHost,
        modelName,
        { ...reqBody, model: modelName },
        endpoint,
        { signal },
      )
      const latency = Date.now() - startTime
      if (responseContentFrom) {
        requestHistoryManager.updateResponseContent(
          requestId,
          responseContentFrom(result),
        )
      }
      const tokensGenerated = tokensFromResult(result)
      discoveryManager.updateModelMetrics(
        nodeHost,
        modelName,
        latency,
        tokensGenerated,
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
        tokensGenerated,
      })
      logger.info(
        { requestId, nodeHost, modelName, latency },
        successLog ?? `${endpoint} successful`,
      )
      res.json(result)
      return true
    } catch (err) {
      const typedErr = err as RouterError
      logger.warn(
        { requestId, nodeHost, modelName, err: typedErr.message },
        failureLog ?? `${endpoint} failed, trying next`,
      )
      discoveryManager.recordModelFailure(nodeHost, modelName, typedErr as NodeJS.ErrnoException)
      requestHistoryManager.recordAttempt(requestId, {
        nodeHost,
        modelName,
        status: 'failed',
        latency: Date.now() - startTime,
        error: typedErr.message,
      })
    } finally {
      loadManager.decrementLoad(nodeHost)
    }
  }
  return false
}
