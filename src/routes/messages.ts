// messages.ts - POST /v1/messages (Anthropic Messages API compat)
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

const logger = createLogger('messages')

export function setupMessagesRoutes(
  app: Application,
  discoveryManager: DiscoveryManager,
  loadManager: LoadManager,
  requestRouter: RequestRouter,
  requestHistoryManager: RequestHistoryManager,
): void {
  app.post('/v1/messages', async (req, res) => {
    const abortController = new AbortController()
    const onClientClose = () => abortController.abort()
    res.once('close', onClientClose)
    let requestId = ''

    try {
    requestId = makeRequestId()
    const reqBody = req.body as Record<string, unknown>

    if (!reqBody.max_tokens) {
      res.status(400).json({ error: 'max_tokens is required', type: 'invalid_request_error', param: 'max_tokens' })
      return
    }

    const isStreaming = Boolean(reqBody?.stream)
    const analysis = requestRouter.analyzeRequest(reqBody, 'chat')

    requestHistoryManager.startRequest({ requestId, endpointType: 'chat', reqBody, analysis })
    requestHistoryManager.registerAbortController(requestId, abortController)

    const candidates = await selectCandidatesOrHandleError({
      requestId, reqBody, taskType: 'messages', res, requestHistoryManager,
      selectFn: (body) => requestRouter.selectForChat(body, abortController.signal),
      selectionErrorMessage: 'Messages model selection error', logger,
    })
    if (!candidates) return

    requestHistoryManager.recordSelection(requestId, candidates)

    if (isStreaming) {
      await handleStreamingRequest({
        requestId, reqBody, candidate: candidates[0], endpoint: '/v1/messages',
        forwardContentType: true, sseTerminator: false, res, discoveryManager, loadManager, requestHistoryManager,
        signal: abortController.signal,
      })
    } else {
      const succeeded = await tryCandidatesWithRetry({
        requestId, candidates, reqBody, endpoint: '/v1/messages',
        tokensFromResult: (r) => ((r as Record<string, Record<string, number>>).usage?.output_tokens) ?? 0,
        successLog: 'Messages request successful', failureLog: 'Messages failed, trying next',
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
