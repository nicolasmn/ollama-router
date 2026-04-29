// ollama.js - Ollama-native discovery and metadata endpoints
// /api/tags and /api/show: required by Letta's OllamaProvider for model discovery.
// /api/ps: aggregates running models from all reachable nodes.
// /api/version: proxied from the first reachable node.
import { request } from 'undici'
import pino from 'pino'
import { VIRTUAL_MODELS } from '../request-router.js'

const logger = pino()

/**
 * Aggregate all models from reachable nodes into a deduplicated map.
 * Returns Map<modelName, { modelInfo, nodeHost }> — newest lastSeen wins.
 * @param {DiscoveryManager} discoveryManager
 * @returns {Map<string, {modelInfo: import('../models.js').ModelInfo, nodeHost: string}>}
 */
function aggregateModels(discoveryManager) {
  const deduped = new Map()
  for (const [nodeHost, node] of discoveryManager.getNodes()) {
    if (!node.reachable) continue
    for (const [name, modelInfo] of node.models) {
      const existing = deduped.get(name)
      if (!existing || modelInfo.lastSeen > existing.modelInfo.lastSeen) {
        deduped.set(name, { modelInfo, nodeHost })
      }
    }
  }
  return deduped
}

/**
 * Register Ollama-compatible discovery routes.
 * @param {import('express').Application} app
 * @param {import('../discovery-manager.js').DiscoveryManager} discoveryManager
 */
export function setupOllamaRoutes(app, discoveryManager) {
  /**
   * GET /api/tags
   * Letta's OllamaProvider calls this to list all available models.
   * Returns the Ollama /api/tags response shape.
   */
  app.get('/api/tags', (_req, res) => {
    const models = []
    const now = new Date().toISOString()

    for (const [name, { modelInfo }] of aggregateModels(discoveryManager)) {
      const modifiedAt = modelInfo.lastSeen
        ? new Date(modelInfo.lastSeen).toISOString()
        : now

      models.push({
        name,
        model: name,
        modified_at: modifiedAt,
        size: modelInfo.size ?? 0,
        digest: '',
        details: {
          family: modelInfo.family ?? '',
          families: modelInfo.family ? [modelInfo.family] : [],
          parameter_size: modelInfo.profile?.parameters
            ? `${modelInfo.profile.parameters.toFixed(1)}B`
            : '',
          quantization_level: '',
          format: 'gguf',
        },
      })
    }

    // Virtual models: auto-routing aliases that select the best real model at request time.
    // Exposed with tools capability so Letta includes them in the LLM model list.
    for (const name of VIRTUAL_MODELS) {
      models.push({
        name,
        model: name,
        modified_at: now,
        size: 0,
        digest: '',
        details: {
          family: 'virtual',
          families: ['virtual'],
          parameter_size: '',
          quantization_level: '',
          format: 'virtual',
        },
      })
    }

    logger.debug({ count: models.length }, 'GET /api/tags')
    res.json({ models })
  })

  /**
   * POST /api/show
   * Letta's OllamaProvider calls this for each model to get capabilities
   * and model_info (specifically embedding_length for embedding models).
   * Body: { name: string }
   */
  app.post('/api/show', (req, res) => {
    const { name } = req.body ?? {}
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' })
    }

    // Virtual models have no real profile — report tools capability only
    if (VIRTUAL_MODELS.has(name)) {
      logger.debug({ name }, 'POST /api/show (virtual)')
      return res.json({ capabilities: ['tools'], model_info: {} })
    }

    const allModels = aggregateModels(discoveryManager)
    const entry = allModels.get(name)
    if (!entry) {
      return res.status(404).json({ error: `model '${name}' not found` })
    }

    const { profile } = entry.modelInfo
    const capabilities = [...profile.capabilities]

    const modelInfo = {}
    if (profile.architecture) {
      modelInfo['general.architecture'] = profile.architecture
      if (profile.embeddingDim > 0) {
        modelInfo[`${profile.architecture}.embedding_length`] =
          profile.embeddingDim
      }
      if (profile.contextLength > 0) {
        modelInfo[`${profile.architecture}.context_length`] =
          profile.contextLength
      }
    }
    if (profile.parameters > 0) {
      modelInfo['general.parameter_count'] = Math.round(
        profile.parameters * 1e9,
      )
    }

    logger.debug({ name, capabilities }, 'POST /api/show')
    return res.json({ capabilities, model_info: modelInfo })
  })

  /**
   * GET /api/ps
   * Returns models currently loaded (running) across all reachable nodes.
   * Aggregates /api/ps from each node; deduplicates by name, newest expires_at wins.
   */
  app.get('/api/ps', async (_req, res) => {
    const reachableNodes = [...discoveryManager.getNodes().entries()]
      .filter(([, node]) => node.reachable)
      .map(([nodeHost]) => nodeHost)

    const results = await Promise.allSettled(
      reachableNodes.map(async (nodeHost) => {
        const resp = await request(`${nodeHost}/api/ps`, {
          headersTimeout: 5000,
          bodyTimeout: 5000,
        })
        if (resp.statusCode !== 200) return []
        const data = await resp.body.json()
        return data.models ?? []
      }),
    )

    const modelsMap = new Map()
    for (const result of results) {
      if (result.status !== 'fulfilled') continue
      for (const model of result.value) {
        const existing = modelsMap.get(model.name)
        if (!existing || model.expires_at > existing.expires_at) {
          modelsMap.set(model.name, model)
        }
      }
    }

    logger.debug({ count: modelsMap.size }, 'GET /api/ps')
    res.json({ models: [...modelsMap.values()] })
  })

  /**
   * GET /api/version
   * Proxied from the first reachable node. Falls back to a stub if no node responds.
   */
  app.get('/api/version', async (_req, res) => {
    for (const [nodeHost, node] of discoveryManager.getNodes()) {
      if (!node.reachable) continue
      try {
        const resp = await request(`${nodeHost}/api/version`, {
          headersTimeout: 3000,
          bodyTimeout: 3000,
        })
        if (resp.statusCode === 200) {
          const data = await resp.body.json()
          return res.json(data)
        }
      } catch {
        /* try next node */
      }
    }
    logger.debug('GET /api/version — no reachable node, returning stub')
    res.json({ version: '0.0.0' })
  })
}
