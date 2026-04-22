// routes.js - Express route handlers
import { request } from 'undici'
import pino from 'pino'
import { pipeline } from 'node:stream/promises'

const logger = pino()

function makeRequestId() {
  return Math.random().toString(36).slice(2, 11)
}

function handleSelectionError(err, res, requestId, contextMessage, logger) {
  if (err?.statusCode === 404 || err?.code === 'MODEL_NOT_FOUND') {
    logger.warn({ requestId, error: err.message }, contextMessage)
    res.status(404).json({ error: err.message })
    return true
  }
  return false
}

function hasNoCandidates(candidates) {
  return !candidates || (Array.isArray(candidates) && candidates.length === 0)
}

function respondNoCandidates(requestId, taskType, res, logger) {
  logger.warn({ requestId, taskType }, 'No suitable models available')
  res.status(503).json({ error: 'No suitable models available' })
}

function selectCandidatesOrHandleError({
  requestId,
  reqBody,
  taskType,
  res,
  selectFn,
  selectionErrorMessage,
  logger,
}) {
  try {
    const candidates = selectFn(reqBody)
    if (hasNoCandidates(candidates)) {
      respondNoCandidates(requestId, taskType, res, logger)
      return null
    }

    return candidates
  } catch (err) {
    const handled = handleSelectionError(
      err,
      res,
      requestId,
      selectionErrorMessage,
      logger,
    )
    if (handled) return null
    throw err
  }
}

/**
 * Forward a request to Ollama
 */
async function forwardRequest(baseUrl, modelName, reqBody, endpoint) {
  const resp = await request(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...reqBody, model: modelName }),
    timeout: 30000,
  })

  if (resp.statusCode === 503) throw new Error('Node busy')
  if (!resp.ok) throw new Error(`HTTP ${resp.statusCode}`)

  return resp.json()
}

/**
 * Create and attach route handlers to the Express app
 * @param {Express.Application} app - Express application
 * @param {DiscoveryManager} discoveryManager - discovery manager instance
 * @param {LoadManager} loadManager - load manager instance
 * @param {RequestRouter} requestRouter - request router instance
 */
export function createRoutes(
  app,
  discoveryManager,
  loadManager,
  requestRouter,
) {
  async function handleStreamingChatRequest({ requestId, reqBody, candidate, res }) {
    const { nodeHost, modelName } = candidate

    try {
      loadManager.incrementLoad(nodeHost)
    } catch {
      logger.warn({ requestId, nodeHost }, 'Node capacity exceeded')
      res.status(429).json({ error: 'Node at capacity' })
      return
    }

    const startTime = Date.now()
    try {
      const resp = await request(`${nodeHost}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...reqBody, model: modelName }),
        timeout: 30000,
      })

      if (resp.statusCode === 503) throw new Error('Node busy')
      if (!resp.ok) throw new Error(`HTTP ${resp.statusCode}`)

      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      await pipeline(resp.body, res)

      const latency = Date.now() - startTime
      requestRouter.updateModelMetrics(nodeHost, modelName, latency, 0)
      logger.info(
        { requestId, nodeHost, modelName, latency },
        'Streaming request successful',
      )
    } catch (err) {
      logger.error(
        { requestId, nodeHost, modelName, error: err.message },
        'Streaming request failed',
      )
      requestRouter.recordModelFailure(nodeHost, modelName)
      if (!res.headersSent) {
        res.status(503).json({ error: err.message })
      }
    } finally {
      loadManager.decrementLoad(nodeHost)
    }
  }

  async function tryCandidatesWithRetry({
    requestId,
    candidates,
    reqBody,
    endpoint,
    tokensFromResult,
    successLog,
    failureLog,
    res,
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
        const result = await forwardRequest(
          nodeHost,
          modelName,
          reqBody,
          endpoint,
        )
        const latency = Date.now() - startTime
        const tokensGenerated = tokensFromResult(result)
        requestRouter.updateModelMetrics(
          nodeHost,
          modelName,
          latency,
          tokensGenerated,
        )
        logger.info({ requestId, nodeHost, modelName, latency }, successLog)
        res.json(result)
        return true
      } catch (err) {
        logger.warn(
          { requestId, nodeHost, modelName, error: err.message },
          failureLog,
        )
        requestRouter.recordModelFailure(nodeHost, modelName)
      } finally {
        loadManager.decrementLoad(nodeHost)
      }
    }

    return false
  }

  /**
   * POST /v1/chat/completions - Chat completion endpoint
   */
  app.post('/v1/chat/completions', async (req, res) => {
    const requestId = makeRequestId()
    logger.info({ requestId }, 'Incoming chat completion request')

    const isStreaming = Boolean(req.body?.stream)

    try {
      const taskType = 'chat'
      const candidates = selectCandidatesOrHandleError({
        requestId,
        reqBody: req.body,
        taskType,
        res,
        selectFn: (reqBody) => requestRouter.selectForChat(reqBody),
        selectionErrorMessage: 'Chat request model selection failed',
        logger,
      })
      if (!candidates) {
        return
      }

      // Streaming keeps a single upstream stream and cannot seamlessly fail over.
      if (isStreaming) {
        await handleStreamingChatRequest({
          requestId,
          reqBody: req.body,
          candidate: candidates,
          res,
        })
        return
      }

      const success = await tryCandidatesWithRetry({
        requestId,
        candidates,
        reqBody: req.body,
        endpoint: '/api/chat',
        tokensFromResult: (result) => result.usage?.completion_tokens || 0,
        successLog: 'Chat request successful',
        failureLog: 'Chat model failed, trying next',
        res,
      })

      if (!success) {
        logger.error({ requestId }, 'All chat models failed')
        res.status(503).json({ error: 'All models failed' })
      }
    } catch (err) {
      if (
        handleSelectionError(
          err,
          res,
          requestId,
          'Chat request model selection failed',
          logger,
        )
      ) {
        return
      }

      logger.error({ requestId, error: err.message }, 'Chat request error')
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  /**
   * POST /v1/embeddings - Embeddings endpoint
   */
  app.post('/v1/embeddings', async (req, res) => {
    const requestId = makeRequestId()
    logger.info({ requestId }, 'Incoming embeddings request')

    try {
      const candidates = selectCandidatesOrHandleError({
        requestId,
        reqBody: req.body,
        taskType: 'general',
        res,
        selectFn: (reqBody) => requestRouter.selectForEmbeddings(reqBody),
        selectionErrorMessage: 'Embeddings request model selection failed',
        logger,
      })
      if (!candidates) {
        return
      }

      const success = await tryCandidatesWithRetry({
        requestId,
        candidates,
        reqBody: req.body,
        endpoint: '/api/embeddings',
        tokensFromResult: () => 0,
        successLog: 'Embeddings request successful',
        failureLog: 'Embeddings model failed, trying next',
        res,
      })

      if (!success) {
        logger.error({ requestId }, 'All embeddings models failed')
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

  /**
   * POST /v1/completions - Text completions endpoint
   */
  app.post('/v1/completions', async (req, res) => {
    const requestId = makeRequestId()
    logger.info({ requestId }, 'Incoming completions request')

    try {
      const candidates = selectCandidatesOrHandleError({
        requestId,
        reqBody: req.body,
        taskType: 'completions',
        res,
        selectFn: (reqBody) => requestRouter.selectForCompletions(reqBody),
        selectionErrorMessage: 'Completions request model selection failed',
        logger,
      })
      if (!candidates) {
        return
      }

      const success = await tryCandidatesWithRetry({
        requestId,
        candidates,
        reqBody: req.body,
        endpoint: '/api/generate',
        tokensFromResult: (result) => result.eval_count || 0,
        successLog: 'Completions request successful',
        failureLog: 'Completions model failed, trying next',
        res,
      })

      if (!success) {
        logger.error({ requestId }, 'All completions models failed')
        res.status(503).json({ error: 'All models failed' })
      }
    } catch (err) {
      if (
        handleSelectionError(
          err,
          res,
          requestId,
          'Completions request model selection failed',
          logger,
        )
      ) {
        return
      }

      logger.error(
        { requestId, error: err.message },
        'Completions request error',
      )
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  /**
   * GET /v1/models - OpenAI-style model listing
   */
  app.get('/v1/models', (req, res) => {
    const models = requestRouter.getModelCatalog()

    res.json({
      object: 'list',
      data: models,
    })
  })

  /**
   * GET /v1/models/:model - OpenAI-style model details
   */
  app.get('/v1/models/:model', (req, res) => {
    const model = requestRouter.getModelById(req.params.model)
    if (!model) {
      return res.status(404).json({ error: `Model ${req.params.model} not found` })
    }

    return res.json({
      ...model,
      permission: [],
    })
  })

  /**
   * GET /health - Health check endpoint
   */
  app.get('/health', (req, res) => {
    const reachableCount = discoveryManager.getReachableNodeCount()
    const totalNodes = discoveryManager.getNodes().size
    const activeRequests = loadManager.getTotalActiveRequests()

    res.json({
      status: 'healthy',
      nodes_reachable: reachableCount,
      total_nodes: totalNodes,
      active_requests: activeRequests,
    })
  })

  /**
   * GET /inventory - Detailed inventory of nodes and models
   */
  app.get('/inventory', (req, res) => {
    const inventory = discoveryManager.getNodes()

    res.json({
      timestamp: Date.now(),
      nodes: Object.fromEntries(
        Array.from(inventory.entries()).map(([nodeHost, node]) => [
          nodeHost,
          {
            host: node.host,
            reachable: node.reachable,
            lastSeen: node.lastSeen,
            activeRequests: loadManager.getCurrentLoad(nodeHost),
            models: Object.fromEntries(
              Array.from(node.models.entries()).map(
                ([modelName, modelInfo]) => [
                  modelName,
                  {
                    name: modelInfo.name,
                    family: modelInfo.family,
                    size: modelInfo.size,
                    profile: modelInfo.profile,
                    status: modelInfo.status,
                    recentLatency: modelInfo.recentLatency,
                    recentTps: modelInfo.recentTps,
                    failures: modelInfo.failures,
                    lastSeen: modelInfo.lastSeen,
                    lastRoutingEndpoint: modelInfo.lastRoutingEndpoint,
                    lastRoutedAt: modelInfo.lastRoutedAt,
                  },
                ],
              ),
            ),
          },
        ]),
      ),
    })
  })

  /**
   * GET /dashboard - HTML dashboard
   */
  app.get('/dashboard', (req, res) => {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ollama Router Dashboard</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
    .node { border: 1px solid #ccc; margin: 10px 0; padding: 10px; background: white; }
    .node.reachable { border-left: 5px solid green; }
    .node.unreachable { border-left: 5px solid red; }
    .model { margin-left: 20px; margin-top: 10px; padding: 5px; background: #fafafa; border-left: 2px solid #ddd; }
    .status { font-weight: bold; }
    .healthy { color: green; }
    .unhealthy { color: red; }
    .stats { font-size: 0.9em; color: #666; }
  </style>
</head>
<body>
  <h1>Ollama Router Dashboard</h1>
  <div id="content">Loading...</div>
  <script>
    async function updateDashboard() {
      try {
        const response = await fetch('/inventory');
        const data = await response.json();
        const content = document.getElementById('content');
        let html = '';
        for (const [host, node] of Object.entries(data.nodes)) {
          const statusClass = node.reachable ? 'reachable' : 'unreachable';
          const statusText = node.reachable ? '✓ Reachable' : '✗ Unreachable';
          html += '<div class="node ' + statusClass + '">';
          html += '<h2>' + host + ' <span class="status ' + (node.reachable ? 'healthy' : 'unhealthy') + '">(' + statusText + ')</span></h2>';
          html += '<p>Active Requests: ' + node.activeRequests + '</p>';
          html += '<p class="stats">Last Seen: ' + new Date(node.lastSeen).toLocaleString() + '</p>';
          html += '<h3>Models (' + Object.keys(node.models).length + ')</h3>';
          for (const [name, model] of Object.entries(node.models)) {
            const profile = model.profile || {};
            const capabilities = [];
            if (profile.supportsVision) capabilities.push('vision');
            if (profile.supportsAudio) capabilities.push('audio');
            if (profile.supportsTools) capabilities.push('tools');
            if (profile.supportsThinking) capabilities.push('thinking');
            if (profile.isEmbedding) capabilities.push('embedding');
            const capStr = capabilities.length > 0 ? capabilities.join(', ') : 'text-only';

            html += '<div class="model">';
            html += '<strong>' + name + '</strong> (' + model.family + ', ' + (model.size / 1e9).toFixed(1) + 'GB)<br>';
            html += 'Capabilities: ' + capStr + ' | Context: ' + (profile.contextLength || 4096) + ' tokens<br>';
            html += '<span class="stats">Latency: ' + Math.round(model.recentLatency) + 'ms | TPS: ' + model.recentTps.toFixed(1) + ' | Failures: ' + model.failures + '</span><br>';
            html += '<span class="stats">Last Route: ' + (model.lastRoutingEndpoint || '-') + '</span>';
            html += '</div>';
          }
          html += '</div>';
        }
        content.innerHTML = html;
      } catch (error) {
        document.getElementById('content').innerHTML = '<p style="color: red;">Error loading dashboard: ' + error.message + '</p>';
      }
    }
    updateDashboard();
    setInterval(updateDashboard, 5000);
  </script>
</body>
</html>
    `
    res.setHeader('Content-Type', 'text/html')
    res.send(html)
  })
}
