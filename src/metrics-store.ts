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

interface PersistedFile {
  knownNodes: string[]
  metrics: Record<string, Record<string, PersistedModelMetrics>>
}

export interface LoadedData {
  knownNodes: string[]
  metrics: Map<string, Map<string, PersistedModelMetrics>>
}

export function loadMetrics(filePath: string): LoadedData {
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as PersistedFile
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { knownNodes: [], metrics: new Map() }
    }

    const knownNodes: string[] = Array.isArray(parsed.knownNodes)
      ? parsed.knownNodes.filter((v) => typeof v === 'string')
      : []

    const metrics = new Map<string, Map<string, PersistedModelMetrics>>()
    if (typeof parsed.metrics === 'object' && parsed.metrics !== null) {
      for (const [host, models] of Object.entries(parsed.metrics)) {
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
        if (modelMap.size > 0) metrics.set(host, modelMap)
      }
    }

    return { knownNodes, metrics }
  } catch {
    return { knownNodes: [], metrics: new Map() }
  }
}

export function saveMetrics(
  filePath: string,
  nodes: Map<string, Pick<NodeInfo, 'models'>>,
): void {
  const metricsOutput: Record<string, Record<string, PersistedModelMetrics>> = {}
  for (const [host, node] of nodes) {
    const modelRecord: Record<string, PersistedModelMetrics> = {}
    for (const [name, model] of node.models) {
      const m = model as unknown as PersistedModelMetrics
      if (m.recentLatency === 0 && m.recentTps === 0 && m.failures === 0) continue
      modelRecord[name] = {
        recentLatency: m.recentLatency,
        recentTps: m.recentTps,
        failures: m.failures,
        totalRequests: m.totalRequests ?? 0,
        lastRoutedAt: m.lastRoutedAt ?? 0,
        lastRoutingEndpoint: m.lastRoutingEndpoint ?? null,
      }
    }
    if (Object.keys(modelRecord).length > 0) metricsOutput[host] = modelRecord
  }

  const output: PersistedFile = {
    knownNodes: Array.from(nodes.keys()),
    metrics: metricsOutput,
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

  load(): LoadedData {
    return loadMetrics(this.filePath)
  }

  persist(nodes: Map<string, Pick<NodeInfo, 'models'>>): void {
    saveMetrics(this.filePath, nodes)
  }
}
