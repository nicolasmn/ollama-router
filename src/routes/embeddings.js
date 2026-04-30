// embeddings.js - /v1/embeddings endpoint handler
import {
  makeRequestId,
  handleSelectionError,
  selectCandidatesOrHandleError,
  tryCandidatesWithRetry,
  isAbortError,
} from './request-helpers.js'
import { createLogger } from '../logger.js'

const logger = createLogger('embeddings')

export function setupEmbeddingsRoutes(
  app,
  discoveryManager,
  loadManager,
  requestRouter,
  requestHistoryManager,
) {
  app.post('/v1/embeddings', async (req, res) => {
    const requestId = makeRequestId()
    logger.info({ requestId }, 'Incoming embeddings request')
    const abortController = new AbortController()
    const onClientClose = () => abortController.abort()
    res.once('close', onClientClose)

    requestHistoryManager.startRequest({
      requestId,
      endpointType: 'embeddings',
      reqBody: req.body,
      analysis: { needsEmbedding: true },
    })

    try {
      const candidates = await selectCandidatesOrHandleError({
        requestId,
        reqBody: req.body,
        taskType: 'embeddings',
        res,
        selectFn: (reqBody) => requestRouter.selectForEmbeddings(reqBody),
        selectionErrorMessage: 'Embeddings model selection failed',
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

      const success = await tryCandidatesWithRetry({
        requestId,
        candidates,
        reqBody: req.body,
        endpoint: '/v1/embeddings',
        tokensFromResult: (result) => result.usage?.prompt_tokens ?? 0,
        successLog: 'Embeddings request successful',
        failureLog: 'Embeddings model failed, trying next',
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
        logger.error({ requestId }, 'All embedding models failed')
        res.status(503).json({ error: 'All models failed' })
      }
    } catch (err) {
      if (isAbortError(err) || abortController.signal.aborted) {
        requestHistoryManager.finishRequest(requestId, { status: 'aborted', responseStatus: 0, error: 'Request aborted' })
        return
      }
      if (handleSelectionError(err, res, requestId, 'Embeddings model selection failed', logger)) {
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
      logger.error({ requestId, err: err.message }, 'Embeddings request error')
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' })
    } finally {
      res.off('close', onClientClose)
    }
  })
}
