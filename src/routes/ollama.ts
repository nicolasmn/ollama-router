// ollama.ts - Ollama native proxy routes (non-inference)
import express from 'express'
import type { Router, Request, Response } from 'express'
import { request as undiciRequest } from 'undici'
import { createLogger } from '../logger.js'
import type { DiscoveryManager } from '../discovery-manager.js'
import type { RequestRouter } from '../request-router.js'

const logger = createLogger('ollama')

export interface OllamaRouterDeps {
  discoveryManager: DiscoveryManager
  requestRouter: RequestRouter
}

async function proxyToFirstReachable(
  req: Request,
  res: Response,
  discoveryManager: DiscoveryManager,
  path: string,
  method = 'GET',
): Promise<void> {
  const nodes = discoveryManager.getNodes()
  for (const [, node] of nodes) {
    if (!node.reachable) continue
    try {
      const resp = await undiciRequest(`${node.host}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body:
          method !== 'GET' && req.body
            ? JSON.stringify(req.body)
            : undefined,
        headersTimeout: 10000,
        bodyTimeout: 10000,
      })
      res.status(resp.statusCode)
      const ct = resp.headers['content-type']
      if (ct) res.setHeader('Content-Type', ct as string)
      const data = await resp.body.json()
      res.json(data)
      return
    } catch (err) {
      logger.warn(
        { nodeHost: node.host, path, err: (err as Error).message },
        'Ollama proxy failed',
      )
    }
  }
  res.status(503).json({ error: 'No reachable nodes' })
}

export function createOllamaRouter({
  discoveryManager,
  requestRouter,
}: OllamaRouterDeps): Router {
  const r = express.Router()

  r.get('/api/tags', async (req, res) => {
    // Merge models from all reachable nodes
    const nodes = discoveryManager.getNodes()
    const models: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    for (const [, node] of nodes) {
      if (!node.reachable) continue
      for (const [name, info] of node.models) {
        if (!seen.has(name)) {
          seen.add(name)
          models.push({
            name: info.name,
            model: info.name,
            size: info.size,
            family: info.family,
            details: { family: info.family },
          })
        }
      }
    }
    res.json({ models })
  })

  r.get('/api/version', async (req, res) => {
    await proxyToFirstReachable(req, res, discoveryManager, '/api/version')
  })

  r.post('/api/show', async (req, res) => {
    const modelName = (req.body as Record<string, unknown>)?.model as string
    if (!modelName) {
      res.status(400).json({ error: 'model required' })
      return
    }
    // Find node that has this model
    const nodes = discoveryManager.getNodes()
    for (const [, node] of nodes) {
      if (!node.reachable) continue
      if (!node.models.has(modelName)) continue
      try {
        const resp = await undiciRequest(`${node.host}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelName }),
          headersTimeout: 10000,
          bodyTimeout: 10000,
        })
        const data = await resp.body.json()
        res.status(resp.statusCode).json(data)
        return
      } catch (err) {
        logger.warn({ nodeHost: node.host, modelName }, 'api/show proxy failed')
      }
    }
    res.status(404).json({ error: `Model not found: ${modelName}` })
  })

  r.get('/api/ps', async (req, res) => {
    await proxyToFirstReachable(req, res, discoveryManager, '/api/ps')
  })

  return r
}
