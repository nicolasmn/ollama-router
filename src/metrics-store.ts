// metrics-store.ts - Persist and restore per-model metrics across restarts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createLogger } from './logger.js'
import type { NodeInfo } from './models.js'

const logger = createLogger('metrics')

export interface PersistedModelMetrics {
  recentLatency: number
  recentTps: number
  failures: number
  totalRequests: number
  lastRoutedAt: number
  lastRoutingEndpoint: string | null
}

type PersistedFile = Record<string, Record<string, PersistedModelMetrics>>

export function loadMetrics(filePath: string): Map<string, Map<string, PersistedModelMetrics>> {
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return new Map()
    }
    const result = new Map<string, Map<string, PersistedModelMetrics>>()
    for (const [host, models] of Object.entries(parsed as PersistedFile)) {
      if (typeof models !== 'object' || models === null) continue
      const modelMap = new Map<string, PersistedModelMetrics>()
      for (const [name, m] of Object.entries(models)) {
        modelMap.set(name, {
          recentLatency: m.recentLatency ?? 0,
          recentTps: m.recentTps ?? 0,
          failures: m.failures ?? 0,
          totalRequests: m.totalRequests ?? 0,
          lastRoutedAt: m.lastRoutedAt ?? 0,
          lastRoutingEndpoint: m.lastRoutingEndpoint ?? null,
        })
      }
      if (modelMap.size > 0) result.set(host, modelMap)
    }
    return result
  } catch {
    return new Map()
  }
}

export function saveMetrics(
  filePath: string,
  nodes: Map<string, Pick<NodeInfo, 'models'>> | Map<string, { models: Map<string, Pick<PersistedModelMetrics, 'recentLatency' | 'recentTps' | 'failures'>> }>,
): void {
  const output: PersistedFile = {}
  for (const [host, node] of nodes) {
    const modelRecord: Record<string, PersistedModelMetrics> = {}
    for (const [name, model] of node.models) {
      const m = model as PersistedModelMetrics & { recentLatency: number; recentTps: number; failures: number }
      if (m.recentLatency === 0 && m.recentTps === 0 && m.failures === 0) continue
      modelRecord[name] = {
        recentLatency: m.recentLatency,
        recentTps: m.recentTps,
        failures: m.failures,
        totalRequests: (m as PersistedModelMetrics).totalRequests ?? 0,
        lastRoutedAt: (m as PersistedModelMetrics).lastRoutedAt ?? 0,
        lastRoutingEndpoint: (m as PersistedModelMetrics).lastRoutingEndpoint ?? null,
      }
    }
    if (Object.keys(modelRecord).length > 0) output[host] = modelRecord
  }
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(output, null, 2), 'utf8')
  } catch (err) {
    logger.error({ err: (err as Error).message, filePath }, 'Failed to save metrics')
  }
}

export class MetricsStore {
  private filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  load(): Map<string, Map<string, PersistedModelMetrics>> {
    return loadMetrics(this.filePath)
  }

  async persist(nodes: Map<string, Pick<NodeInfo, 'models'>>): Promise<void> {
    saveMetrics(this.filePath, nodes)
  }
}
