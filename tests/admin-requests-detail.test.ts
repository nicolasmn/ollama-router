// admin-requests-detail.test.ts
//
// Regression tests for:
//  1. GET /admin/requests/:requestId — the dashboard drawer hydrates message
//     threads from here because the periodic WS broadcast omits messageList.
//  2. RequestHistoryManager.activeRequestCount — the shutdown drain waits for
//     in-flight requests before exiting (systemd restart drain).
import { describe, it, expect } from '@jest/globals'
import http from 'node:http'
import express from 'express'
import { createAdminRouter } from '../src/routes/admin.js'
import { RequestHistoryManager } from '../src/request-history.js'
import { DiscoveryManager } from '../src/discovery-manager.js'
import { LoadManager } from '../src/load-manager.js'

function get(server: http.Server, path: string): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number }
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path, method: 'GET' },
      (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data: JSON.parse(body) }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function makeServer(discovery: DiscoveryManager, loadManager: LoadManager, history: RequestHistoryManager): Promise<http.Server> {
  const app = express()
  app.use(express.json())
  app.use(
    '/admin',
    createAdminRouter({ discoveryManager: discovery, loadManager, requestHistoryManager: history }),
  )
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1')
    server.once('listening', () => resolve(server))
    server.once('error', reject)
  })
}

describe('admin request detail endpoint', () => {
  it('returns the single request including messageList', async () => {
    const discovery = new DiscoveryManager({ ollamaNodes: [] })
    const history = new RequestHistoryManager()
    const server = await makeServer(discovery, new LoadManager({ maxConcurrentPerNode: 4 }), history)

    history.startRequest({
      requestId: 'req-detail',
      endpointType: 'chat',
      reqBody: { messages: [{ role: 'user', content: 'hello there' }] },
      analysis: {},
    })

    const detail = await get(server, '/admin/requests/req-detail')
    expect(detail.status).toBe(200)
    expect((detail.data as any).requestId).toBe('req-detail')
    expect((detail.data as any).messageList[0].content).toBe('hello there')

    const missing = await get(server, '/admin/requests/nope')
    expect(missing.status).toBe(404)

    server.close()
  })
})

describe('RequestHistoryManager.activeRequestCount', () => {
  it('counts queued/running requests and updates as they finish', () => {
    const history = new RequestHistoryManager()

    history.startRequest({
      requestId: 'a',
      endpointType: 'chat',
      reqBody: { messages: [{ role: 'user', content: 'x' }] },
      analysis: {},
    })
    history.startRequest({
      requestId: 'b',
      endpointType: 'chat',
      reqBody: { messages: [{ role: 'user', content: 'y' }] },
      analysis: {},
    })
    history.startRequest({
      requestId: 'c',
      endpointType: 'chat',
      reqBody: { messages: [{ role: 'user', content: 'z' }] },
      analysis: {},
    })
    expect(history.activeRequestCount()).toBe(3)

    history.finishRequest('a', { status: 'success', responseStatus: 200 })
    expect(history.activeRequestCount()).toBe(2)

    history.finishRequest('b', { status: 'aborted', responseStatus: 0 })
    history.finishRequest('c', { status: 'failed', responseStatus: 503 })
    expect(history.activeRequestCount()).toBe(0)
  })

  it('unknown request ids do not affect the count', () => {
    const history = new RequestHistoryManager()
    history.startRequest({
      requestId: 'only',
      endpointType: 'generate',
      reqBody: { prompt: 'hi' },
      analysis: {},
    })
    history.finishRequest('nope', { status: 'success', responseStatus: 200 })
    expect(history.activeRequestCount()).toBe(1)
  })
})
