// ollama-inference.js - Native Ollama /api/generate and /api/chat endpoint handlers
import {
  makeRequestId,
  handleSelectionError,
  selectCandidatesOrHandleError,
  handleStreamingRequest,
  tryCandidatesWithRetry,
  isAbortError,
} from './request-helpers.js'
import { createLogger } from '../logger.js'

const logger = createLogger('ollama')

export function setupOllamaInferenceRoutes(
  app,
  discoveryManager,
  loadManager,
  requestRouter,
  requestHistoryManager,
) {
  // /api/generate
  app.post('/api/generate', async (req, res) => {
    const requestId = makeRequestId()
    logger.info({ requestId, endpoint: '/api/generate' }, 'Incoming Ollama native request')
    const abortController = new AbortController()
    const onClientClose = () => abortController.abort()
    res.once('close', onClientClose)

    const isStreaming = req.body?.stream !== false
    requestHistoryManager.startRequest({
      requestId,
      endpointType: 'generate',
      reqBody: req.body,
      analysis: {},
    })

    try {
      const candidates = await selectCandidatesOrHandleError({
        requestId,
        reqBody: req.body,
        taskType: 'generate',
        res,
        selectFn: (reqBody) => requestRouter.selectForChat(reqBody),
        selectionErrorMessage: '/api/generate model selection failed',
        logger,
      })
      if (!candidates) {
        requestHistoryManager.finishRequest(requestId, {
          status: res.statusCode === 404 ? 'rejected' : 'failed',
          responseStatus: res.statusCode || 503,
          error: res.statusCode === 404 ? 'Requested model not found' : 'No suitable models available',
        })
        return
      }

      requestHistoryManager.recordSelection(requestId, candidates)

      if (isStreaming) {
        await handleStreamingRequest({
          requestId,
          reqBody: req.body,
          candidate: candidates,
          endpoint: '/api/generate',
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
        endpoint: '/api/generate',
        tokensFromResult: (result) => result.eval_count ?? 0,
        successLog: '/api/generate request successful',
        failureLog: '/api/generate model failed, trying next',
        res,
        discoveryManager,
        loadManager,
        requestHistoryManager,
        signal: abortController.signal,
      })

      if (!success) {
        if (abortController.signal.aborted) {
          requestHistoryManager.finishRequest(requestId, { status: 'aborted', responseStatus: 0, error: 'Request aborted' })
          return
        }
        requestHistoryManager.finishRequest(requestId, { status: 'failed', responseStatus: 503, error: 'All models failed' })
        logger.error({ requestId }, 'All /api/generate models failed')
        res.status(503).json({ error: 'All models failed' })
      }
    } catch (err) {
      if (isAbortError(err) || abortController.signal.aborted) {
        requestHistoryManager.finishRequest(requestId, { status: 'aborted', responseStatus: 0, error: 'Request aborted' })
        return
      }
      if (handleSelectionError(err, res, requestId, '/api/generate model selection failed', logger)) {
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
      logger.error({ requestId, err: err.message }, '/api/generate request error')
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' })
    } finally {
      res.off('close', onClientClose)
    }
  })

  // /api/chat
  app.post('/api/chat', async (req, res) => {
    const requestId = makeRequestId()
    logger.info({ requestId, endpoint: '/api/chat' }, 'Incoming Ollama native request')
    const abortController = new AbortController()
    const onClientClose = () => abortController.abort()
    res.once('close', onClientClose)

    const isStreaming = req.body?.stream !== false
    requestHistoryManager.startRequest({
      requestId,
      endpointType: 'chat',
      reqBody: req.body,
      analysis: {},
    })

    try {
      const candidates = await selectCandidatesOrHandleError({
        requestId,
        reqBody: req.body,
        taskType: 'chat',
        res,
        selectFn: (reqBody) => requestRouter.selectForChat(reqBody),
        selectionErrorMessage: '/api/chat model selection failed',
        logger,
      })
      if (!candidates) {
        requestHistoryManager.finishRequest(requestId, {
          status: res.statusCode === 404 ? 'rejected' : 'failed',
          responseStatus: res.statusCode || 503,
          error: res.statusCode === 404 ? 'Requested model not found' : 'No suitable models available',
        })
        return
      }

      requestHistoryManager.recordSelection(requestId, candidates)

      if (isStreaming) {
        await handleStreamingRequest({
          requestId,
          reqBody: req.body,
          candidate: candidates,
          endpoint: '/api/chat',
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
        endpoint: '/api/chat',
        tokensFromResult: (result) => result.eval_count ?? 0,
        successLog: '/api/chat request successful',
        failureLog: '/api/chat model failed, trying next',
        res,
        discoveryManager,
        loadManager,
        requestHistoryManager,
        signal: abortController.signal,
      })

      if (!success) {
        if (abortController.signal.aborted) {
          requestHistoryManager.finishRequest(requestId, { status: 'aborted', responseStatus: 0, error: 'Request aborted' })
          return
        }
        requestHistoryManager.finishRequest(requestId, { status: 'failed', responseStatus: 503, error: 'All models failed' })
        logger.error({ requestId }, 'All /api/chat models failed')
        res.status(503).json({ error: 'All models failed' })
      }
    } catch (err) {
      if (isAbortError(err) || abortController.signal.aborted) {
        requestHistoryManager.finishRequest(requestId, { status: 'aborted', responseStatus: 0, error: 'Request aborted' })
        return
      }
      if (handleSelectionError(err, res, requestId, '/api/chat model selection failed', logger)) {
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
      logger.error({ requestId, err: err.message }, '/api/chat request error')
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' })
    } finally {
      res.off('close', onClientClose)
    }
  })
}
