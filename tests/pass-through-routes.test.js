import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals'
import express from 'express'
import http from 'node:http'
import { once } from 'node:events'
import { setupChatRoutes } from '../src/routes/chat.js'
import { setupResponsesRoutes } from '../src/routes/responses.js'

function createLoadManager() {
  return {
    incrementLoad: jest.fn(),
    decrementLoad: jest.fn(),
  }
}

function createDiscoveryManager(nodeHost, modelName) {
  return {
    inventory: new Map([
      [
        nodeHost,
        {
          models: new Map([
            [
              modelName,
              {
                profile: {
                  supportsThinking: true,
                },
              },
            ],
          ]),
        },
      ],
    ]),
    updateModelMetrics: jest.fn(),
    recordModelFailure: jest.fn(),
  }
}

function createRequestHistoryManager() {
  return {
    startRequest: jest.fn(),
    recordSelection: jest.fn(),
    recordAttempt: jest.fn(),
    finishRequest: jest.fn(),
    updateResponseContent: jest.fn(),
  }
}

async function startServer(server) {
  server.listen(0)
  await once(server, 'listening')
  const { port } = server.address()
  return `http://127.0.0.1:${port}`
}

describe('native pass-through routes', () => {
  let upstreamServer
  let routerServer

  afterEach(async () => {
    if (routerServer?.listening) {
      await new Promise((resolve) => routerServer.close(resolve))
    }
    if (upstreamServer?.listening) {
      await new Promise((resolve) => upstreamServer.close(resolve))
    }
  })

  it('passes chat body through to upstream /v1/chat/completions (only model is rewritten)', async () => {
    let upstreamBody = null

    upstreamServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'chatcmpl_test',
            object: 'chat.completion',
            created: 1,
            model: upstreamBody.model,
            choices: [
              { index: 0, message: { role: 'assistant', content: 'ok' } },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        )
        return
      }
      res.writeHead(404)
      res.end()
    })

    const upstreamBase = await startServer(upstreamServer)
    const routedModel = 'qwen3:8b'

    const app = express()
    app.use(express.json())

    const requestRouter = {
      analyzeRequest: jest.fn(() => ({ endpointType: 'chat' })),
      selectForChat: jest.fn(() => [
        {
          nodeHost: upstreamBase,
          modelName: routedModel,
        },
      ]),
    }

    setupChatRoutes(
      app,
      createDiscoveryManager(upstreamBase, routedModel),
      createLoadManager(),
      requestRouter,
      createRequestHistoryManager(),
    )

    routerServer = http.createServer(app)
    const routerBase = await startServer(routerServer)

    const payload = {
      model: 'auto',
      stream: false,
      reasoning_effort: 'high',
      tool_choice: 'required',
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup_docs',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
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

  it('passes responses body through to upstream /v1/responses (only model is rewritten)', async () => {
    let upstreamBody = null

    upstreamServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/responses') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'resp_test',
            object: 'response',
            output_text: 'ok',
            usage: { output_tokens: 1, input_tokens: 1, total_tokens: 2 },
          }),
        )
        return
      }
      res.writeHead(404)
      res.end()
    })

    const upstreamBase = await startServer(upstreamServer)
    const routedModel = 'qwen3:8b'

    const app = express()
    app.use(express.json())

    const requestRouter = {
      analyzeRequest: jest.fn(() => ({ endpointType: 'responses' })),
      selectForResponses: jest.fn(() => [
        {
          nodeHost: upstreamBase,
          modelName: routedModel,
        },
      ]),
    }

    setupResponsesRoutes(
      app,
      createDiscoveryManager(upstreamBase, routedModel),
      createLoadManager(),
      requestRouter,
      createRequestHistoryManager(),
    )

    routerServer = http.createServer(app)
    const routerBase = await startServer(routerServer)

    const payload = {
      model: 'auto',
      stream: false,
      reasoning: { effort: 'medium' },
      tools: [
        {
          type: 'function',
          name: 'lookup_docs',
          parameters: { type: 'object', properties: {} },
        },
      ],
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

    upstreamServer = http.createServer(async (_req, res) => {
      upstreamCalls += 1
      res.writeHead(500)
      res.end()
    })

    const upstreamBase = await startServer(upstreamServer)

    const app = express()
    app.use(express.json())

    const requestRouter = {
      analyzeRequest: jest.fn(() => ({ endpointType: 'responses' })),
      selectForResponses: jest.fn(() => [
        {
          nodeHost: upstreamBase,
          modelName: 'qwen3:8b',
        },
      ]),
    }

    setupResponsesRoutes(
      app,
      createDiscoveryManager(upstreamBase, 'qwen3:8b'),
      createLoadManager(),
      requestRouter,
      createRequestHistoryManager(),
    )

    routerServer = http.createServer(app)
    const routerBase = await startServer(routerServer)

    const response = await fetch(`${routerBase}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'auto',
        previous_response_id: 'resp_prev',
        input: 'hi',
      }),
    })

    const json = await response.json()
    expect(response.status).toBe(400)
    expect(json.param).toBe('previous_response_id')
    expect(upstreamCalls).toBe(0)
  })
})
