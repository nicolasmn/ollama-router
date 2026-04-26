// metrics-store.js - Atomic persistence for model performance metrics
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Load persisted metrics from disk.
 * @param {string} filePath
 * @returns {Map<string, Map<string, {recentLatency: number, recentTps: number, failures: number}>>}
 */
export function loadMetrics(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8')
    const data = JSON.parse(raw)
    const result = new Map()
    for (const [host, models] of Object.entries(data)) {
      if (!models || typeof models !== 'object') continue
      const modelMap = new Map()
      for (const [model, metrics] of Object.entries(models)) {
        modelMap.set(model, {
          recentLatency: Number(metrics?.recentLatency) || 0,
          recentTps: Number(metrics?.recentTps) || 0,
          failures: Number(metrics?.failures) || 0,
          totalRequests: Number(metrics?.totalRequests) || 0,
          lastRoutedAt: Number(metrics?.lastRoutedAt) || 0,
          lastRoutingEndpoint: metrics?.lastRoutingEndpoint || null,
        })
      }
      result.set(host, modelMap)
    }
    return result
  } catch {
    return new Map()
  }
}

/**
 * Save current metrics to disk atomically via write-then-rename.
 * Only models with non-zero metrics are written (skips cold/unused models).
 * @param {string} filePath
 * @param {Map<string, import('./models.js').NodeInfo>} nodes
 */
export function saveMetrics(filePath, nodes) {
  const data = {}
  for (const [host, node] of nodes) {
    const models = {}
    for (const [modelName, modelInfo] of node.models) {
      if (
        modelInfo.recentLatency > 0 ||
        modelInfo.recentTps > 0 ||
        modelInfo.failures > 0 ||
        modelInfo.totalRequests > 0 ||
        modelInfo.lastRoutedAt > 0
      ) {
        models[modelName] = {
          recentLatency: modelInfo.recentLatency,
          recentTps: modelInfo.recentTps,
          failures: modelInfo.failures,
          totalRequests: modelInfo.totalRequests || 0,
          lastRoutedAt: modelInfo.lastRoutedAt || 0,
          lastRoutingEndpoint: modelInfo.lastRoutingEndpoint || null,
        }
      }
    }
    if (Object.keys(models).length > 0) {
      data[host] = models
    }
  }

  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp`
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmpPath, filePath)
}
