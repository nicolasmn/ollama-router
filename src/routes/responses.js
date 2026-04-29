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
        responseContentFrom: (result) => result.output_text ?? '',
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
