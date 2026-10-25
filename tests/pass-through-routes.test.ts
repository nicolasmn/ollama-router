import { describe, it, expect, afterEach, jest } from '@jest/globals'
import express, { type Express } from 'express'
import http from 'node:http'
import { once } from 'node:events'
import { setupChatRoutes } from '../src/routes/chat.js'
import { setupResponsesRoutes } from '../src/routes/responses.js'
import { setupMessagesRoutes } from '../src/routes/messages.js'
import { setupOllamaInferenceRoutes } from '../src/routes/ollama-inference.js'
import type { DiscoveryManager } from '../src/discovery-manager.js'
import type { LoadManager } from '../src/load-manager.js'
import type { RequestHistoryManager } from '../src/request-history.js'

function createLoadManager() {
  return {
    incrementLoad: jest.fn(),
    decrementLoad: jest.fn(),
  } as unknown as LoadManager
}

function createDiscoveryManager(nodeHost: string, modelName: string) {
  return {
    inventory: new Map([
      [
        nodeHost,
        {
          models: new Map([
            [modelName, { profile: { supportsThinking: true } }],
          ]),
        },
      ],
    ]),
    updateModelMetrics: jest.fn(),
    recordModelFailure: jest.fn(),
    getCloudApiKey: jest.fn().mockReturnValue(null),
  } as unknown as DiscoveryManager
}

function createRequestHistoryManager() {
  return {
    startRequest: jest.fn(),
    recordSelection: jest.fn(),
    recordAttempt: jest.fn(),
    finishRequest: jest.fn(),
    updateResponseContent: jest.fn(),
    applyStreamingEvent: jest.fn(),
    finalizeStreamingResponse: jest.fn(),
    registerAbortController: jest.fn(),
    unregisterAbortController: jest.fn(),
  } as unknown as RequestHistoryManager
}

async function startServer(server: http.Server): Promise<string> {
  server.listen(0)
  await once(server, 'listening')
  const { port } = server.address() as { port: number }
  return `http://127.0.0.1:${port}`
}

describe('native pass-through routes', () => {
  let upstreamServer: http.Server | undefined
  let routerServer: http.Server | undefined

  afterEach(async () => {
    if (routerServer?.listening) await new Promise<void>((r) => routerServer!.close(() => r()))
    if (upstreamServer?.listening) await new Promise<void>((r) => upstreamServer!.close(() => r()))
  })

  it('passes chat body through to upstream /v1/chat/completions (only model is rewritten)', async () => {
    let upstreamBody: Record<string, unknown> | null = null

    upstreamServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'chatcmpl_test',
            object: 'chat.completion',
            created: 1,
            model: upstreamBody!.model,
            choices: [
              { index: 0, message: { role: 'assistant', content: 'ok' } },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        )
        return
      }
      res.writeHead(404); res.end()
    })

    const upstreamBase = await startServer(upstreamServer)
    const routedModel = 'qwen3:8b'
    const app: Express = express()
    app.use(express.json())

    const requestRouter = {
      analyzeRequest: jest.fn(() => ({ endpointType: 'chat' })),
      selectForChat: jest.fn(() => [{ nodeHost: upstreamBase, modelName: routedModel }]),
    } as any
    setupChatRoutes(app, createDiscoveryManager(upstreamBase, routedModel), createLoadManager(), requestRouter, createRequestHistoryManager())

    routerServer = http.createServer(app)
    const routerBase = await startServer(routerServer)

    const payload = {
      model: 'auto', stream: false, reasoning_effort: 'high', tool_choice: 'required',
      tools: [{ type: 'function', function: { name: 'lookup_docs', parameters: { type: 'object', properties: {} } } }],
      messages: [{ role: 'user', content: 'Find docs' }],
    }
    const response = await fetch(`${routerBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(response.status).toBe(200)
    expect(upstreamBody).toEqual({ ...payload, model: routedModel })
  })

  it('inlines http(s) image_url parts as data URLs before forwarding', async () => {
    let upstreamBody: Record<string, unknown> | null = null

    upstreamServer = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/img.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end(Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
          'base64',
        ))
        return
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'chatcmpl_img',
            object: 'chat.completion',
            created: 1,
            model: upstreamBody!.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        )
        return
      }
      res.writeHead(404); res.end()
    })

    const upstreamBase = await startServer(upstreamServer)
    const routedModel = 'qwen3:8b'
    const app: Express = express()
    app.use(express.json())

    const requestRouter = {
      analyzeRequest: jest.fn(() => ({ endpointType: 'chat' })),
      selectForChat: jest.fn(() => [{ nodeHost: upstreamBase, modelName: routedModel }]),
    } as any
    setupChatRoutes(app, createDiscoveryManager(upstreamBase, routedModel), createLoadManager(), requestRouter, createRequestHistoryManager())

    routerServer = http.createServer(app)
    const routerBase = await startServer(routerServer)

    const payload = {
      model: routedModel,
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            { type: 'image_url', image_url: { url: `${upstreamBase}/img.png` } },
          ],
        },
      ],
    }
    const response = await fetch(`${routerBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(response.status).toBe(200)
    const content = (upstreamBody as any)?.messages?.[0]?.content as Array<Record<string, unknown>>
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==` },
    })
  })

  it('streams chat completions SSE response and captures streamed content', async () => {
    const sseLines = [
      'data: {"id":"chatcmpl_sse","object":"chat.completion.chunk","model":"qwen3:8b","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl_sse","object":"chat.completion.chunk","model":"qwen3:8b","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ]
    upstreamServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        for (const line of sseLines) res.write(line)
        res.end(); return
      }
      res.writeHead(404); res.end()
    })
    const upstreamBase = await startServer(upstreamServer)
    const routedModel = 'qwen3:8b'
    const app: Express = express()
    app.use(express.json())
    const requestRouter = {
      analyzeRequest: jest.fn(() => ({ endpointType: 'chat' })),
      selectForChat: jest.fn(() => [{ nodeHost: upstreamBase, modelName: routedModel }]),
    } as any
    const historyManager = createRequestHistoryManager()
    setupChatRoutes(app, createDiscoveryManager(upstreamBase, routedModel), createLoadManager(), requestRouter, historyManager)
    routerServer = http.createServer(app)
    const routerBase = await startServer(routerServer)
    const response = await fetch(`${routerBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'Hi' }] }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/x-ndjson|event-stream/)
    const text = await response.text()
    // pass-through intact: SSE framing survives the capture transform
    expect(text).toContain('data: {"id":"chatcmpl_sse"')
    expect(text).toContain('data: [DONE]')
    // capture: SSE `data:` payloads are parsed and forwarded, [DONE] is skipped
    expect(historyManager.applyStreamingEvent).toHaveBeenCalledTimes(2)
    expect(historyManager.applyStreamingEvent).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ id: 'chatcmpl_sse' }))
  })

  it('passes responses body through to upstream /v1/responses (only model is rewritten)', async () => {
    let upstreamBody: Record<string, unknown> | null = null

    upstreamServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/responses') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ id: 'resp_test', object: 'response', output_text: 'ok', usage: { output_tokens: 1, input_tokens: 1, total_tokens: 2 } }))
        return
      }
      res.writeHead(404); res.end()
    })

    const upstreamBase = await startServer(upstreamServer)
    const routedModel = 'qwen3:8b'
    const app: Express = express()
    app.use(express.json())

    const requestRouter = {
      analyzeRequest: jest.fn(() => ({ endpointType: 'responses' })),
      selectForResponses: jest.fn(() => [{ nodeHost: upstreamBase, modelName: routedModel }]),
    } as any
    setupResponsesRoutes(app, createDiscoveryManager(upstreamBase, routedModel), createLoadManager(), requestRouter, createRequestHistoryManager())

    routerServer = http.createServer(app)
    const routerBase = await startServer(routerServer)

    const payload = {
      model: 'auto', stream: false,
      reasoning: { effort: 'medium' },
      tools: [{ type: 'function', name: 'lookup_docs', parameters: { type: 'object', properties: {} } }],
      input: [{ role: 'user', content: 'Find docs' }],
    }
    const response = await fetch(`${routerBase}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(response.status).toBe(200)
    expect(upstreamBody).toEqual({ ...payload, model: routedModel })
  })

  it('rejects stateful responses fields before contacting upstream', async () => {
    let upstreamCalls = 0
    upstreamServer = http.createServer((_req, res) => { upstreamCalls++; res.writeHead(500); res.end() })
    const upstreamBase = await startServer(upstreamServer)
    const app: Express = express()
    app.use(express.json())
    const requestRouter = {
      analyzeRequest: jest.fn(() => ({ endpointType: 'responses' })),
      selectForResponses: jest.fn(() => [{ nodeHost: upstreamBase, modelName: 'qwen3:8b' }]),
    } as any
    setupResponsesRoutes(app, createDiscoveryManager(upstreamBase, 'qwen3:8b'), createLoadManager(), requestRouter, createRequestHistoryManager())
    routerServer = http.createServer(app)
    const routerBase = await startServer(routerServer)
    const response = await fetch(`${routerBase}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'auto', previous_response_id: 'resp_prev', input: 'hi' }),
    })
    const json = await response.json()
    expect(response.status).toBe(400)
    expect(json.param).toBe('previous_response_id')
    expect(upstreamCalls).toBe(0)
  })
})

describe('/v1/messages route', () => {
  let upstreamServer: http.Server | undefined
  let routerServer: http.Server | undefined

  afterEach(async () => {
    if (routerServer?.listening) await new Promise<void>((r) => routerServer!.close(() => r()))
    if (upstreamServer?.listening) await new Promise<void>((r) => upstreamServer!.close(() => r()))
  })

  it('passes messages body through to upstream /v1/messages (only model is rewritten)', async () => {
    let upstreamBody: Record<string, unknown> | null = null

    upstreamServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/messages') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_test', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: (upstreamBody as any).model,
          stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 1 },
        }))
        return
      }
      res.writeHead(404); res.end()
    })

    const upstreamBase = await startServer(upstreamServer)
    const routedModel = 'qwen3-coder:32b'
    const app: Express = express()
    app.use(express.json())
    const requestRouter = {
      analyzeRequest: jest.fn(() => ({ endpointType: 'chat' })),
      selectForChat: jest.fn(() => [{ nodeHost: upstreamBase, modelName: routedModel }]),
    } as any
    setupMessagesRoutes(app, createDiscoveryManager(upstreamBase, routedModel), createLoadManager(), requestRouter, createRequestHistoryManager())
    routerServer = http.createServer(app)
    const routerBase = await startServer(routerServer)

    const payload = {
      model: 'claude-sonnet-4-6', max_tokens: 1024,
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: {}, required: [] } }],
    }
    const response = await fetch(`${routerBase}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(payload),
    })
    const json = await response.json()
    expect(response.status).toBe(200)
    expect(upstreamBody).toEqual({ ...payload, model: routedModel })
    expect(json.type).toBe('message')
    expect(json.content[0].type).toBe('text')
  })

  it('rejects requests missing required fields before contacting upstream', async () => {
    let upstreamCalls = 0
    upstreamServer = http.createServer((_req, res) => { upstreamCalls++; res.writeHead(500); res.end() })
    const upstreamBase = await startServer(upstreamServer)
    const routedModel = 'qwen3-coder:32b'
    const app: Express = express()
    app.use(express.json())
    const requestRouter = {
      analyzeRequest: jest.fn(() => ({})),
      selectForChat: jest.fn(() => [{ nodeHost: upstreamBase, modelName: routedModel }]),
    } as any
    setupMessagesRoutes(app, createDiscoveryManager(upstreamBase, routedModel), createLoadManager(), requestRouter, createRequestHistoryManager())
    routerServer = http.createServer(app)
    const routerBase = await startServer(routerServer)
    const response = await fetch(`${routerBase}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(400)
    expect(upstreamCalls).toBe(0)
  })

  it('streams messages response when stream:true', async () => {
    const sseEvents = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"qwen3-coder","stop_reason":null,"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    upstreamServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/messages') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        for (const e of sseEvents) res.write(e)
        res.end(); return
      }
      res.writeHead(404); res.end()
    })
    const upstreamBase = await startServer(upstreamServer)
    const routedModel = 'qwen3-coder:32b'
    const app: Express = express()
    app.use(express.json())
    const requestRouter = {
      analyzeRequest: jest.fn(() => ({ endpointType: 'chat' })),
      selectForChat: jest.fn(() => [{ nodeHost: upstreamBase, modelName: routedModel }]),
    } as any
    setupMessagesRoutes(app, createDiscoveryManager(upstreamBase, routedModel), createLoadManager(), requestRouter, createRequestHistoryManager())
    routerServer = http.createServer(app)
    const routerBase = await startServer(routerServer)
    const response = await fetch(`${routerBase}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'Hi' }] }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/)
    const text = await response.text()
    expect(text).toContain('message_start')
    expect(text).toContain('message_stop')
  }, 30000)
})

describe('/api/generate and /api/chat routes', () => {
  let upstreamServer: http.Server | undefined
  let routerServer: http.Server | undefined

  afterEach(async () => {
    if (routerServer?.listening) await new Promise<void>((r) => routerServer!.close(() => r()))
    if (upstreamServer?.listening) await new Promise<void>((r) => upstreamServer!.close(() => r()))
  }, 30000)

  function buildRequestRouter(upstreamBase: string, routedModel: string) {
    return {
      analyzeRequest: jest.fn(() => ({ endpointType: 'chat' })),
      selectForChat: jest.fn(() => [{ nodeHost: upstreamBase, modelName: routedModel }]),
    } as any
  }

  const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

  it('passes generate body through to upstream /api/generate (only model is rewritten)', async () => {
    let upstreamBody: Record<string, unknown> | null = null
    upstreamServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/api/generate') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ model: upstreamBody!.model, response: 'ok', done: true }))
        return
      }
      res.writeHead(404); res.end()
    })
    const upstreamBase = await startServer(upstreamServer)
    const routedModel = 'qwen3:8b'
    const app: Express = express()
    app.use(express.json())
    setupOllamaInferenceRoutes(app, createDiscoveryManager(upstreamBase, routedModel), createLoadManager(), buildRequestRouter(upstreamBase, routedModel), createRequestHistoryManager())
    routerServer = http.createServer(app)
    const routerBase = await startServer(routerServer)
    const payload = { model: 'auto', prompt: 'Why is the sky blue?', stream: false }
    const response = await fetch(`${routerBase}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(response.status).toBe(200)
    expect(upstreamBody).toEqual({ ...payload, model: routedModel })
  }, 30000)

  it('passes chat body through to upstream /api/chat (only model is rewritten)', async () => {
    let upstreamBody: Record<string, unknown> | null = null
    upstreamServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/api/chat') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ model: upstreamBody!.model, message: { role: 'assistant', content: 'ok' }, done: true }))
        return
      }
      res.writeHead(404); res.end()
    })
    const upstreamBase = await startServer(upstreamServer)
    const routedModel = 'qwen3:8b'
    const app: Express = express()
    app.use(express.json())
    setupOllamaInferenceRoutes(app, createDiscoveryManager(upstreamBase, routedModel), createLoadManager(), buildRequestRouter(upstreamBase, routedModel), createRequestHistoryManager())
    routerServer = http.createServer(app)
    const routerBase = await startServer(routerServer)
    const payload = { model: 'auto', messages: [{ role: 'user', content: 'Hi' }], stream: false }
    const response = await fetch(`${routerBase}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(response.status).toBe(200)
    expect(upstreamBody).toEqual({ ...payload, model: routedModel })
  }, 30000)

  it('passes native per-message base64 images through untouched', async () => {
    let upstreamBody: Record<string, unknown> | null = null
    upstreamServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/api/chat') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ model: upstreamBody!.model, message: { role: 'assistant', content: 'ok' }, done: true }))
        return
      }
      res.writeHead(404); res.end()
    })
    const upstreamBase = await startServer(upstreamServer)
    const routedModel = 'qwen3:8b'
    const app: Express = express()
    app.use(express.json())
    setupOllamaInferenceRoutes(app, createDiscoveryManager(upstreamBase, routedModel), createLoadManager(), buildRequestRouter(upstreamBase, routedModel), createRequestHistoryManager())
    routerServer = http.createServer(app)
    const routerBase = await startServer(routerServer)
    const payload = {
      model: routedModel,
      stream: false,
      messages: [{ role: 'user', content: 'what is in this image?', images: [TINY_PNG_BASE64] }],
    }
    const response = await fetch(`${routerBase}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(response.status).toBe(200)
    expect(upstreamBody).toEqual(payload)
  }, 30000)

  it('merges top-level images on native /api/chat into the user message', async () => {
    let upstreamBody: Record<string, unknown> | null = null
    upstreamServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/api/chat') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ model: upstreamBody!.model, message: { role: 'assistant', content: 'ok' }, done: true }))
        return
      }
      res.writeHead(404); res.end()
    })
    const upstreamBase = await startServer(upstreamServer)
    const routedModel = 'qwen3:8b'
    const app: Express = express()
    app.use(express.json())
    setupOllamaInferenceRoutes(app, createDiscoveryManager(upstreamBase, routedModel), createLoadManager(), buildRequestRouter(upstreamBase, routedModel), createRequestHistoryManager())
    routerServer = http.createServer(app)
    const routerBase = await startServer(routerServer)
    const payload = {
      model: 'auto',
      stream: false,
      messages: [{ role: 'user', content: 'what is in this image?' }],
      images: [TINY_PNG_BASE64],
    }
    const response = await fetch(`${routerBase}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(response.status).toBe(200)
    expect(upstreamBody).toEqual({
      model: routedModel,
      stream: false,
      messages: [{ role: 'user', content: 'what is in this image?', images: [TINY_PNG_BASE64] }],
    })
  }, 30000)

  it('passes /api/generate top-level images through untouched', async () => {
    let upstreamBody: Record<string, unknown> | null = null
    upstreamServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/api/generate') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ model: upstreamBody!.model, response: 'ok', done: true }))
        return
      }
      res.writeHead(404); res.end()
    })
    const upstreamBase = await startServer(upstreamServer)
    const routedModel = 'qwen3:8b'
    const app: Express = express()
    app.use(express.json())
    setupOllamaInferenceRoutes(app, createDiscoveryManager(upstreamBase, routedModel), createLoadManager(), buildRequestRouter(upstreamBase, routedModel), createRequestHistoryManager())
    routerServer = http.createServer(app)
    const routerBase = await startServer(routerServer)
    const payload = { model: routedModel, prompt: 'what is in this picture?', images: [TINY_PNG_BASE64], stream: false }
    const response = await fetch(`${routerBase}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(response.status).toBe(200)
    expect(upstreamBody).toEqual(payload)
  }, 30000)

  it('strips data: prefixes in native image arrays to raw base64', async () => {
    let upstreamBody: Record<string, unknown> | null = null
    upstreamServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/api/chat') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ model: upstreamBody!.model, message: { role: 'assistant', content: 'ok' }, done: true }))
        return
      }
      res.writeHead(404); res.end()
    })
    const upstreamBase = await startServer(upstreamServer)
    const routedModel = 'qwen3:8b'
    const app: Express = express()
    app.use(express.json())
    setupOllamaInferenceRoutes(app, createDiscoveryManager(upstreamBase, routedModel), createLoadManager(), buildRequestRouter(upstreamBase, routedModel), createRequestHistoryManager())
    routerServer = http.createServer(app)
    const routerBase = await startServer(routerServer)
    const payload = {
      model: routedModel,
      stream: false,
      messages: [{ role: 'user', content: 'describe', images: [`data:image/png;base64,${TINY_PNG_BASE64}`] }],
    }
    const response = await fetch(`${routerBase}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(response.status).toBe(200)
    expect(upstreamBody).toEqual({
      ...payload,
      messages: [{ role: 'user', content: 'describe', images: [TINY_PNG_BASE64] }],
    })
  }, 30000)

  it('streams generate response by default when stream is not set', async () => {
    const ndjsonLines = [
      '{"model":"qwen3:8b","response":"Why","done":false}\n',
      '{"model":"qwen3:8b","response":" is","done":false}\n',
      '{"model":"qwen3:8b","response":" the sky blue?","done":false}\n',
      '{"model":"qwen3:8b","response":"","done":true,"done_reason":"stop"}\n',
    ]
    upstreamServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/api/generate') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
        for (const line of ndjsonLines) res.write(line)
        res.end(); return
      }
      res.writeHead(404); res.end()
    })
    const upstreamBase = await startServer(upstreamServer)
    const routedModel = 'qwen3:8b'
    const app: Express = express()
    app.use(express.json())
    setupOllamaInferenceRoutes(app, createDiscoveryManager(upstreamBase, routedModel), createLoadManager(), buildRequestRouter(upstreamBase, routedModel), createRequestHistoryManager())
    routerServer = http.createServer(app)
    const routerBase = await startServer(routerServer)
    const response = await fetch(`${routerBase}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'auto', prompt: 'Why is the sky blue?' }),
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    const lines = text.trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    const last = JSON.parse(lines[lines.length - 1])
    expect(last.done).toBe(true)
  }, 30000)
})
