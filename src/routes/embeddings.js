// embeddings.js - Embeddings endpoint handler
import pino from 'pino'
import {
  makeRequestId,
  handleSelectionError,
  selectCandidatesOrHandleError,
  tryCandidatesWithRetry,
  isAbortError,
} from './request-helpers.js'

const logger = pino()


export function setupEmbeddingsRoutes(
  app,
  discoveryManager,
  loadManager,
  requestRouter,
  requestHistoryManager,
) {
  /**
   * POST /v1/embeddings - OpenAI-compatible embeddings endpoint
   */
  app.post('/v1/embeddings', async (req, res) => {
    const requestId = makeRequestId()
    logger.info({ requestId }, 'Incoming embeddings request')
    const abortController = new AbortController()
    const onClientClose = () => abortController.abort()
    res.once('close', onClientClose)
    const analysis = requestRouter.analyzeRequest(req.body, 'embeddings')
    requestHistoryManager.startRequest({
      requestId,
      endpointType: 'embeddings',
      reqBody: req.body,
      analysis,
    })

    try {
      const candidates = await selectCandidatesOrHandleError({
        requestId,
        reqBody: req.body,
        taskType: 'embeddings',
        res,
        selectFn: (reqBody) => requestRouter.selectForEmbeddings(reqBody),
        selectionErrorMessage: 'Embeddings request model selection failed',
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
        logger.error({ requestId }, 'All embedding models failed')
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
          'Embeddings request model selection failed',
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
        responseStatus: 500,
        error: err.message,
      })
      logger.error(
        { requestId, error: err.message },
        'Embeddings request error',
      )
      res.status(500).json({ error: 'Internal server error' })
    } finally {
      res.off('close', onClientClose)
    }
  })
}
