// messages.js - Anthropic Messages API pass-through handler
// Ollama natively implements POST /v1/messages — we route to the right node
// and forward the request body with the resolved model name.
import pino from 'pino'
import {
  makeRequestId,
  handleSelectionError,
  selectCandidatesOrHandleError,
  handleStreamingRequest,
  tryCandidatesWithRetry,
  isAbortError,
} from './request-helpers.js'

const logger = pino()

export function setupMessagesRoutes(
  app,
  discoveryManager,
  loadManager,
  requestRouter,
  requestHistoryManager,
) {
  app.post('/v1/messages', async (req, res) => {
    const requestId = makeRequestId()
    logger.info({ requestId }, 'Incoming messages request')
    const abortController = new AbortController()
    const onClientClose = () => abortController.abort()
    res.once('close', onClientClose)

    const isStreaming = req.body?.stream === true
    const analysis = requestRouter.analyzeRequest(req.body, 'chat')
    requestHistoryManager.startRequest({
      requestId,
      endpointType: 'chat',
      reqBody: req.body,
      analysis,
    })

    try {
      if (
        !req.body?.model ||
        !req.body?.messages ||
        req.body?.max_tokens == null
      ) {
        requestHistoryManager.finishRequest(requestId, {
          status: 'rejected',
          responseStatus: 400,
          error: 'model, messages, and max_tokens are required',
        })
        return res
          .status(400)
          .json({ error: 'model, messages, and max_tokens are required' })
      }

      const candidates = await selectCandidatesOrHandleError({
        requestId,
        reqBody: req.body,
        taskType: 'chat',
        res,
        selectFn: (reqBody) => requestRouter.selectForChat(reqBody),
        selectionErrorMessage: 'Messages request model selection failed',
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

      if (isStreaming) {
        await handleStreamingRequest({
          requestId,
          reqBody: req.body,
          candidate: candidates,
          endpoint: '/v1/messages',
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
        endpoint: '/v1/messages',
        tokensFromResult: (result) => result.usage?.output_tokens ?? 0,
        responseContentFrom: (result) => result?.content?.[0]?.text,
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
        logger.error({ requestId }, 'All messages models failed')
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
          'Messages request model selection failed',
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
      logger.error({ requestId, error: err.message }, 'Messages request error')
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' })
      }
    } finally {
      res.off('close', onClientClose)
    }
  })
}
