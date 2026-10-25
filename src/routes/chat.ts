// chat.ts - POST /v1/chat/completions
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
import type { RoutingCandidate } from '../request-router.js'

const logger = createLogger('chat')

export function setupChatRoutes(
  app: Application,
  discoveryManager: DiscoveryManager,
  loadManager: LoadManager,
  requestRouter: RequestRouter,
  requestHistoryManager: RequestHistoryManager,
): void {
  app.post('/v1/chat/completions', async (req, res) => {
    const abortController = new AbortController()
    const onClientClose = () => abortController.abort()
    res.once('close', onClientClose)
    let requestId = ''

    try {
    requestId = makeRequestId()
    const { body: reqBody, raw } = await readJsonBody(req)
    const isStreaming = Boolean(reqBody?.stream)

    // Cache checks: conversation first, then signal. On a hit we skip
    // re-analyzing the body and skip heavy history capture.
    const peeked = requestRouter.peekCachedRouting?.(reqBody) ?? requestRouter.peekSignalCache?.(reqBody)
    const analysis = peeked ? undefined : requestRouter.analyzeRequest(reqBody, 'chat')

    requestHistoryManager.startRequest({ requestId, endpointType: 'chat', reqBody, analysis: analysis ?? {}, skipCapture: !!peeked })
    requestHistoryManager.registerAbortController(requestId, abortController)

    let candidates = peeked
    if (!candidates) {
      const result = await selectCandidatesOrHandleError({
        requestId, reqBody, taskType: 'chat', res, requestHistoryManager,
        selectFn: (body) => requestRouter.selectForChat(body, abortController.signal, undefined, analysis),
        selectionErrorMessage: 'Chat model selection error', logger,
      })
      candidates = result
    }
    if (!candidates) return

    // Always record the full ranked list so the dashboard shows all candidates
    requestHistoryManager.recordSelection(requestId, candidates)

    if (isStreaming) {
      await handleStreamingRequest({
        requestId, reqBody, candidate: candidates[0], endpoint: '/v1/chat/completions',
        sseTerminator: true, res, discoveryManager, loadManager, requestHistoryManager,
        signal: abortController.signal, rawBody: raw,
      })
    } else {
      const succeeded = await tryCandidatesWithRetry({
        requestId, candidates, reqBody, endpoint: '/v1/chat/completions',
        tokensFromResult: (r) => ((r as Record<string, Record<string, number>>).usage?.completion_tokens) ?? 0,
        responseContentFrom: (r) => (r as Record<string, unknown[]>)?.choices?.[0],
        successLog: 'Chat completion successful', failureLog: 'Chat failed, trying next',
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
