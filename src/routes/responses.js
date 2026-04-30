// responses.js - /v1/responses endpoint handler (OpenAI Responses API)
import {
  makeRequestId,
  handleSelectionError,
  selectCandidatesOrHandleError,
  handleStreamingRequest,
  tryCandidatesWithRetry,
  isAbortError,
} from './request-helpers.js'
import { createLogger } from '../logger.js'

const logger = createLogger('responses')

export function setupResponsesRoutes(
  app,
  discoveryManager,
  loadManager,
  requestRouter,
  requestHistoryManager,
) {
  app.post('/v1/responses', async (req, res) => {
    const requestId = makeRequestId()
    logger.info({ requestId }, 'Incoming /v1/responses request')
    const abortController = new AbortController()
    const onClientClose = () => abortController.abort()
    res.once('close', onClientClose)

    const isStreaming = Boolean(req.body?.stream)
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
        selectionErrorMessage: '/v1/responses model selection failed',
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
          endpoint: '/v1/responses',
          sseTerminator: true,
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
        endpoint: '/v1/responses',
        tokensFromResult: (result) => result.usage?.output_tokens ?? 0,
        responseContentFrom: (result) => result?.output?.[0]?.content?.[0]?.text,
        successLog: '/v1/responses request successful',
        failureLog: '/v1/responses model failed, trying next',
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
        logger.error({ requestId }, 'All /v1/responses models failed')
        res.status(503).json({ error: 'All models failed' })
      }
    } catch (err) {
      if (isAbortError(err) || abortController.signal.aborted) {
        requestHistoryManager.finishRequest(requestId, { status: 'aborted', responseStatus: 0, error: 'Request aborted' })
        return
      }
      if (handleSelectionError(err, res, requestId, '/v1/responses model selection failed', logger)) {
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
      logger.error({ requestId, err: err.message }, '/v1/responses request error')
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' })
    } finally {
      res.off('close', onClientClose)
    }
  })
}
