// ollama.ts - Ollama-native discovery and metadata endpoints
// /api/tags and /api/show: required by Letta's OllamaProvider for model discovery.
// /api/ps: aggregates running models from all reachable nodes.
// /api/version: proxied from the first reachable node.
import { request } from 'undici'
import pino from 'pino'
import type { Application } from 'express'
import { VIRTUAL_MODELS } from '../request-router.js'
import type { DiscoveryManager } from '../discovery-manager.js'
import type { ModelInfo } from '../models.js'

const logger = pino()

function aggregateModels(
  discoveryManager: DiscoveryManager,
): Map<string, { modelInfo: ModelInfo; nodeHost: string }> {
  const deduped = new Map<string, { modelInfo: ModelInfo; nodeHost: string }>()
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

export function setupOllamaRoutes(
  app: Application,
  discoveryManager: DiscoveryManager,
): void {
  app.get('/api/tags', (_req, res) => {
    const models: unknown[] = []
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

  app.post('/api/show', (req, res) => {
    const { name } = (req.body ?? {}) as { name?: string }
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required' })
    }

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

    const modelInfo: Record<string, unknown> = {}
    if (profile.architecture) {
      modelInfo['general.architecture'] = profile.architecture
      if (profile.embeddingDim > 0) {
        modelInfo[`${profile.architecture}.embedding_length`] = profile.embeddingDim
      }
      if (profile.contextLength > 0) {
        modelInfo[`${profile.architecture}.context_length`] = profile.contextLength
      }
    }
    if (profile.parameters > 0) {
      modelInfo['general.parameter_count'] = Math.round(profile.parameters * 1e9)
    }

    logger.debug({ name, capabilities }, 'POST /api/show')
    return res.json({ capabilities, model_info: modelInfo })
  })

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
        const data = (await resp.body.json()) as { models?: unknown[] }
        return data.models ?? []
      }),
    )

    const modelsMap = new Map<string, Record<string, unknown>>()
    for (const result of results) {
      if (result.status !== 'fulfilled') continue
      for (const model of result.value as Array<Record<string, unknown>>) {
        const existing = modelsMap.get(model.name as string)
        if (!existing || (model.expires_at as string) > (existing.expires_at as string)) {
          modelsMap.set(model.name as string, model)
        }
      }
    }

    logger.debug({ count: modelsMap.size }, 'GET /api/ps')
    res.json({ models: [...modelsMap.values()] })
  })

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
    return res.json({ version: '0.0.0' })
  })
}
