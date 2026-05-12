// ollama-inference.ts - Native Ollama /api/generate and /api/chat handlers
import {
  makeRequestId,
  handleSelectionError,
  selectCandidatesOrHandleError,
  handleStreamingRequest,
  tryCandidatesWithRetry,
  isAbortError,
} from './request-helpers.js'
import type { RouterError } from './request-helpers.js'
import { createLogger } from '../logger.js'
import type { Application } from 'express'
import type { DiscoveryManager } from '../discovery-manager.js'
import type { LoadManager } from '../load-manager.js'
import type { RequestRouter } from '../request-router.js'
import type { RequestHistoryManager } from '../request-history.js'

const logger = createLogger('ollama')

export function setupOllamaInferenceRoutes(
  app: Application,
  discoveryManager: DiscoveryManager,
  loadManager: LoadManager,
  requestRouter: RequestRouter,
  requestHistoryManager: RequestHistoryManager,
): void {
  app.post('/api/generate', async (req, res) => {
    const requestId = makeRequestId()
    logger.info(
      { requestId, endpoint: '/api/generate' },
      'Incoming Ollama native request',
    )
    const abortController = new AbortController()
    const onClientClose = () => abortController.abort()
    res.once('close', onClientClose)

    const isStreaming = (req.body as Record<string, unknown>)?.stream !== false
    requestHistoryManager.startRequest({
      requestId,
      endpointType: 'generate',
      reqBody: req.body as Record<string, unknown>,
      analysis: {},
    })
    requestHistoryManager.registerAbortController(requestId, abortController)

    try {
      const candidates = await selectCandidatesOrHandleError({
        requestId,
        reqBody: req.body as Record<string, unknown>,
        taskType: 'generate',
        res,
        selectFn: (reqBody) => requestRouter.selectForChat(reqBody),
        selectionErrorMessage: '/api/generate model selection failed',
        logger,
      })
      if (!candidates) {
        requestHistoryManager.finishRequest(requestId, {
          status: res.statusCode === 404 ? 'rejected' : 'failed',
          responseStatus: res.statusCode || 503,
          error:
            res.statusCode === 404
              ? 'Requested model not found'
              : 'No suitable models available',
        })
        return
      }

      requestHistoryManager.recordSelection(
        requestId,
        Array.isArray(candidates) ? candidates : [candidates],
      )

      if (isStreaming) {
        await handleStreamingRequest({
          requestId,
          reqBody: req.body as Record<string, unknown>,
          candidate: candidates,
          endpoint: '/api/generate',
          forwardContentType: true,
          res,
          discoveryManager,
          loadManager,
          requestHistoryManager,
        })
        return
      }

      const success = await tryCandidatesWithRetry({
        requestId,
        candidates: Array.isArray(candidates) ? candidates : [candidates],
        reqBody: req.body as Record<string, unknown>,
        endpoint: '/api/generate',
        tokensFromResult: (result) =>
          ((result as Record<string, unknown>).eval_count as number) ?? 0,
        successLog: '/api/generate request successful',
        failureLog: '/api/generate model failed, trying next',
        res,
        discoveryManager,
        loadManager,
        requestHistoryManager,
        signal: abortController.signal,
      })

      if (!success) {
        if (abortController.signal.aborted) {
          requestHistoryManager.finishRequest(requestId, {
            status: 'aborted',
            responseStatus: 0,
            error: 'Request aborted',
          })
          return
        }
        requestHistoryManager.finishRequest(requestId, {
          status: 'failed',
          responseStatus: 503,
          error: 'All models failed',
        })
        logger.error({ requestId }, 'All /api/generate models failed')
        res.status(503).json({ error: 'All models failed' })
      }
    } catch (err) {
      const typedErr = err as RouterError
      if (isAbortError(typedErr) || abortController.signal.aborted) {
        requestHistoryManager.finishRequest(requestId, {
          status: 'aborted',
          responseStatus: 0,
          error: 'Request aborted',
        })
        return
      }
      if (
        handleSelectionError(
          typedErr,
          res,
          requestId,
          '/api/generate model selection failed',
          logger,
        )
      ) {
        requestHistoryManager.finishRequest(requestId, {
          status: 'rejected',
          responseStatus: res.statusCode || 404,
          error: typedErr.message,
        })
        return
      }
      requestHistoryManager.finishRequest(requestId, {
        status: 'failed',
        responseStatus: res.headersSent ? res.statusCode : 500,
        error: typedErr.message,
      })
      logger.error(
        { requestId, err: typedErr.message },
        '/api/generate request error',
      )
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' })
    } finally {
      res.off('close', onClientClose)
      requestHistoryManager.unregisterAbortController(requestId)
    }
  })

  app.post('/api/chat', async (req, res) => {
    const requestId = makeRequestId()
    logger.info(
      { requestId, endpoint: '/api/chat' },
      'Incoming Ollama native request',
    )
    const abortController = new AbortController()
    const onClientClose = () => abortController.abort()
    res.once('close', onClientClose)

    const isStreaming = (req.body as Record<string, unknown>)?.stream !== false
    requestHistoryManager.startRequest({
      requestId,
      endpointType: 'chat',
      reqBody: req.body as Record<string, unknown>,
      analysis: {},
    })
    requestHistoryManager.registerAbortController(requestId, abortController)

    try {
      const candidates = await selectCandidatesOrHandleError({
        requestId,
        reqBody: req.body as Record<string, unknown>,
        taskType: 'chat',
        res,
        selectFn: (reqBody) => requestRouter.selectForChat(reqBody),
        selectionErrorMessage: '/api/chat model selection failed',
        logger,
      })
      if (!candidates) {
        requestHistoryManager.finishRequest(requestId, {
          status: res.statusCode === 404 ? 'rejected' : 'failed',
          responseStatus: res.statusCode || 503,
          error:
            res.statusCode === 404
              ? 'Requested model not found'
              : 'No suitable models available',
        })
        return
      }

      requestHistoryManager.recordSelection(
        requestId,
        Array.isArray(candidates) ? candidates : [candidates],
      )

      if (isStreaming) {
        await handleStreamingRequest({
          requestId,
          reqBody: req.body as Record<string, unknown>,
          candidate: candidates,
          endpoint: '/api/chat',
          forwardContentType: true,
          res,
          discoveryManager,
          loadManager,
          requestHistoryManager,
        })
        return
      }

      const success = await tryCandidatesWithRetry({
        requestId,
        candidates: Array.isArray(candidates) ? candidates : [candidates],
        reqBody: req.body as Record<string, unknown>,
        endpoint: '/api/chat',
        tokensFromResult: (result) =>
          ((result as Record<string, unknown>).eval_count as number) ?? 0,
        successLog: '/api/chat request successful',
        failureLog: '/api/chat model failed, trying next',
        res,
        discoveryManager,
        loadManager,
        requestHistoryManager,
        signal: abortController.signal,
      })

      if (!success) {
        if (abortController.signal.aborted) {
          requestHistoryManager.finishRequest(requestId, {
            status: 'aborted',
            responseStatus: 0,
            error: 'Request aborted',
          })
          return
        }
        requestHistoryManager.finishRequest(requestId, {
          status: 'failed',
          responseStatus: 503,
          error: 'All models failed',
        })
        logger.error({ requestId }, 'All /api/chat models failed')
        res.status(503).json({ error: 'All models failed' })
      }
    } catch (err) {
      const typedErr = err as RouterError
      if (isAbortError(typedErr) || abortController.signal.aborted) {
        requestHistoryManager.finishRequest(requestId, {
          status: 'aborted',
          responseStatus: 0,
          error: 'Request aborted',
        })
        return
      }
      if (
        handleSelectionError(
          typedErr,
          res,
          requestId,
          '/api/chat model selection failed',
          logger,
        )
      ) {
        requestHistoryManager.finishRequest(requestId, {
          status: 'rejected',
          responseStatus: res.statusCode || 404,
          error: typedErr.message,
        })
        return
      }
      requestHistoryManager.finishRequest(requestId, {
        status: 'failed',
        responseStatus: res.headersSent ? res.statusCode : 500,
        error: typedErr.message,
      })
      logger.error(
        { requestId, err: typedErr.message },
        '/api/chat request error',
      )
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' })
    } finally {
      res.off('close', onClientClose)
      requestHistoryManager.unregisterAbortController(requestId)
    }
  })
}
