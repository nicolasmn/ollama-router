import { describe, it, expect, afterEach } from '@jest/globals'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadMetrics, saveMetrics } from '../src/metrics-store.js'

const TMP = join(tmpdir(), `metrics-store-test-${process.pid}`)

function makeTmpPath(name = 'metrics.json') {
  return join(TMP, name)
}

function makeNodes(entries) {
  const nodes = new Map()
  for (const [host, models] of Object.entries(entries)) {
    nodes.set(host, {
      models: new Map(
        Object.entries(models).map(([name, metrics]) => [name, metrics]),
      ),
    })
  }
  return nodes
}

afterEach(() => {
  try {
    rmSync(TMP, { recursive: true, force: true })
  } catch {}
})

describe('metrics-store', () => {
  describe('loadMetrics', () => {
    it('returns empty Map when file does not exist', () => {
      const result = loadMetrics(makeTmpPath('nonexistent.json'))
      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(0)
    })

    it('returns empty Map for corrupt JSON', () => {
      mkdirSync(TMP, { recursive: true })
      const path = makeTmpPath('corrupt.json')
      writeFileSync(path, '{not valid json}', 'utf8')
      const result = loadMetrics(path)
      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(0)
    })

    it('returns empty Map for valid JSON with wrong shape', () => {
      mkdirSync(TMP, { recursive: true })
      const path = makeTmpPath('wrong.json')
      writeFileSync(path, JSON.stringify([1, 2, 3]), 'utf8')
      const result = loadMetrics(path)
      expect(result).toBeInstanceOf(Map)
      expect(result.size).toBe(0)
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
          'nomic-embed-text:latest': {
            recentLatency: 50,
            recentTps: 0,
            failures: 0,
          },
        },
      })

      saveMetrics(path, nodes)
      const loaded = loadMetrics(path)

      expect(loaded.size).toBe(2)
      const nodeA = loaded.get('http://node-a:11434')
      expect(nodeA).toBeInstanceOf(Map)
      expect(nodeA.get('gemma4:e4b')).toEqual({
        recentLatency: 250,
        recentTps: 18.5,
        failures: 0,
        totalRequests: 0,
      })
      expect(nodeA.get('gemma4:26b')).toMatchObject({
        recentLatency: 800,
        failures: 1,
      })
    })

    it('skips models with all-zero metrics', () => {
      const path = makeTmpPath()
      const nodes = makeNodes({
        'http://node-a:11434': {
          'cold-model': { recentLatency: 0, recentTps: 0, failures: 0 },
          'warm-model': { recentLatency: 300, recentTps: 10, failures: 0 },
        },
      })

      saveMetrics(path, nodes)
      const loaded = loadMetrics(path)

      const nodeA = loaded.get('http://node-a:11434')
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

      saveMetrics(path, nodes)
      const loaded = loadMetrics(path)
      expect(loaded.size).toBe(0)
    })

    it('creates directory if it does not exist', () => {
      const path = join(TMP, 'subdir', 'deep', 'metrics.json')
      const nodes = makeNodes({
        'http://node-a:11434': {
          'gemma4:e4b': { recentLatency: 100, recentTps: 5, failures: 0 },
        },
      })

      expect(() => saveMetrics(path, nodes)).not.toThrow()
      const loaded = loadMetrics(path)
      expect(loaded.size).toBe(1)
    })

    it('overwrites existing file correctly', () => {
      const path = makeTmpPath()
      const nodes1 = makeNodes({
        'http://node-a:11434': {
          'gemma4:e4b': { recentLatency: 100, recentTps: 5, failures: 0 },
        },
      })
      saveMetrics(path, nodes1)

      const nodes2 = makeNodes({
        'http://node-b:11434': {
          'gemma4:26b': { recentLatency: 700, recentTps: 7, failures: 2 },
        },
      })
      saveMetrics(path, nodes2)

      const loaded = loadMetrics(path)
      expect(loaded.has('http://node-a:11434')).toBe(false)
      expect(loaded.has('http://node-b:11434')).toBe(true)
    })
  })
})
