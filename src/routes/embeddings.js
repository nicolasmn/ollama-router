// embeddings.js - Embeddings endpoint handler
import pino from 'pino'
import {
  translateEmbeddingRequest,
  translateEmbeddingResponse,
} from '../adapters/index.js'
import {
  makeRequestId,
  handleSelectionError,
  selectCandidatesOrHandleError,
  forwardRequest,
} from './request-helpers.js'

const logger = pino()

async function tryCandidatesWithRetry({
  requestId,
  candidates,
  reqBody,
  endpoint,
  tokensFromResult,
  successLog,
  failureLog,
  res,
  requestTransformer = null,
  responseTransformer = null,
  discoveryManager,
  loadManager,
}) {
  for (const candidate of candidates) {
    const { nodeHost, modelName } = candidate

    try {
      loadManager.incrementLoad(nodeHost)
    } catch {
      logger.debug(
        { requestId, nodeHost },
        'Node capacity exceeded, trying next',
      )
      continue
    }

    const startTime = Date.now()

    try {
      const ollamaBody = requestTransformer
        ? requestTransformer(reqBody, modelName)
        : { ...reqBody, model: modelName }
      const result = await forwardRequest(
        nodeHost,
        modelName,
        ollamaBody,
        endpoint,
      )
      const latency = Date.now() - startTime
      const transformed = responseTransformer
        ? responseTransformer(result, reqBody.model ?? modelName)
        : result
      const tokensGenerated = tokensFromResult(transformed)
      discoveryManager.updateModelMetrics(
        nodeHost,
        modelName,
        latency,
        tokensGenerated,
      )
      logger.info({ requestId, nodeHost, modelName, latency }, successLog)
      res.json(transformed)
      return true
    } catch (err) {
      logger.warn(
        { requestId, nodeHost, modelName, error: err.message },
        failureLog,
      )
      discoveryManager.recordModelFailure(nodeHost, modelName, err)
    } finally {
      loadManager.decrementLoad(nodeHost)
    }
  }

  return false
}

export function setupEmbeddingsRoutes(
  app,
  discoveryManager,
  loadManager,
  requestRouter,
) {
  /**
   * POST /v1/embeddings - OpenAI-compatible embeddings endpoint
   */
  app.post('/v1/embeddings', async (req, res) => {
    const requestId = makeRequestId()
    logger.info({ requestId }, 'Incoming embeddings request')

    try {
      const candidates = selectCandidatesOrHandleError({
        requestId,
        reqBody: req.body,
        taskType: 'embeddings',
        res,
        selectFn: (reqBody) => requestRouter.selectForEmbeddings(reqBody),
        selectionErrorMessage: 'Embeddings request model selection failed',
        logger,
      })
      if (!candidates) return

      const success = await tryCandidatesWithRetry({
        requestId,
        candidates,
        reqBody: req.body,
        endpoint: '/api/embed',
        tokensFromResult: (result) => result.usage?.prompt_tokens ?? 0,
        successLog: 'Embeddings request successful',
        failureLog: 'Embeddings model failed, trying next',
        res,
        requestTransformer: translateEmbeddingRequest,
        responseTransformer: translateEmbeddingResponse,
        discoveryManager,
        loadManager,
      })

      if (!success) {
        logger.error({ requestId }, 'All embedding models failed')
        res.status(503).json({ error: 'All models failed' })
      }
    } catch (err) {
      if (
        handleSelectionError(
          err,
          res,
          requestId,
          'Embeddings request model selection failed',
          logger,
        )
      ) {
        return
      }
      logger.error(
        { requestId, error: err.message },
        'Embeddings request error',
      )
      res.status(500).json({ error: 'Internal server error' })
    }
  })
}
