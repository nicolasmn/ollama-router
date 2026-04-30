// embeddings.ts - POST /v1/embeddings
import express from 'express'
import type { Router } from 'express'
import { createLogger } from '../logger.js'
import type { DiscoveryManager } from '../discovery-manager.js'
import type { LoadManager } from '../load-manager.js'
import type { RequestRouter } from '../request-router.js'
import type { RequestHistoryManager } from '../request-history.js'
import {
  makeRequestId,
  selectCandidatesOrHandleError,
  tryCandidatesWithRetry,
} from './request-helpers.js'
import type { RoutingCandidate } from '../request-router.js'

const logger = createLogger('embeddings')

export interface EmbeddingsRouterDeps {
  discoveryManager: DiscoveryManager
  loadManager: LoadManager
  requestRouter: RequestRouter
  requestHistoryManager: RequestHistoryManager
}

export function createEmbeddingsRouter({
  discoveryManager,
  loadManager,
  requestRouter,
  requestHistoryManager,
}: EmbeddingsRouterDeps): Router {
  const r = express.Router()

  r.post('/embeddings', async (req, res) => {
    const requestId = makeRequestId()
    const reqBody = req.body as Record<string, unknown>
    const analysis = requestRouter.analyzeRequest(reqBody, 'embeddings')

    requestHistoryManager.startRequest({
      requestId,
      endpointType: 'embeddings',
      reqBody,
      analysis,
    })

    const candidates = await selectCandidatesOrHandleError({
      requestId,
      reqBody,
      taskType: 'embeddings',
      res,
      selectFn: (body) => requestRouter.selectForEmbeddings(body),
      selectionErrorMessage: 'Embeddings model selection error',
      logger,
    })
    if (!candidates) return

    requestHistoryManager.recordSelection(
      requestId,
      Array.isArray(candidates) ? candidates : [candidates],
    )

    const candidateList: RoutingCandidate[] = Array.isArray(candidates)
      ? candidates
      : [candidates]

    const succeeded = await tryCandidatesWithRetry({
      requestId,
      candidates: candidateList,
      reqBody,
      endpoint: '/v1/embeddings',
      tokensFromResult: (r) =>
        (r as Record<string, unknown>)?.usage
          ? ((r as Record<string, { prompt_tokens?: number }>).usage
              ?.prompt_tokens ?? 0)
          : 0,
      successLog: 'Embeddings successful',
      failureLog: 'Embeddings failed, trying next',
      res,
      discoveryManager,
      loadManager,
      requestHistoryManager,
    })

    if (!succeeded) {
      requestHistoryManager.finishRequest(requestId, {
        status: 'failed',
        responseStatus: 503,
        error: 'All candidates failed',
      })
      if (!res.headersSent) {
        res.status(503).json({ error: 'All upstream nodes failed' })
      }
    }
  })

  return r
}
