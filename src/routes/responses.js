import { request } from 'undici'
import pino from 'pino'
import { pipeline } from 'node:stream/promises'
import {
  makeRequestId,
  handleSelectionError,
  selectCandidatesOrHandleError,
  forwardRequest,
  createAbortError,
  isAbortError,
} from './request-helpers.js'
import { INFERENCE_TIMEOUT } from '../config.js'

const logger = pino()

async function handleStreamingResponsesRequest({
  requestId,
  reqBody,
  candidate,
  res,
  discoveryManager,
  loadManager,
  requestHistoryManager,
}) {
  const { nodeHost, modelName } = candidate

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
    const upstreamBody = { ...reqBody, model: modelName }
    const resp = await request(`${nodeHost}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(upstreamBody),
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

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')

    await pipeline(resp.body, res)

    const latency = Date.now() - startTime
    discoveryManager.updateModelMetrics(nodeHost, modelName, latency, 0)
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
  } catch (err) {
    const latency = Date.now() - startTime
    if (isAbortError(err) || res.destroyed) {
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
        responseStatus: res.headersSent ? res.statusCode : 503,
        latency,
        nodeHost,
        modelName,
        error: err.message,
      })
      if (!res.headersSent) {
        res.status(503).json({ error: err.message })
      } else if (!res.writableEnded) {
        res.write('data: [DONE]\n\n')
        res.end()
      }
    }
  } finally {
    res.off('close', onClientClose)
    loadManager.decrementLoad(nodeHost)
  }
}

async function tryCandidatesWithRetry({
  requestId,
  candidates,
  reqBody,
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
      continue
    }

    const startTime = Date.now()

    try {
      requestHistoryManager.recordAttempt(requestId, {
        nodeHost,
        modelName,
        status: 'waiting',
      })
      const upstreamBody = { ...reqBody, model: modelName }
      const result = await forwardRequest(
        nodeHost,
        modelName,
        upstreamBody,
        '/v1/responses',
        { signal },
      )
      const transformed = result
      const latency = Date.now() - startTime
      discoveryManager.updateModelMetrics(
        nodeHost,
        modelName,
        latency,
        transformed.usage?.output_tokens ?? 0,
      )
      requestHistoryManager.updateResponseContent(
        requestId,
        transformed.output_text ?? '',
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
        tokensGenerated: transformed.usage?.output_tokens ?? 0,
      })
      res.json(transformed)
      return true
    } catch (err) {
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

export function setupResponsesRoutes(
  app,
  discoveryManager,
  loadManager,
  requestRouter,
  requestHistoryManager,
) {
  app.post('/v1/responses', async (req, res) => {
    const requestId = makeRequestId()
    const abortController = new AbortController()
    const onClientClose = () => abortController.abort()
    res.once('close', onClientClose)

    if (req.body?.previous_response_id) {
      res.status(400).json({
        error:
          'previous_response_id is not supported by this non-stateful proxy',
        param: 'previous_response_id',
      })
      return
    }

    if (req.body?.conversation) {
      res.status(400).json({
        error: 'conversation is not supported by this non-stateful proxy',
        param: 'conversation',
      })
      return
    }

    const analysis = requestRouter.analyzeRequest(req.body, 'responses')
    requestHistoryManager.startRequest({
      requestId,
      endpointType: 'responses',
      reqBody: req.body,
      analysis,
    })

    try {
      const candidates = await selectCandidatesOrHandleError({
        requestId,
        reqBody: req.body,
        taskType: 'responses',
        res,
        selectFn: (reqBody) => requestRouter.selectForResponses(reqBody),
        selectionErrorMessage: 'Responses request model selection failed',
        logger,
      })
      if (!candidates) {
        requestHistoryManager.finishRequest(requestId, {
          status: res.statusCode === 404 ? 'rejected' : 'failed',
          responseStatus: res.statusCode || 503,
          error:
            res.statusCode === 404
              ? 'Requested model not found'
              : 'No suitable models available',
        })
        return
      }

      requestHistoryManager.recordSelection(requestId, candidates)

      if (req.body?.stream) {
        await handleStreamingResponsesRequest({
          requestId,
          reqBody: req.body,
          candidate: candidates,
          res,
          discoveryManager,
          loadManager,
          requestHistoryManager,
        })
        return
      }

      const success = await tryCandidatesWithRetry({
        requestId,
        candidates,
        reqBody: req.body,
        res,
        discoveryManager,
        loadManager,
        requestHistoryManager,
        signal: abortController.signal,
      })

      if (!success) {
        if (abortController.signal.aborted) {
          requestHistoryManager.finishRequest(requestId, {
            status: 'aborted',
            responseStatus: 0,
            error: 'Request aborted',
          })
          return
        }

        requestHistoryManager.finishRequest(requestId, {
          status: 'failed',
          responseStatus: 503,
          error: 'All models failed',
        })
        res.status(503).json({ error: 'All models failed' })
      }
    } catch (err) {
      if (isAbortError(err) || abortController.signal.aborted) {
        requestHistoryManager.finishRequest(requestId, {
          status: 'aborted',
          responseStatus: 0,
          error: 'Request aborted',
        })
        return
      }

      if (
        handleSelectionError(
          err,
          res,
          requestId,
          'Responses request model selection failed',
          logger,
        )
      ) {
        requestHistoryManager.finishRequest(requestId, {
          status: res.statusCode === 400 ? 'rejected' : 'failed',
          responseStatus: res.statusCode || 400,
          error: err.message,
        })
        return
      }

      requestHistoryManager.finishRequest(requestId, {
        status: 'failed',
        responseStatus: 500,
        error: err.message,
      })
      res.status(500).json({ error: 'Internal server error' })
    } finally {
      res.off('close', onClientClose)
    }
  })
}
