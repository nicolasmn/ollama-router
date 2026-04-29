// request-helpers.js - Shared request handling utilities
import { request } from 'undici'
import pino from 'pino'
import { pipeline } from 'node:stream/promises'
import { INFERENCE_TIMEOUT } from '../config.js'

const logger = pino()

export function makeRequestId() {
  return Math.random().toString(36).slice(2, 11)
}

export function handleSelectionError(
  err,
  res,
  requestId,
  contextMessage,
  routeLogger,
) {
  if (err?.statusCode === 404 || err?.code === 'MODEL_NOT_FOUND') {
    routeLogger.warn({ requestId, error: err.message }, contextMessage)
    res.status(404).json({ error: err.message })
    return true
  }
  return false
}

function hasNoCandidates(candidates) {
  return !candidates || (Array.isArray(candidates) && candidates.length === 0)
}

function respondNoCandidates(requestId, taskType, res, routeLogger) {
  routeLogger.warn({ requestId, taskType }, 'No suitable models available')
  res.status(503).json({ error: 'No suitable models available' })
}

export async function selectCandidatesOrHandleError({
  requestId,
  reqBody,
  taskType,
  res,
  selectFn,
  selectionErrorMessage,
  logger: routeLogger,
}) {
  try {
    const candidates = await selectFn(reqBody)
    if (hasNoCandidates(candidates)) {
      respondNoCandidates(requestId, taskType, res, routeLogger)
      return null
    }

    return candidates
  } catch (err) {
    const handled = handleSelectionError(
      err,
      res,
      requestId,
      selectionErrorMessage,
      routeLogger,
    )
    if (handled) return null
    throw err
  }
}

export function createAbortError() {
  const err = new Error('Request aborted')
  err.name = 'AbortError'
  return err
}

export function isAbortError(err) {
  return (
    err?.name === 'AbortError' ||
    err?.code === 'ABORT_ERR' ||
    err?.code === 'ERR_ABORTED' ||
    err?.code === 'ECONNRESET' ||
    err?.code === 'ECONNABORTED'
  )
}

/**
 * Forward a non-streaming request to an upstream node and return the parsed JSON body.
 * @param {string} baseUrl
 * @param {string} modelName
 * @param {Object} reqBody
 * @param {string} endpoint
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function forwardRequest(
  baseUrl,
  modelName,
  reqBody,
  endpoint,
  options = {},
) {
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
    try {
      detail = await resp.body.text()
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP ${resp.statusCode}${detail ? ': ' + detail : ''}`)
  }

  return resp.body.json()
}

/**
 * Stream a single upstream request to the client.
 * Handles load tracking, abort, disconnect detection, and history recording.
 *
 * @param {Object} opts
 * @param {string} opts.requestId
 * @param {Object} opts.reqBody
 * @param {{ nodeHost: string, modelName: string }} opts.candidate
 * @param {string} opts.endpoint
 * @param {boolean} [opts.forwardContentType=false]
 *   When true, copies the upstream Content-Type instead of forcing SSE headers.
 * @param {boolean} [opts.sseTerminator=false]
 *   When true, writes `data: [DONE]\n\n` before closing on error after headers.
 */
export async function handleStreamingRequest({
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
}) {
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
    requestHistoryManager.recordAttempt(requestId, {
      nodeHost,
      modelName,
      status: 'capacity',
    })
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
      try {
        detail = await resp.body.text()
      } catch {
        /* ignore */
      }
      throw new Error(`HTTP ${resp.statusCode}${detail ? ': ' + detail : ''}`)
    }

    if (forwardContentType) {
      const upstreamContentType = resp.headers['content-type']
      if (upstreamContentType)
        res.setHeader('Content-Type', upstreamContentType)
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
    const clientDisconnected =
      isAbortError(err) || err?.code === 'ERR_STREAM_DESTROYED' || res.destroyed
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
        { requestId, nodeHost, modelName, endpoint, error: err.message },
        'Streaming request failed',
      )
      discoveryManager.recordModelFailure(nodeHost, modelName, err)
      requestHistoryManager.recordAttempt(requestId, {
        nodeHost,
        modelName,
        status: 'failed',
        latency,
        error: err.message,
      })
      requestHistoryManager.finishRequest(requestId, {
        status: 'failed',
        responseStatus,
        latency,
        nodeHost,
        modelName,
        error: err.message,
      })
      if (!res.headersSent) {
        res.status(503).json({ error: err.message })
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

/**
 * Try each candidate in order until one succeeds. Returns true on success, false if all fail.
 *
 * @param {Object} opts
 * @param {string} opts.requestId
 * @param {Array}  opts.candidates
 * @param {Object} opts.reqBody
 * @param {string} opts.endpoint
 * @param {(result: Object) => number} opts.tokensFromResult
 * @param {(result: Object) => string|undefined} [opts.responseContentFrom]
 * @param {string} [opts.successLog]
 * @param {string} [opts.failureLog]
 * @param {AbortSignal} [opts.signal]
 */
export async function tryCandidatesWithRetry({
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
}) {
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
      logger.debug(
        { requestId, nodeHost },
        'Node capacity exceeded, trying next',
      )
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
        successLog ?? `${endpoint} request successful`,
      )
      res.json(result)
      return true
    } catch (err) {
      logger.warn(
        { requestId, nodeHost, modelName, error: err.message },
        failureLog ?? `${endpoint} model failed, trying next`,
      )
      discoveryManager.recordModelFailure(nodeHost, modelName, err)
      requestHistoryManager.recordAttempt(requestId, {
        nodeHost,
        modelName,
        status: 'failed',
        latency: Date.now() - startTime,
        error: err.message,
      })
    } finally {
      loadManager.decrementLoad(nodeHost)
    }
  }

  return false
}
