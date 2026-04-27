// chat.js - Chat completion endpoint handler
import { request } from 'undici'
import pino from 'pino'
import { pipeline } from 'node:stream/promises'
import {
  translateRequestBody,
  translateResponseBody,
  createSSETransform,
} from '../adapters/index.js'
import {
  makeRequestId,
  handleSelectionError,
  selectCandidatesOrHandleError,
  forwardRequest,
} from './request-helpers.js'
import { INFERENCE_TIMEOUT } from '../config.js'

const logger = pino()

async function handleStreamingChatRequest({
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

  const completionId = `chatcmpl-${makeRequestId()}`
  const created = Math.floor(Date.now() / 1000)
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
    const supportsThinking =
      discoveryManager.inventory.get(nodeHost)?.models.get(modelName)?.profile?.supportsThinking ?? false
    const ollamaBody = translateRequestBody(reqBody, modelName, supportsThinking)
    const resp = await request(`${nodeHost}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ollamaBody),
      headersTimeout: INFERENCE_TIMEOUT,
      bodyTimeout: INFERENCE_TIMEOUT,
      signal: abortController.signal,
    })

    if (resp.statusCode === 503) throw new Error('Node busy')
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      let detail = ''
      try { detail = await resp.body.text() } catch { /* ignore */ }
      throw new Error(`HTTP ${resp.statusCode}${detail ? ': ' + detail : ''}`)
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    await pipeline(
      resp.body,
      createSSETransform(completionId, reqBody.model ?? modelName, created),
      res,
    )

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
    logger.info(
      { requestId, nodeHost, modelName, latency },
      'Streaming request successful',
    )
  } catch (err) {
    const clientDisconnected =
      err.name === 'AbortError' ||
      err.code === 'ERR_STREAM_DESTROYED' ||
      err.code === 'ECONNRESET' ||
      err.code === 'ECONNABORTED' ||
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
        { requestId, nodeHost, modelName, error: err.message },
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
  endpoint,
  tokensFromResult,
  successLog,
  failureLog,
  res,
  requestTransformer = null,
  responseTransformer = null,
  discoveryManager,
  loadManager,
  requestHistoryManager,
}) {
  for (const candidate of candidates) {
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
      const supportsThinking =
        discoveryManager.inventory.get(nodeHost)?.models.get(modelName)?.profile?.supportsThinking ?? false
      const ollamaBody = requestTransformer
        ? requestTransformer(reqBody, modelName, supportsThinking)
        : { ...reqBody, model: modelName }
      const result = await forwardRequest(
        nodeHost,
        modelName,
        ollamaBody,
        endpoint,
      )
      const latency = Date.now() - startTime
      const transformed = responseTransformer
        ? responseTransformer(result, reqBody.model ?? modelName)
        : result
      const responseContent = transformed?.choices?.[0]?.message?.content
      requestHistoryManager.updateResponseContent(requestId, responseContent)
      const tokensGenerated = tokensFromResult(transformed)
      discoveryManager.updateModelMetrics(
        nodeHost,
        modelName,
        latency,
        tokensGenerated,
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
      logger.info({ requestId, nodeHost, modelName, latency }, successLog)
      res.json(transformed)
      return true
    } catch (err) {
      logger.warn(
        { requestId, nodeHost, modelName, error: err.message },
        failureLog,
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

export function setupChatRoutes(
  app,
  discoveryManager,
  loadManager,
  requestRouter,
  requestHistoryManager,
) {
  /**
   * POST /v1/chat/completions - Chat completion endpoint
   */
  app.post('/v1/chat/completions', async (req, res) => {
    const requestId = makeRequestId()
    logger.info({ requestId }, 'Incoming chat completion request')

    const isStreaming = Boolean(req.body?.stream)
    const analysis = requestRouter.analyzeRequest(req.body, 'chat')
    requestHistoryManager.startRequest({
      requestId,
      endpointType: 'chat',
      reqBody: req.body,
      analysis,
    })

    try {
      const taskType = 'chat'
      const candidates = await selectCandidatesOrHandleError({
        requestId,
        reqBody: req.body,
        taskType,
        res,
        selectFn: (reqBody) => requestRouter.selectForChat(reqBody),
        selectionErrorMessage: 'Chat request model selection failed',
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

      // Streaming keeps a single upstream stream and cannot seamlessly fail over.
      if (isStreaming) {
        await handleStreamingChatRequest({
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
        endpoint: '/api/chat',
        tokensFromResult: (result) => result.usage?.completion_tokens ?? 0,
        successLog: 'Chat request successful',
        failureLog: 'Chat model failed, trying next',
        res,
        requestTransformer: translateRequestBody,
        responseTransformer: translateResponseBody,
        discoveryManager,
        loadManager,
        requestHistoryManager,
      })

      if (!success) {
        requestHistoryManager.finishRequest(requestId, {
          status: 'failed',
          responseStatus: 503,
          error: 'All models failed',
        })
        logger.error({ requestId }, 'All chat models failed')
        res.status(503).json({ error: 'All models failed' })
      }
    } catch (err) {
      if (
        handleSelectionError(
          err,
          res,
          requestId,
          'Chat request model selection failed',
          logger,
        )
      ) {
        requestHistoryManager.finishRequest(requestId, {
          status: 'rejected',
          responseStatus: res.statusCode || 404,
          error: err.message,
        })
        return
      }

      requestHistoryManager.finishRequest(requestId, {
        status: 'failed',
        responseStatus: res.headersSent ? res.statusCode : 500,
        error: err.message,
      })
      logger.error({ requestId, error: err.message }, 'Chat request error')
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' })
      }
    }
  })
}
