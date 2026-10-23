// metrics-store.ts - Persist and restore per-model metrics across restarts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createLogger } from './logger.js'
import type { NodeInfo } from './models.js'

const logger = createLogger('metrics')

export interface PersistedModelMetrics {
  recentLatency: number
  recentTps: number
  recentTtft: number
  recentLoadMs: number
  failures: number
  totalRequests: number
  lastRoutedAt: number
  lastRoutingEndpoint: string | null
}

interface PersistedFile {
  knownNodes: string[]
  cloudModels: string[]
  metrics: Record<string, Record<string, PersistedModelMetrics>>
  nodeMacs?: Record<string, string>
}

export interface LoadedData {
  knownNodes: string[]
  cloudModels: string[]
  metrics: Map<string, Map<string, PersistedModelMetrics>>
  nodeMacs: Map<string, string>
}

export function loadMetrics(filePath: string, cloudUrl?: string): LoadedData {
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as PersistedFile
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { knownNodes: [], cloudModels: [], metrics: new Map(), nodeMacs: new Map() }
    }

    const knownNodes: string[] = Array.isArray(parsed.knownNodes)
      ? parsed.knownNodes
          .filter((v) => typeof v === 'string')
          .filter((v) => !cloudUrl || v !== cloudUrl)
      : []

    const cloudModels: string[] = Array.isArray(parsed.cloudModels)
      ? parsed.cloudModels.filter((v) => typeof v === 'string')
      : []

    const metrics = new Map<string, Map<string, PersistedModelMetrics>>()
    if (typeof parsed.metrics === 'object' && parsed.metrics !== null) {
      for (const [host, models] of Object.entries(parsed.metrics)) {
        if (cloudUrl && host === cloudUrl) continue
        if (typeof models !== 'object' || models === null) continue
        const modelMap = new Map<string, PersistedModelMetrics>()
        for (const [name, m] of Object.entries(models)) {
          modelMap.set(name, {
            recentLatency: m.recentLatency ?? 0,
            recentTps: m.recentTps ?? 0,
            recentTtft: m.recentTtft ?? 0,
            recentLoadMs: m.recentLoadMs ?? 0,
            failures: m.failures ?? 0,
            totalRequests: m.totalRequests ?? 0,
            lastRoutedAt: m.lastRoutedAt ?? 0,
            lastRoutingEndpoint: m.lastRoutingEndpoint ?? null,
          })
        }
        if (modelMap.size > 0) metrics.set(host, modelMap)
      }
    }

    const nodeMacs = new Map<string, string>()
    if (typeof parsed.nodeMacs === 'object' && parsed.nodeMacs !== null) {
      for (const [host, mac] of Object.entries(parsed.nodeMacs)) {
        if (typeof mac === 'string') nodeMacs.set(host, mac)
      }
    }

    return { knownNodes, cloudModels, metrics, nodeMacs }
  } catch {
    return { knownNodes: [], cloudModels: [], metrics: new Map(), nodeMacs: new Map() }
  }
}

export function saveMetrics(
  filePath: string,
  nodes: Map<string, Pick<NodeInfo, 'models' | 'cloud' | 'mac'>>,
  cloudModels: string[] = [],
): void {
  const metricsOutput: Record<string, Record<string, PersistedModelMetrics>> = {}
  for (const [host, node] of nodes) {
    if ((node as NodeInfo).cloud) continue
    const modelRecord: Record<string, PersistedModelMetrics> = {}
    for (const [name, model] of node.models) {
      const m = model as unknown as PersistedModelMetrics
      if (
        (m.recentLatency || 0) === 0 &&
        (m.recentTps || 0) === 0 &&
        (m.recentTtft || 0) === 0 &&
        (m.recentLoadMs || 0) === 0 &&
        (m.failures || 0) === 0
      ) continue
      modelRecord[name] = {
        recentLatency: m.recentLatency,
        recentTps: m.recentTps,
        recentTtft: m.recentTtft ?? 0,
        recentLoadMs: m.recentLoadMs ?? 0,
        failures: m.failures,
        totalRequests: m.totalRequests ?? 0,
        lastRoutedAt: m.lastRoutedAt ?? 0,
        lastRoutingEndpoint: m.lastRoutingEndpoint ?? null,
      }
    }
    if (Object.keys(modelRecord).length > 0) metricsOutput[host] = modelRecord
  }

  const nodeMacsOutput: Record<string, string> = {}
  for (const [host, node] of nodes) {
    if (node.mac) nodeMacsOutput[host] = node.mac
  }

  const output: PersistedFile = {
    knownNodes: Array.from(nodes.entries())
      .filter(([, node]) => !(node as NodeInfo).cloud)
      .map(([host]) => host),
    cloudModels,
    metrics: metricsOutput,
    nodeMacs: nodeMacsOutput,
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
  private cloudUrl: string

  constructor(filePath: string, cloudUrl = '') {
    this.filePath = filePath
    this.cloudUrl = cloudUrl
  }

  load(): LoadedData {
    return loadMetrics(this.filePath, this.cloudUrl)
  }

  persist(nodes: Map<string, Pick<NodeInfo, 'models' | 'cloud' | 'mac'>>, cloudModels: string[] = []): void {
    saveMetrics(this.filePath, nodes, cloudModels)
  }
}
