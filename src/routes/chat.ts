// chat.ts - POST /v1/chat/completions
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

const logger = createLogger('chat')

export interface ChatRouterDeps {
  discoveryManager: DiscoveryManager
  loadManager: LoadManager
  requestRouter: RequestRouter
  requestHistoryManager: RequestHistoryManager
}

export function createChatRouter({
  discoveryManager,
  loadManager,
  requestRouter,
  requestHistoryManager,
}: ChatRouterDeps): Router {
  const r = express.Router()

  r.post('/chat/completions', async (req, res) => {
    const requestId = makeRequestId()
    const reqBody = req.body as Record<string, unknown>
    const isStreaming = Boolean(reqBody?.stream)
    const analysis = requestRouter.analyzeRequest(reqBody, 'chat')

    requestHistoryManager.startRequest({
      requestId,
      endpointType: 'chat',
      reqBody,
      analysis,
    })

    const candidates = await selectCandidatesOrHandleError({
      requestId,
      reqBody,
      taskType: 'chat',
      res,
      selectFn: (body) => requestRouter.selectForChat(body),
      selectionErrorMessage: 'Chat model selection error',
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
        endpoint: '/v1/chat/completions',
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
        endpoint: '/v1/chat/completions',
        tokensFromResult: (r) =>
          (r as Record<string, unknown>)?.usage
            ? ((r as Record<string, { completion_tokens?: number }>).usage
                ?.completion_tokens ?? 0)
            : 0,
        responseContentFrom: (r) => {
          const result = r as Record<string, unknown>
          const choices = result?.choices as Array<Record<string, unknown>>
          return choices?.[0]?.message
        },
        successLog: 'Chat completion successful',
        failureLog: 'Chat completion failed, trying next',
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
