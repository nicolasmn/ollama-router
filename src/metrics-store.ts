// metrics-store.ts - Persist and restore per-model routing metrics across restarts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createLogger } from './logger.js'
import type { NodeInfo } from './models.js'

const logger = createLogger('metrics-store')

export interface PersistedModelMetrics {
  recentLatency: number
  recentTps: number
  failures: number
  totalRequests: number
  lastRoutingEndpoint: string | null
  lastRoutedAt: number
}

/** host -> modelName -> metrics */
export type PersistedMetrics = Map<string, Map<string, PersistedModelMetrics>>

/**
 * Load persisted metrics from a JSON file.
 * Returns an empty Map when the file doesn't exist or is malformed.
 */
export function loadMetrics(filePath: string): PersistedMetrics {
  const result: PersistedMetrics = new Map()
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Record<
      string,
      Record<string, PersistedModelMetrics>
    >
    for (const [host, models] of Object.entries(parsed)) {
      const modelMap = new Map<string, PersistedModelMetrics>()
      for (const [modelName, metrics] of Object.entries(models)) {
        modelMap.set(modelName, metrics)
      }
      result.set(host, modelMap)
    }
    logger.debug({ filePath, hosts: result.size }, 'Metrics loaded')
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      logger.warn({ filePath, err }, 'Failed to load metrics file')
    }
  }
  return result
}

/**
 * Persist current inventory metrics to a JSON file.
 * Creates parent directories if they don't exist.
 */
export function saveMetrics(
  filePath: string,
  inventory: Map<string, NodeInfo>,
): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    const out: Record<string, Record<string, PersistedModelMetrics>> = {}
    for (const [host, node] of inventory) {
      out[host] = {}
      for (const [modelName, model] of node.models) {
        out[host][modelName] = {
          recentLatency: model.recentLatency,
          recentTps: model.recentTps,
          failures: model.failures,
          totalRequests: model.totalRequests,
          lastRoutingEndpoint: model.lastRoutingEndpoint,
          lastRoutedAt: model.lastRoutedAt,
        }
      }
    }
    writeFileSync(filePath, JSON.stringify(out, null, 2), 'utf-8')
    logger.debug({ filePath }, 'Metrics saved')
  } catch (err) {
    logger.warn({ filePath, err }, 'Failed to save metrics')
  }
}
