import { describe, it, expect, afterEach } from '@jest/globals'
import express, { type Express } from 'express'
import http from 'node:http'
import { once } from 'node:events'
import { setupOllamaRoutes } from '../src/routes/ollama.js'
import { ModelInfo, ModelProfile, type NodeInfo } from '../src/models.js'
import type { DiscoveryManager } from '../src/discovery-manager.js'

function createDiscoveryManager(reachable: boolean, decisionModel = false) {
  const profile = new ModelProfile({
    capabilities: new Set(['completion', 'tools', 'vision']),
    contextLength: 131_072,
    parameters: 8,
    architecture: 'gemma3',
    supportsTools: true,
    supportsVision: true,
  })
  const modelInfo = new ModelInfo('gemma3:4b', 'gemma3', 5_000_000_000, profile)
  const models = new Map([['gemma3:4b', modelInfo]])
  if (decisionModel) {
    models.set(
      'decision-base:2b',
      new ModelInfo(
        'decision-base:2b',
        'test',
        1e9,
        new ModelProfile({
          capabilities: new Set(['decision']),
          supportsDecision: true,
          parameters: 2,
          contextLength: 8192,
        }),
      ),
    )
  }
  const node = {
    host: 'http://127.0.0.1:1234',
    reachable,
    lastSeen: Date.now(),
    failures: 0,
    lastFailure: 0,
    activeRequests: 0,
    models,
    cloud: false,
    mac: null,
  } as unknown as NodeInfo
  return {
    getNodes: () => new Map([['http://127.0.0.1:1234', node]]),
  } as unknown as DiscoveryManager
}

async function startServer(app: Express): Promise<string> {
  const server = http.createServer(app)
  server.listen(0)
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  return `http://127.0.0.1:${port}`
}

describe('Ollama model discovery endpoints (/api/tags, /api/show)', () => {
  let baseUrl: string
  let server: http.Server

  afterEach(async () => {
    if (server.listening)
      await new Promise<void>((r) => server.close(() => r()))
  })

  async function start(reachable: boolean, decisionModel = false) {
    const app: Express = express()
    app.use(express.json())
    setupOllamaRoutes(app, createDiscoveryManager(reachable, decisionModel))
    server = http.createServer(app)
    baseUrl = await startServer(app)
  }

  it('resolves the model from the OpenAI-style `model` field', async () => {
    await start(true)
    const response = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemma3:4b' }),
    })
    expect(response.status).toBe(200)
    const json = (await response.json()) as {
      capabilities?: string[]
      model_info?: Record<string, unknown>
    }
    expect(json.capabilities).toContain('completion')
    expect(json.model_info?.['gemma3.context_length']).toBe(131_072)
  })

  it('still resolves the legacy `name` field', async () => {
    await start(true)
    const response = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'gemma3:4b' }),
    })
    expect(response.status).toBe(200)
  })

  it('returns 400 when no model identifier is present', async () => {
    await start(true)
    const response = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(400)
  })

  it('lists models of offline (sleeping) nodes via GET /api/tags', async () => {
    await start(false)
    const response = await fetch(`${baseUrl}/api/tags`)
    expect(response.status).toBe(200)
    const json = (await response.json()) as { models?: Array<{ name: string }> }
    expect(json.models).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'gemma3:4b' })]),
    )
  })

  it('lists decision models via GET /api/tags', async () => {
    await start(true, true)
    const response = await fetch(`${baseUrl}/api/tags`)
    expect(response.status).toBe(200)
    const json = (await response.json()) as { models?: Array<{ name: string }> }
    expect(json.models).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'gemma3:4b' })]),
    )
    expect(json.models?.some((m) => m.name === 'decision-base:2b')).toBe(true)
  })

  it('still resolves decision models via POST /api/show', async () => {
    await start(true, true)
    const response = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'decision-base:2b' }),
    })
    expect(response.status).toBe(200)
    const json = (await response.json()) as { capabilities?: string[] }
    expect(json.capabilities).toContain('decision')
  })

  it('resolves a model hosted on an offline (sleeping) node via POST /api/show', async () => {
    await start(false)
    const response = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemma3:4b' }),
    })
    expect(response.status).toBe(200)
    const json = (await response.json()) as {
      capabilities?: string[]
      model_info?: Record<string, unknown>
    }
    expect(json.capabilities).toContain('completion')
    expect(json.model_info?.['gemma3.context_length']).toBe(131_072)
  })
})
