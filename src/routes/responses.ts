// responses.ts - POST /v1/responses (OpenAI Responses API)
import { createLogger } from '../logger.js'
import type { Application } from 'express'
import type { DiscoveryManager } from '../discovery-manager.js'
import type { LoadManager } from '../load-manager.js'
import type { RequestRouter } from '../request-router.js'
import type { RequestHistoryManager } from '../request-history.js'
import {
  makeRequestId,
  selectCandidatesOrHandleError,
  handleStreamingRequest,
  tryCandidatesWithRetry,
} from './request-helpers.js'
import type { RoutingCandidate } from '../request-router.js'

const logger = createLogger('responses')

export function setupResponsesRoutes(
  app: Application,
  discoveryManager: DiscoveryManager,
  loadManager: LoadManager,
  requestRouter: RequestRouter,
  requestHistoryManager: RequestHistoryManager,
): void {
  app.post('/v1/responses', async (req, res) => {
    const abortController = new AbortController()
    const onClientClose = () => abortController.abort()
    res.once('close', onClientClose)
    let requestId = ''

    try {
    requestId = makeRequestId()
    const reqBody = req.body as Record<string, unknown>

    if (reqBody.previous_response_id) {
      res.status(400).json({
        error: 'previous_response_id is not supported by this router. Start a new stateless request.',
        param: 'previous_response_id',
      })
      return
    }

    const isStreaming = Boolean(reqBody?.stream)
    const analysis = requestRouter.analyzeRequest(reqBody, 'responses')

    requestHistoryManager.startRequest({ requestId, endpointType: 'responses', reqBody, analysis })
    requestHistoryManager.registerAbortController(requestId, abortController)

    const candidates = await selectCandidatesOrHandleError({
      requestId, reqBody, taskType: 'responses', res, requestHistoryManager,
      selectFn: (body) => requestRouter.selectForResponses(body, abortController.signal),
      selectionErrorMessage: 'Responses model selection error', logger,
    })
    if (!candidates) return

    requestHistoryManager.recordSelection(requestId, Array.isArray(candidates) ? candidates : [candidates])

    if (isStreaming) {
      await handleStreamingRequest({
        requestId, reqBody, candidate: candidates, endpoint: '/v1/responses',
        sseTerminator: true, res, discoveryManager, loadManager, requestHistoryManager,
        signal: abortController.signal,
      })
    } else {
      const candidateList: RoutingCandidate[] = Array.isArray(candidates) ? candidates : [candidates]
      const succeeded = await tryCandidatesWithRetry({
        requestId, candidates: candidateList, reqBody, endpoint: '/v1/responses',
        tokensFromResult: (r) => ((r as Record<string, Record<string, number>>).usage?.output_tokens) ?? 0,
        successLog: 'Responses request successful', failureLog: 'Responses failed, trying next',
        res, discoveryManager, loadManager, requestHistoryManager,
        signal: abortController.signal,
      })
      if (!succeeded) {
        if (!res.headersSent) res.status(503).json({ error: 'All upstream nodes failed' })
      }
    }
    } finally {
      res.off('close', onClientClose)
      requestHistoryManager.unregisterAbortController(requestId)
    }
  })
}
