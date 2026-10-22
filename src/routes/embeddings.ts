// embeddings.ts - POST /v1/embeddings
import { createLogger } from '../logger.js'
import type { Application } from 'express'
import type { DiscoveryManager } from '../discovery-manager.js'
import type { LoadManager } from '../load-manager.js'
import type { RequestRouter } from '../request-router.js'
import type { RequestHistoryManager } from '../request-history.js'
import {
  makeRequestId,
  selectCandidatesOrHandleError,
  tryCandidatesWithRetry,
} from './request-helpers.js'

const logger = createLogger('embeddings')

export function setupEmbeddingsRoutes(
  app: Application,
  discoveryManager: DiscoveryManager,
  loadManager: LoadManager,
  requestRouter: RequestRouter,
  requestHistoryManager: RequestHistoryManager,
): void {
  app.post('/v1/embeddings', async (req, res) => {
    const abortController = new AbortController()
    const onClientClose = () => abortController.abort()
    res.once('close', onClientClose)
    let requestId = ''

    try {
    requestId = makeRequestId()
    const reqBody = req.body as Record<string, unknown>
    const analysis = requestRouter.analyzeRequest(reqBody, 'embeddings')

    requestHistoryManager.startRequest({ requestId, endpointType: 'embeddings', reqBody, analysis })
    requestHistoryManager.registerAbortController(requestId, abortController)

    const candidates = await selectCandidatesOrHandleError({
      requestId, reqBody, taskType: 'embeddings', res, requestHistoryManager,
      selectFn: (body) => requestRouter.selectForEmbeddings(body, abortController.signal),
      selectionErrorMessage: 'Embeddings model selection error', logger,
    })
    if (!candidates) return

    requestHistoryManager.recordSelection(requestId, candidates)

    const succeeded = await tryCandidatesWithRetry({
      requestId, candidates, reqBody, endpoint: '/v1/embeddings',
      tokensFromResult: (r) => ((r as Record<string, Record<string, number>>).usage?.prompt_tokens) ?? 0,
      successLog: 'Embeddings successful', failureLog: 'Embeddings failed, trying next',
      res, discoveryManager, loadManager, requestHistoryManager,
      signal: abortController.signal,
    })

    if (!succeeded) {
      if (!res.headersSent) res.status(503).json({ error: 'All upstream nodes failed' })
    }
    } finally {
      res.off('close', onClientClose)
      requestHistoryManager.unregisterAbortController(requestId)
    }
  })
}
