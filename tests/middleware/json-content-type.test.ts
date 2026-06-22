/**
 * Tests for the JSON Content-Type normalization middleware in app.ts.
 *
 * The middleware rewrites any non-JSON Content-Type to application/json for all
 * /api/* and /v1/* POST/PUT/PATCH/DELETE endpoints, except /api/blobs/* which
 * uses raw binary uploads.
 *
 * This ensures curl -d '{...}' (which sends x-www-form-urlencoded or text/plain
 * by default depending on the HTTP client) is parsed correctly by express.json()
 * without requiring an explicit Content-Type header.
 */

import express, { type Request, type Response } from 'express'
import { createServer, type Server } from 'node:http'
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { isJsonOnlyEndpoint } from '../../src/app.js'

// ---------------------------------------------------------------------------
// Mini Express app that mirrors the middleware setup in app.ts
// ---------------------------------------------------------------------------
function buildTestApp() {
  const app = express()

  app.use((req, _res, next) => {
    if (!isJsonOnlyEndpoint(req.path, req.method)) return next()
    const ct = req.headers['content-type'] ?? ''
    if (!ct.startsWith('application/json') && !ct.startsWith('application/ld+json')) {
      req.headers['content-type'] = 'application/json'
    }
    next()
  })

  app.use(express.json({ limit: '1mb' }))

  // Echo the parsed body and resolved content-type back to the caller
  const echo = (req: Request, res: Response) =>
    res.json({ body: req.body, contentType: req.headers['content-type'] })

  app.post('/api/chat', echo)
  app.post('/api/generate', echo)
  app.post('/api/embed', echo)
  app.post('/api/embeddings', echo)
  app.post('/api/pull', echo)
  app.post('/api/push', echo)
  app.post('/api/create', echo)
  app.post('/api/copy', echo)
  app.delete('/api/delete', echo)
  app.post('/api/show', echo)
  app.post('/api/blobs/:digest', echo)
  app.post('/v1/chat/completions', echo)
  app.post('/v1/embeddings', echo)
  app.get('/api/tags', echo)

  return app
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
let server: Server
let baseUrl: string

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server = createServer(buildTestApp())
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number }
        baseUrl = `http://127.0.0.1:${addr.port}`
        resolve()
      })
    }),
)

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const payload = JSON.stringify({ model: 'gemma4:12b', messages: [{ role: 'user', content: 'hi' }] })

async function request(
  method: string,
  path: string,
  body: string,
  contentType?: string,
): Promise<{ body: unknown; contentType: string }> {
  const headers: Record<string, string> = {}
  if (contentType !== undefined) headers['content-type'] = contentType

  const res = await fetch(`${baseUrl}${path}`, { method, headers, body })
  return res.json() as Promise<{ body: unknown; contentType: string }>
}

// ---------------------------------------------------------------------------
// isJsonOnlyEndpoint unit tests
// ---------------------------------------------------------------------------
describe('isJsonOnlyEndpoint()', () => {
  it('returns true for POST /api/chat', () => {
    expect(isJsonOnlyEndpoint('/api/chat', 'POST')).toBe(true)
  })

  it('returns true for POST /api/generate', () => {
    expect(isJsonOnlyEndpoint('/api/generate', 'POST')).toBe(true)
  })

  it('returns true for POST /api/embed', () => {
    expect(isJsonOnlyEndpoint('/api/embed', 'POST')).toBe(true)
  })

  it('returns true for POST /api/embeddings', () => {
    expect(isJsonOnlyEndpoint('/api/embeddings', 'POST')).toBe(true)
  })

  it('returns true for POST /api/pull', () => {
    expect(isJsonOnlyEndpoint('/api/pull', 'POST')).toBe(true)
  })

  it('returns true for POST /api/push', () => {
    expect(isJsonOnlyEndpoint('/api/push', 'POST')).toBe(true)
  })

  it('returns true for POST /api/create', () => {
    expect(isJsonOnlyEndpoint('/api/create', 'POST')).toBe(true)
  })

  it('returns true for POST /api/copy', () => {
    expect(isJsonOnlyEndpoint('/api/copy', 'POST')).toBe(true)
  })

  it('returns true for DELETE /api/delete', () => {
    expect(isJsonOnlyEndpoint('/api/delete', 'DELETE')).toBe(true)
  })

  it('returns true for POST /api/show', () => {
    expect(isJsonOnlyEndpoint('/api/show', 'POST')).toBe(true)
  })

  it('returns true for POST /v1/chat/completions', () => {
    expect(isJsonOnlyEndpoint('/v1/chat/completions', 'POST')).toBe(true)
  })

  it('returns true for POST /v1/embeddings', () => {
    expect(isJsonOnlyEndpoint('/v1/embeddings', 'POST')).toBe(true)
  })

  it('returns false for /api/blobs/:digest (binary upload)', () => {
    expect(isJsonOnlyEndpoint('/api/blobs/sha256:abc123', 'POST')).toBe(false)
  })

  it('returns false for GET /api/tags (no body)', () => {
    expect(isJsonOnlyEndpoint('/api/tags', 'GET')).toBe(false)
  })

  it('returns false for unrelated paths', () => {
    expect(isJsonOnlyEndpoint('/dashboard', 'POST')).toBe(false)
    expect(isJsonOnlyEndpoint('/health', 'GET')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration tests — express middleware + express.json()
// ---------------------------------------------------------------------------

describe('Content-Type normalization — x-www-form-urlencoded (curl -d default)', () => {
  it('parses JSON body on /api/chat', async () => {
    const result = await request('POST', '/api/chat', payload, 'application/x-www-form-urlencoded')
    expect(result.body).toMatchObject({ model: 'gemma4:12b' })
  })

  it('parses JSON body on /api/generate', async () => {
    const result = await request('POST', '/api/generate', payload, 'application/x-www-form-urlencoded')
    expect(result.body).toMatchObject({ model: 'gemma4:12b' })
  })

  it('parses JSON body on /v1/chat/completions', async () => {
    const result = await request('POST', '/v1/chat/completions', payload, 'application/x-www-form-urlencoded')
    expect(result.body).toMatchObject({ model: 'gemma4:12b' })
  })

  it('parses JSON body on DELETE /api/delete', async () => {
    const result = await request('DELETE', '/api/delete', JSON.stringify({ model: 'gemma4:12b' }), 'application/x-www-form-urlencoded')
    expect(result.body).toMatchObject({ model: 'gemma4:12b' })
  })
})

describe('Content-Type normalization — text/plain (Node fetch default for string body)', () => {
  it('parses JSON body on /api/chat', async () => {
    const result = await request('POST', '/api/chat', payload, 'text/plain')
    expect(result.body).toMatchObject({ model: 'gemma4:12b' })
  })

  it('parses JSON body on /api/generate', async () => {
    const result = await request('POST', '/api/generate', payload, 'text/plain')
    expect(result.body).toMatchObject({ model: 'gemma4:12b' })
  })

  it('parses JSON body on /v1/chat/completions', async () => {
    const result = await request('POST', '/v1/chat/completions', payload, 'text/plain')
    expect(result.body).toMatchObject({ model: 'gemma4:12b' })
  })
})

describe('Content-Type normalization — explicit application/json passes through', () => {
  it('parses JSON body on /api/chat', async () => {
    const result = await request('POST', '/api/chat', payload, 'application/json')
    expect(result.body).toMatchObject({ model: 'gemma4:12b' })
    expect(result.contentType).toMatch(/application\/json/)
  })
})

describe('Excluded endpoints — normalization does NOT apply', () => {
  it('does NOT rewrite Content-Type for /api/blobs/* (binary upload)', async () => {
    // Sending JSON payload with x-www-form-urlencoded — should NOT be rewritten,
    // so express.json() won't parse it and body will be empty {}.
    const result = await request(
      'POST',
      '/api/blobs/sha256:abc123',
      payload,
      'application/x-www-form-urlencoded',
    )
    expect((result.body as Record<string, unknown>)['model']).toBeUndefined()
  })
})
