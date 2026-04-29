// ollama-inference.js - Ollama-native inference endpoints
// POST /api/generate and POST /api/chat use the same routing logic as
// /v1/chat/completions, but forward to Ollama's native API format.
// Streaming detection differs: Ollama defaults stream=true (OpenAI defaults false).
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

function setupOllamaInferenceEndpoint(
  app,
  endpoint,
  endpointType,
  discoveryManager,
  loadManager,
  requestRouter,
  requestHistoryManager,
) {
  app.post(endpoint, async (req, res) => {
    const requestId = makeRequestId()
    logger.info({ requestId, endpoint }, 'Incoming Ollama native request')
    const abortController = new AbortController()
    const onClientClose = () => abortController.abort()
    res.once('close', onClientClose)

    // Ollama defaults stream to true; only treat as non-streaming if explicitly false
    const isStreaming = req.body?.stream !== false
    const analysis = requestRouter.analyzeRequest(req.body, 'chat')
    requestHistoryManager.startRequest({
      requestId,
      endpointType,
      reqBody: req.body,
      analysis,
    })

    try {
      const candidates = await selectCandidatesOrHandleError({
        requestId,
        reqBody: req.body,
        taskType: 'chat',
        res,
        selectFn: (reqBody) => requestRouter.selectForChat(reqBody),
        selectionErrorMessage: `${endpoint} request model selection failed`,
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
          endpoint,
          forwardContentType: true,
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
        endpoint,
        tokensFromResult: (result) => result.eval_count ?? 0,
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
        logger.error({ requestId, endpoint }, 'All Ollama models failed')
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
          `${endpoint} request model selection failed`,
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
      logger.error(
        { requestId, endpoint, error: err.message },
        'Ollama request error',
      )
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' })
      }
    } finally {
      res.off('close', onClientClose)
    }
  })
}

export function setupOllamaInferenceRoutes(
  app,
  discoveryManager,
  loadManager,
  requestRouter,
  requestHistoryManager,
) {
  setupOllamaInferenceEndpoint(
    app,
    '/api/generate',
    'completions',
    discoveryManager,
    loadManager,
    requestRouter,
    requestHistoryManager,
  )
  setupOllamaInferenceEndpoint(
    app,
    '/api/chat',
    'chat',
    discoveryManager,
    loadManager,
    requestRouter,
    requestHistoryManager,
  )
}
