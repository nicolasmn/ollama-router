import { describe, it, expect, afterEach } from '@jest/globals'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadMetrics, saveMetrics } from '../src/metrics-store.js'
import type { PersistedModelMetrics } from '../src/metrics-store.js'

const TMP = join(tmpdir(), `metrics-store-test-${process.pid}`)

function makeTmpPath(name = 'metrics.json'): string {
  return join(TMP, name)
}

type RawModel = Pick<PersistedModelMetrics, 'recentLatency' | 'recentTps' | 'failures'>

function makeNodes(
  entries: Record<string, Record<string, RawModel>>,
): Map<string, { models: Map<string, RawModel> }> {
  const nodes = new Map<string, { models: Map<string, RawModel> }>()
  for (const [host, models] of Object.entries(entries)) {
    nodes.set(host, {
      models: new Map(Object.entries(models).map(([name, metrics]) => [name, metrics])),
    })
  }
  return nodes
}

afterEach(() => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('metrics-store', () => {
  describe('loadMetrics', () => {
    it('returns empty metrics Map when file does not exist', () => {
      const result = loadMetrics(makeTmpPath('nonexistent.json'))
      expect(result.metrics).toBeInstanceOf(Map)
      expect(result.metrics.size).toBe(0)
      expect(result.knownNodes).toEqual([])
    })

    it('returns empty metrics Map for corrupt JSON', () => {
      mkdirSync(TMP, { recursive: true })
      const path = makeTmpPath('corrupt.json')
      writeFileSync(path, '{not valid json}', 'utf8')
      const result = loadMetrics(path)
      expect(result.metrics).toBeInstanceOf(Map)
      expect(result.metrics.size).toBe(0)
    })

    it('returns empty metrics Map for valid JSON with wrong shape', () => {
      mkdirSync(TMP, { recursive: true })
      const path = makeTmpPath('wrong.json')
      writeFileSync(path, JSON.stringify([1, 2, 3]), 'utf8')
      const result = loadMetrics(path)
      expect(result.metrics).toBeInstanceOf(Map)
      expect(result.metrics.size).toBe(0)
    })
  })

  describe('saveMetrics + loadMetrics round-trip', () => {
    it('persists and restores model metrics', () => {
      const path = makeTmpPath()
      const nodes = makeNodes({
        'http://node-a:11434': {
          'gemma4:e4b': { recentLatency: 250, recentTps: 18.5, failures: 0 },
          'gemma4:26b': { recentLatency: 800, recentTps: 6.2, failures: 1 },
        },
        'http://node-b:11434': {
          'nomic-embed-text:latest': { recentLatency: 50, recentTps: 0, failures: 0 },
        },
      })

      saveMetrics(path, nodes as any)
      const { metrics, knownNodes } = loadMetrics(path)

      expect(metrics.size).toBe(2)
      const nodeA = metrics.get('http://node-a:11434')!
      expect(nodeA).toBeInstanceOf(Map)
      expect(nodeA.get('gemma4:e4b')).toEqual({
        recentLatency: 250,
        recentTps: 18.5,
        failures: 0,
        totalRequests: 0,
        lastRoutedAt: 0,
        lastRoutingEndpoint: null,
      })
      expect(nodeA.get('gemma4:26b')).toMatchObject({ recentLatency: 800, failures: 1 })
      expect(knownNodes).toContain('http://node-a:11434')
      expect(knownNodes).toContain('http://node-b:11434')
    })

    it('skips models with all-zero metrics', () => {
      const path = makeTmpPath()
      const nodes = makeNodes({
        'http://node-a:11434': {
          'cold-model': { recentLatency: 0, recentTps: 0, failures: 0 },
          'warm-model': { recentLatency: 300, recentTps: 10, failures: 0 },
        },
      })
      saveMetrics(path, nodes as any)
      const { metrics } = loadMetrics(path)
      const nodeA = metrics.get('http://node-a:11434')!
      expect(nodeA.has('cold-model')).toBe(false)
      expect(nodeA.has('warm-model')).toBe(true)
    })

    it('skips nodes with all-zero-metric models', () => {
      const path = makeTmpPath()
      const nodes = makeNodes({
        'http://node-cold:11434': {
          'model-a': { recentLatency: 0, recentTps: 0, failures: 0 },
        },
      })
      saveMetrics(path, nodes as any)
      const { metrics } = loadMetrics(path)
      expect(metrics.size).toBe(0)
    })

    it('creates directory if it does not exist', () => {
      const path = join(TMP, 'subdir', 'deep', 'metrics.json')
      const nodes = makeNodes({
        'http://node-a:11434': {
          'gemma4:e4b': { recentLatency: 100, recentTps: 5, failures: 0 },
        },
      })
      expect(() => saveMetrics(path, nodes as any)).not.toThrow()
      const { metrics } = loadMetrics(path)
      expect(metrics.size).toBe(1)
    })

    it('overwrites existing file correctly', () => {
      const path = makeTmpPath()
      const nodes1 = makeNodes({
        'http://node-a:11434': {
          'gemma4:e4b': { recentLatency: 100, recentTps: 5, failures: 0 },
        },
      })
      saveMetrics(path, nodes1 as any)

      const nodes2 = makeNodes({
        'http://node-b:11434': {
          'gemma4:26b': { recentLatency: 700, recentTps: 7, failures: 2 },
        },
      })
      saveMetrics(path, nodes2 as any)

      const { metrics } = loadMetrics(path)
      expect(metrics.has('http://node-a:11434')).toBe(false)
      expect(metrics.has('http://node-b:11434')).toBe(true)
    })

    it('persists knownNodes including zero-metric hosts', () => {
      const path = makeTmpPath()
      const nodes = makeNodes({
        'http://node-a:11434': {
          'gemma4:e4b': { recentLatency: 100, recentTps: 5, failures: 0 },
        },
        'http://node-cold:11434': {
          'cold-model': { recentLatency: 0, recentTps: 0, failures: 0 },
        },
      })
      saveMetrics(path, nodes as any)
      const { knownNodes } = loadMetrics(path)
      expect(knownNodes).toContain('http://node-a:11434')
      expect(knownNodes).toContain('http://node-cold:11434')
    })
  })
})
