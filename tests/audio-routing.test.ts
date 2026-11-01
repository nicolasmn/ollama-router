// audio-routing.test.ts
//
// Integration tests for the /v1/audio/* routes: history lifecycle, audio capture
// + dashboard playback, auto-fast (virtual alias) model routing, and the
// no-capable-model 503 path. Uses stub upstream servers, following the
// existing pass-through test patterns.
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import http from 'node:http'
import express from 'express'
import { once } from 'node:events'
import { setupAudioRoutes } from '../src/routes/audio.js'
import { createAdminRouter } from '../src/routes/admin.js'
import { RequestRouter } from '../src/request-router.js'
import { LoadManager } from '../src/load-manager.js'
import { DiscoveryManager } from '../src/discovery-manager.js'
import { RequestHistoryManager, type RequestEntry } from '../src/request-history.js'
import { NodeInfo, ModelInfo, ModelProfile } from '../src/models.js'
import type { ModelProfileData } from '../src/models.js'
import { rm } from 'node:fs/promises'

const AUDIO_CAPTURE_DIR = '/tmp/opencode/ollama-router-audio-tests'

const SPEECH_MODEL = 'lfm3-audio:2b-mlx-bf16'

const wavBytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])

let lastSpeechBody: Buffer | null = null
let lastTranscriptionBody: Buffer | null = null

function makeDiscovery(
  nodes: Record<string, Record<string, ModelProfileData>>,
): DiscoveryManager {
  const dm = new DiscoveryManager({ ollamaNodes: [] })
  ;(dm as any).getScanStatus = () => ({ inProgress: false, lastScanMs: Date.now(), lastScanAgo: 0 })
  ;(dm as any).discoverNetworkNodes = async () => {}
  for (const [host, models] of Object.entries(nodes)) {
    const node = new NodeInfo(host, false)
    node.reachable = true
    for (const [name, profileData] of Object.entries(models)) {
      node.models.set(name, new ModelInfo(name, 'test', 1e9, new ModelProfile(profileData)))
    }
    dm.inventory.set(host, node)
  }
  return dm
}

function makeApp(
  discovery: DiscoveryManager,
  loadManager: LoadManager,
  history: RequestHistoryManager,
  requestRouter: RequestRouter,
) {
  const app = express()
  setupAudioRoutes(app, discovery, loadManager, requestRouter, history)
  app.use(
    '/admin',
    createAdminRouter({
      discoveryManager: discovery,
      loadManager,
      requestHistoryManager: history,
      dashboardSecret: 'test-secret',
    }),
  )
  return app
}

async function listen(app: express.Application): Promise<http.Server> {
  const server = http.createServer(app)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

async function startListening(server: http.Server): Promise<string> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  return `http://127.0.0.1:${port}`
}

/** Wait until the history entry reaches a terminal status (success/failed/aborted). */
async function waitForEntry(
  history: RequestHistoryManager,
  requestId: string,
  timeoutMs = 5000,
): Promise<RequestEntry | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const entry = history.getRecentRequests().find((e) => e.requestId === requestId) ?? null
    if (entry && !['waiting', 'running'].includes(entry.status)) return entry
    if (Date.now() > deadline) return entry
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<{ status: number; text: string; buffer: Buffer }> {
  const payload = JSON.stringify(body)
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  }).then(async (res) => {
    const buffer = Buffer.from(await res.arrayBuffer())
    return { status: res.status, text: buffer.toString('utf8'), buffer }
  })
}

function getAudio(
  server: http.Server,
  path: string,
  token?: string,
): Promise<{ status: number; buffer: Buffer }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number }
    const headers: Record<string, string> = token ? { Cookie: `dashboard_token=${token}` } : {}
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk as Buffer))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, buffer: Buffer.concat(chunks) }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('audio routes — history, capture, and auto-fast routing', () => {
  let upstreamServer: http.Server | undefined
  let routerServer: http.Server | undefined
  let routerBase = ''
  let upstreamBase = ''
  let discovery: DiscoveryManager
  const history = new RequestHistoryManager({ limit: 20 })
  const servers: http.Server[] = []

  beforeAll(async () => {
    process.env.AUDIO_CAPTURE_DIR = AUDIO_CAPTURE_DIR
    upstreamServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/audio/speech') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        lastSpeechBody = Buffer.concat(chunks)
        res.writeHead(200, { 'Content-Type': 'audio/wav' })
        res.end(wavBytes)
        return
      }
      if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        lastTranscriptionBody = Buffer.concat(chunks)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ text: 'Hello world' }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await startListening(upstreamServer)
    servers.push(upstreamServer)
    upstreamBase = `http://127.0.0.1:${(upstreamServer.address() as { port: number }).port}`

    discovery = makeDiscovery({
      [upstreamBase]: {
        [SPEECH_MODEL]: { capabilities: new Set(['speech']), parameters: 2, contextLength: 8192 },
      },
    })
    const lm = new LoadManager({ maxConcurrentPerNode: 3 })
    const router = new RequestRouter(discovery, lm)
    const app = makeApp(discovery, lm, history, router)
    routerServer = await listen(app)
    servers.push(routerServer)
    routerBase = `http://127.0.0.1:${(routerServer.address() as { port: number }).port}`
  })

  afterAll(async () => {
    for (const server of servers) {
      if (server.listening) await close(server)
    }
    await rm(AUDIO_CAPTURE_DIR, { recursive: true, force: true })
  })

  it('routes auto-fast speech to the audio-capable model and serves the capture', async () => {
    lastSpeechBody = null
    const res = await postJson(routerBase, '/v1/audio/speech', {
      model: 'auto-fast',
      input: 'hello world',
      voice: 'en',
    })
    expect(res.status).toBe(200)
    expect(res.buffer.equals(wavBytes)).toBe(true)
    expect(JSON.parse(lastSpeechBody!.toString('utf8'))).toMatchObject({
      model: SPEECH_MODEL,
      input: 'hello world',
    })

    const entry = await waitForEntry(history, history.getRecentRequests()[0].requestId)
    expect(entry).toBeDefined()
    expect(entry!.endpointType).toBe('audio')
    expect(entry!.status).toBe('success')
    expect(entry!.selectedModel).toBe(SPEECH_MODEL)
    expect(entry!.selectedNode).toBe(upstreamBase)
    expect(entry!.responseStatus).toBe(200)

    const audio = await getAudio(routerServer!, `/admin/audio/${entry!.requestId}`, 'test-secret')
    expect(audio.status).toBe(200)
    expect(audio.buffer.equals(wavBytes)).toBe(true)

    const denied = await getAudio(routerServer!, `/admin/audio/${entry!.requestId}`)
    expect(denied.status).toBe(403)
  })

  it('rewrites the model in a multipart transcription body and preserves the file bytes', async () => {
    const fileData = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])
    const formData = new FormData()
    formData.append('model', 'auto-fast')
    formData.append('file', new Blob([fileData], { type: 'audio/wav' }), 'sample.wav')
    const res = await fetch(`${routerBase}/v1/audio/transcriptions`, {
      method: 'POST',
      body: formData,
    }).then(async (r) => {
      const buffer = Buffer.from(await r.arrayBuffer())
      return { status: r.status, text: buffer.toString('utf8'), buffer }
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.text)).toEqual({ text: 'Hello world' })

    const upstreamBody = lastTranscriptionBody!
    const bodyText = upstreamBody.toString('latin1')
    expect(bodyText).toContain(`name="model"\r\n\r\n${SPEECH_MODEL}`)
    expect(bodyText).toContain(`filename="sample.wav"`)
    expect(bodyText).toContain(fileData.toString('latin1'))

    const entry = await waitForEntry(history, history.getRecentRequests()[0].requestId)
    expect(entry!.status).toBe('success')
    expect(entry!.selectedModel).toBe(SPEECH_MODEL)
  })

  it('returns 503 when no audio-capable model is reachable', async () => {
    const emptyDiscovery = makeDiscovery({ 'http://empty:11434': {} })
    const emptyLoad = new LoadManager({ maxConcurrentPerNode: 3 })
    const emptyHistory = new RequestHistoryManager({ limit: 20 })
    const emptyRouter = new RequestRouter(emptyDiscovery, emptyLoad)
    const emptyApp = makeApp(emptyDiscovery, emptyLoad, emptyHistory, emptyRouter)
    const emptyServer = await listen(emptyApp)
    const emptyAddr = emptyServer.address() as { port: number }
    const base = `http://127.0.0.1:${emptyAddr.port}`
    try {
      const res = await postJson(base, '/v1/audio/speech', { model: 'auto-fast', input: 'hi' })
      expect(res.status).toBe(503)
      expect(JSON.parse(res.text)).toEqual({ error: 'no audio-capable model available' })
      const entry = emptyHistory.getRecentRequests()[0]
      expect(entry!.status).toBe('failed')
      expect(entry!.responseStatus).toBe(503)
    } finally {
      await close(emptyServer)
    }
  })

  it('keeps the direct path for an exact audio model name', async () => {
    lastSpeechBody = null
    const res = await postJson(routerBase, '/v1/audio/speech', {
      model: SPEECH_MODEL,
      input: 'hello world',
      voice: 'en',
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(lastSpeechBody!.toString('utf8'))).toMatchObject({
      model: SPEECH_MODEL,
    })
    const entry = await waitForEntry(history, history.getRecentRequests()[0].requestId)
    expect(entry!.status).toBe('success')
    expect(entry!.selectedModel).toBe(SPEECH_MODEL)
  })
})
