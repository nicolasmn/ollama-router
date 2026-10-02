// systemone.ts - POST /v1/systemone (Ollama Jev-style decision models)
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

const logger = createLogger('systemone')

export function setupSystemoneRoutes(
  app: Application,
  discoveryManager: DiscoveryManager,
  loadManager: LoadManager,
  requestRouter: RequestRouter,
  requestHistoryManager: RequestHistoryManager,
): void {
  app.post('/v1/systemone', async (req, res) => {
    const abortController = new AbortController()
    const onClientClose = () => abortController.abort()
    res.once('close', onClientClose)
    let requestId = ''

    try {
      requestId = makeRequestId()
      const reqBody = req.body as Record<string, unknown>

      // systemone is a decision-model endpoint with explicit model selection
      // Request format: { model, state, questions }
      // No streaming support per Ollama spec
      const analysis = requestRouter.analyzeRequest(reqBody, 'systemone')

      requestHistoryManager.startRequest({
        requestId,
        endpointType: 'systemone',
        reqBody,
        analysis,
      })
      requestHistoryManager.registerAbortController(requestId, abortController)

      const candidates = await selectCandidatesOrHandleError({
        requestId,
        reqBody,
        taskType: 'systemone',
        res,
        requestHistoryManager,
        selectFn: (body) => requestRouter.selectForChat(body, abortController.signal),
        selectionErrorMessage: 'Systemone model selection error',
        logger,
      })
      if (!candidates) return

      requestHistoryManager.recordSelection(requestId, candidates)

      // systemone is non-streaming per Ollama v0.35 spec
      const succeeded = await tryCandidatesWithRetry({
        requestId,
        candidates,
        reqBody,
        endpoint: '/v1/systemone',
        tokensFromResult: (r) => {
          // usage.output_tokens is the decision-model token count (1–64 answers)
          const usage = (r as Record<string, unknown>)?.usage as
            | Record<string, unknown>
            | undefined
          return typeof usage?.output_tokens === 'number'
            ? usage.output_tokens
            : 0
        },
        responseContentFrom: (r) => {
          // The Jev response is structured data — keep it as JSON so the
          // dashboard renders it in a proper code block, exactly what the
          // API client received. answers is the payload of interest.
          const result = r as Record<string, unknown>
          const answers = result?.answers
          if (!answers) return null
          return '```json\n' + JSON.stringify(answers, null, 2) + '\n```'
        },
        successLog: 'Systemone request successful',
        failureLog: 'Systemone failed, trying next',
        res,
        discoveryManager,
        loadManager,
        requestHistoryManager,
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