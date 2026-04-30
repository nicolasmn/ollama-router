// responses.ts - POST /v1/responses (OpenAI Responses API)
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
  handleStreamingRequest,
  tryCandidatesWithRetry,
} from './request-helpers.js'
import type { RoutingCandidate } from '../request-router.js'

const logger = createLogger('responses')

export interface ResponsesRouterDeps {
  discoveryManager: DiscoveryManager
  loadManager: LoadManager
  requestRouter: RequestRouter
  requestHistoryManager: RequestHistoryManager
}

export function createResponsesRouter({
  discoveryManager,
  loadManager,
  requestRouter,
  requestHistoryManager,
}: ResponsesRouterDeps): Router {
  const r = express.Router()

  r.post('/responses', async (req, res) => {
    const requestId = makeRequestId()
    const reqBody = req.body as Record<string, unknown>
    const isStreaming = Boolean(reqBody?.stream)
    const analysis = requestRouter.analyzeRequest(reqBody, 'responses')

    requestHistoryManager.startRequest({
      requestId,
      endpointType: 'responses',
      reqBody,
      analysis,
    })

    const candidates = await selectCandidatesOrHandleError({
      requestId,
      reqBody,
      taskType: 'responses',
      res,
      selectFn: (body) => requestRouter.selectForResponses(body),
      selectionErrorMessage: 'Responses model selection error',
      logger,
    })
    if (!candidates) return

    requestHistoryManager.recordSelection(
      requestId,
      Array.isArray(candidates) ? candidates : [candidates],
    )

    if (isStreaming) {
      await handleStreamingRequest({
        requestId,
        reqBody,
        candidate: candidates,
        endpoint: '/v1/responses',
        sseTerminator: true,
        res,
        discoveryManager,
        loadManager,
        requestHistoryManager,
      })
    } else {
      const candidateList: RoutingCandidate[] = Array.isArray(candidates)
        ? candidates
        : [candidates]
      const succeeded = await tryCandidatesWithRetry({
        requestId,
        candidates: candidateList,
        reqBody,
        endpoint: '/v1/responses',
        tokensFromResult: (r) =>
          (r as Record<string, { output_tokens?: number }>).usage
            ?.output_tokens ?? 0,
        successLog: 'Responses request successful',
        failureLog: 'Responses request failed, trying next',
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
    }
  })

  return r
}
