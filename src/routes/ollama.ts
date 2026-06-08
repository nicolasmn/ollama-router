// ollama.ts - Ollama-native discovery and metadata endpoints
// /api/tags, /api/show, /api/embed: required by Letta's OllamaProvider for model discovery/inference.
// /api/ps: aggregates running models from all reachable nodes.
// /api/version: proxied from the first reachable node.
// /api/pull, /api/delete, /api/copy, /api/create, /api/push: proxied to a single reachable node.
import { request } from 'undici'
import type { Dispatcher } from 'undici'
import { pipeline } from 'node:stream/promises'
import pino from 'pino'
import type { Application, Request, Response } from 'express'
import { VIRTUAL_MODELS } from '../request-router.js'
import { INFERENCE_TIMEOUT, ROUTER_FALLBACK_TO_AUTO } from '../config.js'
import type { DiscoveryManager } from '../discovery-manager.js'
import type { ModelInfo } from '../models.js'
import type { RequestRouter } from '../request-router.js'

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
  requestRouter?: RequestRouter,
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
      return res.json({
        modelfile: '',
        parameters: '',
        template: '',
        details: {
          parent_model: '',
          format: 'virtual',
          family: 'virtual',
          families: ['virtual'],
          parameter_size: '',
          quantization_level: '',
        },
        capabilities: ['completion', 'tools'],
        model_info: {},
      })
    }

    const allModels = aggregateModels(discoveryManager)
    const entry = allModels.get(name)
    if (!entry) {
      return res.status(404).json({ error: `model '${name}' not found` })
    }

    const { profile, family } = entry.modelInfo

    // Build capabilities: Ollama convention is "completion" for all non-embedding models
    const capSet = new Set(profile.capabilities)
    if (!profile.isEmbedding && !capSet.has('completion')) {
      capSet.add('completion')
    }
    const capabilities = [...capSet]

    const modelInfo: Record<string, unknown> = {}
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

    const parameterSize =
      profile.parameters > 0 ? `${profile.parameters.toFixed(1)}B` : ''

    logger.debug({ name, capabilities }, 'POST /api/show')
    return res.json({
      modelfile: '',
      parameters: '',
      template: '',
      details: {
        parent_model: '',
        format: 'gguf',
        family: family ?? '',
        families: family ? [family] : [],
        parameter_size: parameterSize,
        quantization_level: '',
      },
      capabilities,
      model_info: modelInfo,
    })
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
        if (
          !existing ||
          (model.expires_at as string) > (existing.expires_at as string)
        ) {
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

  // ── /api/embed (current embedding endpoint) ──────────────────────────────────
  app.post('/api/embed', async (req, res) => {
    const body = req.body as Record<string, unknown>
    const modelName = body.model as string | undefined
    if (!modelName) {
      return res.status(400).json({ error: 'model is required' })
    }

    const abortController = new AbortController()
    const onClientClose = () => abortController.abort()
    res.once('close', onClientClose)

    try {
      let nodeHost = findNodeForModel(discoveryManager, modelName)

      if (!nodeHost) {
        if (ROUTER_FALLBACK_TO_AUTO && requestRouter) {
          // Ask router for best embedding candidate
          const candidate = await requestRouter.selectForEmbeddings(
            body,
            abortController.signal,
          )
          if (candidate && !Array.isArray(candidate)) {
            nodeHost = candidate.nodeHost
            body.model = candidate.modelName
            logger.warn(
              { requestedModel: modelName, fallbackModel: candidate.modelName, nodeHost },
              '/api/embed model not found — using fallback',
            )
          }
        }
        if (!nodeHost) {
          return res.status(404).json({ error: `model '${modelName}' not found` })
        }
      }

      if (abortController.signal.aborted) {
        return res.status(499).json({ error: 'Request cancelled' })
      }

      const resp = await request(`${nodeHost}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        headersTimeout: 60_000,
        bodyTimeout: 60_000,
        signal: abortController.signal,
      })
      res.status(resp.statusCode)
      const data = await resp.body.json()
      return res.json(data)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.name === 'AbortError' || abortController.signal.aborted) {
        return res.headersSent ? undefined : res.status(499).json({ error: 'Request cancelled' })
      }
      logger.error({ err }, 'POST /api/embed upstream error')
      return res.headersSent ? undefined : res.status(503).json({ error: 'Upstream error' })
    } finally {
      res.off('close', onClientClose)
    }
  })

  // ── /api/embeddings (deprecated, single prompt → single vector) ───────────────
  app.post('/api/embeddings', async (req, res) => {
    const body = req.body as Record<string, unknown>
    const modelName = body.model as string | undefined
    if (!modelName) {
      return res.status(400).json({ error: 'model is required' })
    }

    const abortController = new AbortController()
    const onClientClose = () => abortController.abort()
    res.once('close', onClientClose)

    try {
      let nodeHost = findNodeForModel(discoveryManager, modelName)

      if (!nodeHost) {
        if (ROUTER_FALLBACK_TO_AUTO && requestRouter) {
          const candidate = await requestRouter.selectForEmbeddings(
            body,
            abortController.signal,
          )
          if (candidate && !Array.isArray(candidate)) {
            nodeHost = candidate.nodeHost
            body.model = candidate.modelName
            logger.warn(
              { requestedModel: modelName, fallbackModel: candidate.modelName, nodeHost },
              '/api/embeddings model not found — using fallback',
            )
          }
        }
        if (!nodeHost) {
          return res.status(404).json({ error: `model '${modelName}' not found` })
        }
      }

      if (abortController.signal.aborted) {
        return res.status(499).json({ error: 'Request cancelled' })
      }

      const resp = await request(`${nodeHost}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        headersTimeout: 60_000,
        bodyTimeout: 60_000,
        signal: abortController.signal,
      })
      res.status(resp.statusCode)
      const data = await resp.body.json()
      return res.json(data)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.name === 'AbortError' || abortController.signal.aborted) {
        return res.headersSent ? undefined : res.status(499).json({ error: 'Request cancelled' })
      }
      logger.error({ err }, 'POST /api/embeddings upstream error')
      return res.headersSent ? undefined : res.status(503).json({ error: 'Upstream error' })
    } finally {
      res.off('close', onClientClose)
    }
  })

  // ── Model management — proxied to first reachable node ────────────────────────

  app.post('/api/pull', async (req, res) => {
    await proxyStreamingToNode(
      req,
      res,
      discoveryManager,
      '/api/pull',
      'POST /api/pull',
    )
  })

  app.post('/api/push', async (req, res) => {
    await proxyStreamingToNode(
      req,
      res,
      discoveryManager,
      '/api/push',
      'POST /api/push',
    )
  })

  app.post('/api/create', async (req, res) => {
    await proxyStreamingToNode(
      req,
      res,
      discoveryManager,
      '/api/create',
      'POST /api/create',
    )
  })

  app.post('/api/copy', async (req, res) => {
    await proxyJsonToNode(
      req,
      res,
      discoveryManager,
      '/api/copy',
      'POST /api/copy',
    )
  })

  app.delete('/api/delete', async (req, res) => {
    await proxyJsonToNode(
      req,
      res,
      discoveryManager,
      '/api/delete',
      'DELETE /api/delete',
      'DELETE',
    )
  })

  app.head('/api/blobs/:digest', async (req, res) => {
    const nodeHost = firstReachableNode(discoveryManager)
    if (!nodeHost) return res.sendStatus(503)
    try {
      const resp = await request(`${nodeHost}/api/blobs/${req.params.digest}`, {
        method: 'HEAD',
        headersTimeout: 5000,
        bodyTimeout: 5000,
      })
      return res.sendStatus(resp.statusCode)
    } catch {
      return res.sendStatus(503)
    }
  })

  app.post('/api/blobs/:digest', async (req, res) => {
    const nodeHost = firstReachableNode(discoveryManager)
    if (!nodeHost) return res.sendStatus(503)
    try {
      const resp = await request(`${nodeHost}/api/blobs/${req.params.digest}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: req,
        headersTimeout: 120_000,
        bodyTimeout: 120_000,
      })
      return res.sendStatus(resp.statusCode)
    } catch {
      return res.sendStatus(503)
    }
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function firstReachableNode(discoveryManager: DiscoveryManager): string | null {
  for (const [nodeHost, node] of discoveryManager.getNodes()) {
    if (node.reachable) return nodeHost
  }
  return null
}

function findNodeForModel(
  discoveryManager: DiscoveryManager,
  modelName: string,
): string | null {
  for (const [nodeHost, node] of discoveryManager.getNodes()) {
    if (!node.reachable) continue
    if (node.models.has(modelName)) return nodeHost
  }
  return null
}

async function proxyStreamingToNode(
  req: Request,
  res: Response,
  discoveryManager: DiscoveryManager,
  endpoint: string,
  logLabel: string,
): Promise<void> {
  const nodeHost = firstReachableNode(discoveryManager)
  if (!nodeHost) {
    res.status(503).json({ error: 'No reachable nodes' })
    return
  }
  try {
    const upstream = await request(`${nodeHost}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      headersTimeout: INFERENCE_TIMEOUT,
      bodyTimeout: INFERENCE_TIMEOUT,
    })
    res.status(upstream.statusCode)
    if (upstream.headers['content-type']) {
      res.setHeader('content-type', upstream.headers['content-type'] as string)
    }
    await pipeline(upstream.body, res)
  } catch (err) {
    logger.error({ err }, `${logLabel} upstream error`)
    if (!res.headersSent) res.status(503).json({ error: 'Upstream error' })
  }
}

async function proxyJsonToNode(
  req: Request,
  res: Response,
  discoveryManager: DiscoveryManager,
  endpoint: string,
  logLabel: string,
  method: Dispatcher.HttpMethod = 'POST',
): Promise<void> {
  const nodeHost = firstReachableNode(discoveryManager)
  if (!nodeHost) {
    res.status(503).json({ error: 'No reachable nodes' })
    return
  }
  try {
    const upstream = await request(`${nodeHost}${endpoint}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      headersTimeout: 30_000,
      bodyTimeout: 30_000,
    })
    res.status(upstream.statusCode)
    if (upstream.statusCode === 200) {
      const data = await upstream.body.json()
      res.json(data)
    } else {
      res.end()
    }
  } catch (err) {
    logger.error({ err }, `${logLabel} upstream error`)
    if (!res.headersSent) res.status(503).json({ error: 'Upstream error' })
  }
}
