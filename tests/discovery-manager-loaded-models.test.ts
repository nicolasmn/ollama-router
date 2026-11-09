// Probe integration: /api/ps populates per-node loaded-model state and learned
// footprints, a failing /api/ps leaves the node reachable, and /admin/inventory
// exposes it all.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockRequest = jest.fn<(...args: any[]) => any>()
jest.unstable_mockModule('undici', () => ({ request: mockRequest }))

const { DiscoveryManager } = await import('../src/discovery-manager.js')
const { LoadManager } = await import('../src/load-manager.js')
const { RequestHistoryManager } = await import('../src/request-history.js')
const { createAdminRouter } = await import('../src/routes/admin.js')
const { parseNodeMemoryGb } = await import('../src/config.js')
const { default: express } = await import('express')
const { NodeInfo, ModelInfo, ModelProfile } = await import('../src/models.js')
const { computeEvictionSignal, FOOTPRINT_DISK_FACTOR } = await import('../src/routing-score.js')

const GB = 1024 ** 3
const HOST = 'http://127.0.0.1:11434'
const EXPIRES = '2026-11-06T12:00:00.000Z'

function reply(statusCode: number, body: unknown) {
  return { statusCode, body: { json: async () => body, dump: async () => {} } }
}

function mockUpstream(ps: () => ReturnType<typeof reply>) {
  mockRequest.mockImplementation(async (url: string) => {
    if (url.endsWith('/api/tags')) {
      return reply(200, {
        models: [
          { name: 'gemma4:e2b-mlx', size: 5.4 * GB, details: { family: 'gemma' } },
          { name: 'gpt-oss:20b', size: 13.8 * GB, details: { family: 'gptoss' } },
        ],
      })
    }
    if (url.endsWith('/api/show')) return reply(200, { capabilities: [] })
    if (url.endsWith('/api/ps')) return ps()
    throw new Error(`unexpected url ${url}`)
  })
}

const psBody = {
  models: [
    { name: 'gemma4:e2b-mlx', model: 'gemma4:e2b-mlx', size: 7.4 * GB, size_vram: 7.4 * GB, expires_at: EXPIRES },
  ],
}

function makeDm() {
  return new DiscoveryManager({
    ollamaNodes: [HOST],
    nodeMemory: parseNodeMemoryGb('127.0.0.1=32'),
  })
}

describe('DiscoveryManager — /api/ps probing', () => {
  beforeEach(() => { mockRequest.mockReset() })

  it('stores loaded models and learns the measured footprint', async () => {
    mockUpstream(() => reply(200, psBody))
    const dm = makeDm()
    await dm.performProbe({ skipPersist: true })
    const node = dm.inventory.get(HOST)!
    expect(node.reachable).toBe(true)
    expect(node.loaded?.models).toEqual([
      { name: 'gemma4:e2b-mlx', size: 7.4 * GB, sizeVram: 7.4 * GB, expiresAt: Date.parse(EXPIRES) },
    ])
    expect(node.loaded!.updatedAt).toBeGreaterThan(0)
    expect(node.models.get('gemma4:e2b-mlx')!.measuredFootprint).toBe(7.4 * GB)
    expect(node.models.get('gpt-oss:20b')!.measuredFootprint).toBe(0)
  })

  it('keeps the node reachable and marks loaded state unknown when /api/ps fails', async () => {
    mockUpstream(() => reply(200, psBody))
    const dm = makeDm()
    await dm.performProbe({ skipPersist: true })
    expect(dm.inventory.get(HOST)!.loaded).not.toBeNull()

    mockUpstream(() => reply(404, {}))
    await dm.performProbe({ skipPersist: true })
    let node = dm.inventory.get(HOST)!
    expect(node.reachable).toBe(true)
    expect(node.loaded).toBeNull()

    mockUpstream(() => { throw new Error('boom') })
    await dm.performProbe({ skipPersist: true })
    node = dm.inventory.get(HOST)!
    expect(node.reachable).toBe(true)
    expect(node.loaded).toBeNull()
    expect(node.models.get('gemma4:e2b-mlx')!.measuredFootprint).toBe(7.4 * GB)
  })

  it('preserves loaded state and learned footprints across mergeInventory', async () => {
    mockUpstream(() => reply(200, psBody))
    const dm = makeDm()
    await dm.performProbe({ skipPersist: true })
    const fresh = new NodeInfo(HOST)
    fresh.models.set('gemma4:e2b-mlx', new ModelInfo('gemma4:e2b-mlx', 'gemma', 5.4 * GB, new ModelProfile()))
    dm.mergeInventory(new Map([[HOST, fresh]]))
    const merged = dm.inventory.get(HOST)!
    expect(merged.loaded?.models).toHaveLength(1)
    expect(merged.models.get('gemma4:e2b-mlx')!.measuredFootprint).toBe(7.4 * GB)
  })

  it('resolves configured memory per node and none for unconfigured or cloud nodes', () => {
    const dm = makeDm()
    expect(dm.getNodeMemory(HOST)).toEqual({ bytes: 32 * GB, source: 'config' })
    expect(dm.getNodeMemory('http://10.1.1.1:11434').bytes).toBeNull()
  })
})

describe('DiscoveryManager.noteModelDispatched', () => {
  beforeEach(() => { mockRequest.mockReset() })

  async function probedDm() {
    mockUpstream(() => reply(200, psBody))
    const dm = makeDm()
    await dm.performProbe({ skipPersist: true })
    return dm
  }

  it('marks a cold model loaded with its estimated footprint, shrinking free memory for the next candidate', async () => {
    const dm = await probedDm()
    const node = dm.inventory.get(HOST)!
    const big = node.models.get('gpt-oss:20b')!
    const next = new ModelInfo('other:8b', 'x', 10 * GB, new ModelProfile())
    const capacity = dm.getNodeMemory(HOST).bytes!
    // 32 GB capacity − 7.4 loaded leaves 24.6 GB: a 13 GB model fits.
    expect(computeEvictionSignal(next, node.models, node.loaded, capacity, false).value).toBe(0)

    dm.noteModelDispatched(HOST, 'gpt-oss:20b')
    const entry = node.loaded!.models.find((m) => m.name === 'gpt-oss:20b')!
    expect(entry.size).toBeCloseTo(big.size * FOOTPRINT_DISK_FACTOR)
    expect(entry.expiresAt).toBeGreaterThan(Date.now())
    // Now 7.4 + 17.9 are used; 6.7 GB left, so the 13 GB model would evict.
    expect(computeEvictionSignal(next, node.models, node.loaded, capacity, false).value).toBeLessThan(0)
  })

  it('bumps lastRoutedAt and does not duplicate an already loaded model', async () => {
    const dm = await probedDm()
    const node = dm.inventory.get(HOST)!
    dm.noteModelDispatched(HOST, 'gemma4:e2b-mlx', 5_000)
    expect(node.models.get('gemma4:e2b-mlx')!.lastRoutedAt).toBe(5_000)
    expect(node.loaded!.models).toHaveLength(1)
  })

  it('leaves unknown loaded state unknown but still bumps lastRoutedAt', () => {
    const dm = makeDm()
    const node = dm.inventory.get(HOST)!
    node.models.set('m', new ModelInfo('m', 'x', GB, new ModelProfile()))
    dm.noteModelDispatched(HOST, 'm', 7_000)
    expect(node.loaded).toBeNull()
    expect(node.models.get('m')!.lastRoutedAt).toBe(7_000)
  })

  it('is a no-op for unknown nodes and models', async () => {
    const dm = await probedDm()
    expect(() => dm.noteModelDispatched('http://ghost:11434', 'x')).not.toThrow()
    expect(() => dm.noteModelDispatched(HOST, 'ghost')).not.toThrow()
  })
})

describe('DiscoveryManager — learning from /api/ps', () => {
  beforeEach(() => { mockRequest.mockReset() })

  it('learns capacity from an eviction across probes and ignores a failed probe in between', async () => {
    const dm = new DiscoveryManager({ ollamaNodes: [HOST] })
    const expires = new Date(Date.now() + 240_000).toISOString()
    const ps = (...names: Array<[string, number]>) => reply(200, {
      models: names.map(([name, gb]) => ({ name, size: gb * GB, size_vram: gb * GB, expires_at: expires })),
    })

    mockUpstream(() => ps(['gemma4:e2b-mlx', 8]))
    await dm.performProbe({ skipPersist: true })
    mockUpstream(() => reply(500, {}))
    await dm.performProbe({ skipPersist: true })
    mockUpstream(() => ps(['gpt-oss:20b', 20]))
    await dm.performProbe({ skipPersist: true })
    expect(dm.getNodeMemory(HOST)).toEqual({ bytes: null, source: null })

    mockUpstream(() => ps(['gemma4:e2b-mlx', 8]))
    await dm.performProbe({ skipPersist: true })
    mockUpstream(() => ps(['gpt-oss:20b', 20]))
    await dm.performProbe({ skipPersist: true })
    // gemma (8) was evicted for gpt-oss (20): 8 + 20 = 28 GB did not fit.
    expect(dm.getNodeMemory(HOST)).toEqual({ bytes: 28 * GB, source: 'learned' })
    expect(dm.getNodeLoadedLimit(HOST)).toBe(3)
  })

  describe('persistence', () => {
    let dir: string
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'loaded-models-')) })
    afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

    it('restores footprints and learned memory after a restart', async () => {
      const metricsFile = join(dir, 'metrics.json')
      mockUpstream(() => reply(200, psBody))
      const first = new DiscoveryManager({ ollamaNodes: [HOST], metricsFile })
      await first.performProbe({ skipPersist: true })
      Object.assign(first.inventory.get(HOST)!.memory, { noFitBytes: 22 * GB, maxLoaded: 2, maxSeenLoaded: 2 })
      first.persistMetrics()

      // The restarted router sees nothing loaded yet.
      mockUpstream(() => reply(200, { models: [] }))
      const second = new DiscoveryManager({ ollamaNodes: [], metricsFile })
      await second.initialize()
      const node = second.inventory.get(HOST)!
      expect(node.models.get('gemma4:e2b-mlx')!.measuredFootprint).toBe(7.4 * GB)
      expect(node.memory).toMatchObject({ fitBytes: 7.4 * GB, noFitBytes: 22 * GB, maxLoaded: 2, maxSeenLoaded: 2 })
      expect(second.getNodeMemory(HOST)).toEqual({ bytes: 22 * GB, source: 'learned' })
      expect(second.getNodeLoadedLimit(HOST)).toBe(2)
      second.stopPeriodicProbe()
    })
  })
})

describe('GET /admin/inventory — loaded-model state', () => {
  beforeEach(() => { mockRequest.mockReset() })

  it('exposes capacity, loaded models, expiry and learned footprints', async () => {
    mockUpstream(() => reply(200, psBody))
    const dm = makeDm()
    await dm.performProbe({ skipPersist: true })

    const app = express()
    app.use(
      '/admin',
      createAdminRouter({
        discoveryManager: dm,
        loadManager: new LoadManager({ maxConcurrentPerNode: 3 }),
        requestHistoryManager: new RequestHistoryManager(),
        dashboardSecret: 'test-secret',
      }),
    )
    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    try {
      const { port } = server.address() as { port: number }
      const data = await new Promise<any>((resolve, reject) => {
        http
          .get(
            { hostname: '127.0.0.1', port, path: '/admin/inventory', headers: { Cookie: 'dashboard_token=test-secret' } },
            (res) => {
              let body = ''
              res.on('data', (c) => { body += c })
              res.on('end', () => resolve(JSON.parse(body)))
            },
          )
          .on('error', reject)
      })
      const node = data.nodes[HOST]
      expect(node.memoryBytes).toBe(32 * GB)
      expect(node.memorySource).toBe('config')
      expect(node.fitBytes).toBe(7.4 * GB)
      expect(node.noFitBytes).toBeNull()
      expect(node.loadedLimit).toBe(3)
      expect(node.loaded.updatedAt).toBeGreaterThan(0)
      expect(node.loaded.models).toEqual([
        { name: 'gemma4:e2b-mlx', size: 7.4 * GB, sizeVram: 7.4 * GB, expiresAt: Date.parse(EXPIRES) },
      ])
      expect(node.models['gemma4:e2b-mlx'].measuredFootprint).toBe(7.4 * GB)
      expect(node.models['gpt-oss:20b'].measuredFootprint).toBe(0)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
