// ollama-inference.ts - Ollama native /api/chat and /api/generate routing
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

const logger = createLogger('ollama-inference')

export interface OllamaInferenceRouterDeps {
  discoveryManager: DiscoveryManager
  loadManager: LoadManager
  requestRouter: RequestRouter
  requestHistoryManager: RequestHistoryManager
}

export function createOllamaInferenceRouter({
  discoveryManager,
  loadManager,
  requestRouter,
  requestHistoryManager,
}: OllamaInferenceRouterDeps): Router {
  const r = express.Router()

  r.post('/api/chat', async (req, res) => {
    const requestId = makeRequestId()
    const reqBody = req.body as Record<string, unknown>
    const isStreaming = reqBody?.stream !== false
    const openAiBody = {
      ...reqBody,
      stream: isStreaming,
    }
    const analysis = requestRouter.analyzeRequest(openAiBody, 'chat')

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
      selectionErrorMessage: 'Ollama chat model selection error',
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
        endpoint: '/api/chat',
        forwardContentType: true,
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
        endpoint: '/api/chat',
        tokensFromResult: (r) =>
          (r as Record<string, { eval_count?: number }>).eval_count ?? 0,
        responseContentFrom: (r) => {
          const result = r as Record<string, unknown>
          return (result?.message as Record<string, unknown>)?.content
        },
        successLog: 'Ollama chat successful',
        failureLog: 'Ollama chat failed, trying next',
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
        if (!res.headersSent)
          res.status(503).json({ error: 'All upstream nodes failed' })
      }
    }
  })

  r.post('/api/generate', async (req, res) => {
    const requestId = makeRequestId()
    const reqBody = req.body as Record<string, unknown>
    const isStreaming = reqBody?.stream !== false
    const analysis = requestRouter.analyzeRequest(reqBody, 'completions')

    requestHistoryManager.startRequest({
      requestId,
      endpointType: 'completions',
      reqBody,
      analysis,
    })

    const candidates = await selectCandidatesOrHandleError({
      requestId,
      reqBody,
      taskType: 'generate',
      res,
      selectFn: (body) => requestRouter.selectForChat(body),
      selectionErrorMessage: 'Ollama generate model selection error',
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
        endpoint: '/api/generate',
        forwardContentType: true,
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
        endpoint: '/api/generate',
        tokensFromResult: (r) =>
          (r as Record<string, { eval_count?: number }>).eval_count ?? 0,
        successLog: 'Ollama generate successful',
        failureLog: 'Ollama generate failed, trying next',
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
        if (!res.headersSent)
          res.status(503).json({ error: 'All upstream nodes failed' })
      }
    }
  })

  return r
}
