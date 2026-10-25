// responses.ts - POST /v1/responses (OpenAI Responses API)
import { createLogger } from '../logger.js'
import type { Application } from 'express'
import type { DiscoveryManager } from '../discovery-manager.js'
import type { LoadManager } from '../load-manager.js'
import type { RequestRouter } from '../request-router.js'
import type { RequestHistoryManager } from '../request-history.js'
import { readJsonBody } from '../read-body.js'
import {
  makeRequestId,
  selectCandidatesOrHandleError,
  handleStreamingRequest,
  tryCandidatesWithRetry,
} from './request-helpers.js'

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
    const { body: reqBody, raw } = await readJsonBody(req)

    if (reqBody.previous_response_id) {
      res.status(400).json({
        error: 'previous_response_id is not supported by this router. Start a new stateless request.',
        param: 'previous_response_id',
      })
      return
    }

    const isStreaming = Boolean(reqBody?.stream)

    // Cache checks: conversation first, then signal. On a hit we skip
    // re-analyzing the body and skip heavy history capture.
    const peeked = requestRouter.peekCachedRouting?.(reqBody) ?? requestRouter.peekSignalCache?.(reqBody)
    const analysis = peeked ? undefined : requestRouter.analyzeRequest(reqBody, 'responses')

    requestHistoryManager.startRequest({ requestId, endpointType: 'responses', reqBody, analysis: analysis ?? {}, skipCapture: !!peeked })
    requestHistoryManager.registerAbortController(requestId, abortController)

    let candidates = peeked
    if (!candidates) {
      const result = await selectCandidatesOrHandleError({
        requestId, reqBody, taskType: 'responses', res, requestHistoryManager,
        selectFn: (body) => requestRouter.selectForResponses(body, abortController.signal, undefined, analysis),
        selectionErrorMessage: 'Responses model selection error', logger,
      })
      candidates = result
    }
    if (!candidates) return

    requestHistoryManager.recordSelection(requestId, candidates)

    if (isStreaming) {
      await handleStreamingRequest({
        requestId, reqBody, candidate: candidates[0], endpoint: '/v1/responses',
        sseTerminator: true, res, discoveryManager, loadManager, requestHistoryManager,
        signal: abortController.signal, rawBody: raw,
      })
    } else {
      const succeeded = await tryCandidatesWithRetry({
        requestId, candidates, reqBody, endpoint: '/v1/responses',
        tokensFromResult: (r) => ((r as Record<string, Record<string, number>>).usage?.output_tokens) ?? 0,
        successLog: 'Responses request successful', failureLog: 'Responses failed, trying next',
        res, discoveryManager, loadManager, requestHistoryManager,
        signal: abortController.signal, rawBody: raw,
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
