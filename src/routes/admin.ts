// admin.ts - Internal admin + inventory routes
import express from 'express'
import type { Router } from 'express'
import { request as undiciRequest } from 'undici'
import { timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { IncomingHttpHeaders } from 'node:http'
import type { DiscoveryManager } from '../discovery-manager.js'
import type { LoadManager } from '../load-manager.js'
import type { RequestHistoryManager } from '../request-history.js'
import { forceModelStore } from '../force-model-store.js'
import { disabledModelsStore } from '../disabled-models-store.js'
import { cloudUsageStore } from '../cloud-usage.js'
import { readJsonBody } from '../read-body.js'
import { createLogger } from '../logger.js'

const logger = createLogger('admin')

export interface AdminRouterDeps {
  discoveryManager: DiscoveryManager
  loadManager: LoadManager
  requestHistoryManager: RequestHistoryManager
  /** Dashboard gate cookie value (see routes/index.ts). */
  dashboardSecret: string
}

/** True if the request carries the dashboard session token cookie. */
function isDashboardClient(req: { headers: IncomingHttpHeaders }, secret: string): boolean {
  const header = req.headers.cookie ?? ''
  let sent: string | undefined
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx > 0 && part.slice(0, idx).trim() === 'dashboard_token') sent = part.slice(idx + 1).trim()
  }
  if (!sent || sent.length !== secret.length) return false
  return timingSafeEqual(Buffer.from(sent, 'utf8'), Buffer.from(secret, 'utf8'))
}

export function createAdminRouter({
  discoveryManager,
  loadManager,
  requestHistoryManager,
  dashboardSecret,
}: AdminRouterDeps): Router {
  const r = express.Router()

  r.get('/health', (_req, res) => {
    const reachableNodes = discoveryManager.getReachableNodeCount()
    const status = reachableNodes > 0 ? 'ok' : 'degraded'
    const httpStatus = reachableNodes > 0 ? 200 : 503
    res.status(httpStatus).json({ status, reachableNodes })
  })

  r.get('/inventory', (_req, res) => {
    const nodes = discoveryManager.getNodes()
    const scanStatus = discoveryManager.getScanStatus()
    const reachableCount = discoveryManager.getReachableNodeCount()
    const result: Record<string, unknown> = {
      reachableCount,
      nodeCount: nodes.size,
      nodes: Object.fromEntries(
        Array.from(nodes.entries()).map(([host, node]) => {
          const isCloud = node.cloud ?? false
          return [
            host,
            {
              host: node.host,
              reachable: node.reachable,
              cloud: isCloud,
              lastSeen: node.lastSeen,
              failures: node.failures,
              mac: node.mac,
              activeRequests: loadManager.getCurrentLoad(host),
              // Cloud nodes have no concurrency cap — return null so UI hides the capacity bar
              maxConcurrentRequests: isCloud
                ? null
                : loadManager.getMaxConcurrentPerNode(),
              atCapacity: loadManager.isAtCapacity(host),
              utilization: loadManager.getUtilization(host),
              modelCount: node.models.size,
              models: Object.fromEntries(
                Array.from(node.models.entries()).map(([name, info]) => [
                  name,
                  {
                    name: info.name,
                    family: info.family,
                    size: info.size,
                    profile: info.profile,
                    recentLatency: info.recentLatency,
                    recentTps: info.recentTps,
                    recentTtft: info.recentTtft,
                    recentLoadMs: info.recentLoadMs,
                    systemoneMaxCriteria: info.systemoneMaxCriteria,
                    failures: info.failures,
                    totalRequests: info.totalRequests,
                    lastRoutingEndpoint: info.lastRoutingEndpoint,
                    lastRoutedAt: info.lastRoutedAt,
                    disabled: disabledModelsStore.isDisabled(node.host, name),
                  },
                ]),
              ),
            },
          ]
        }),
      ),
      scan: {
        ...scanStatus,
        autoDiscover: discoveryManager.autoDiscover,
        isNetworkConnected: discoveryManager.isConnectedToNetworkNodes(),
      },
    }
    res.json(result)
  })

  r.delete('/inventory/nodes/:host', (req, res) => {
    const host = decodeURIComponent(req.params.host)
    const node = discoveryManager.getNodes().get(host)
    if (!node) {
      res.status(404).json({ error: 'Node not found' })
      return
    }
    if (node.cloud) {
      res
        .status(403)
        .json({ error: 'Cloud node cannot be removed via this endpoint' })
      return
    }
    discoveryManager.removeNode(host)
    logger.info(
      { host, reachable: node.reachable },
      'Node removed via admin API',
    )
    res.json({ ok: true, host })
  })

  /**
   * POST /admin/inventory/nodes/:host/wake
   * Sends a Wake-on-LAN magic packet to an offline node.
   * Requires the node to have a learned MAC address (comes online at least once).
   */
  r.post('/inventory/nodes/:host/wake', async (req, res) => {
    const host = decodeURIComponent(req.params.host)
    const node = discoveryManager.getNodes().get(host)
    if (!node) {
      res.status(404).json({ error: 'Node not found' })
      return
    }
    if (node.reachable) {
      res.status(409).json({ error: 'Node is already online' })
      return
    }
    if (!node.mac) {
      res.status(422).json({
        error: 'No MAC address known for this node — wait for it to come online at least once',
      })
      return
    }
    try {
      const { sendWakeOnLan } = await import('../wol.js')
      await sendWakeOnLan(node.mac)
      logger.info({ host, mac: node.mac }, 'Wake-on-LAN sent via admin API')
      res.json({ ok: true, host, mac: node.mac })
    } catch (err) {
      logger.error({ host, err: (err as Error).message }, 'Wake-on-LAN failed via admin API')
      res.status(500).json({ error: (err as Error).message })
    }
  })

  r.post('/discovery/scan-now', async (_req, res) => {
    const scanStatus = discoveryManager.getScanStatus()
    if (scanStatus.inProgress) {
      res.status(409).json({ error: 'Scan already in progress' })
      return
    }
    try {
      await discoveryManager.discoverNetworkNodes()
      const nodes = discoveryManager.getNodes()
      const nodeCount = nodes.size
      res.json({
        ok: true,
        nodeCount,
        nodes: Array.from(nodes.keys()),
      })
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Manual scan failed')
      res.status(500).json({ error: 'Scan failed' })
    }
  })

  r.get('/requests', (_req, res) => {
    res.json(requestHistoryManager.getRecentRequests())
  })

  // Single request detail — used by the dashboard drawer to hydrate message
  // threads (the periodic WS broadcast omits messageList to stay cheap).
  // Gated on a per-process token cookie set when the dashboard page is served;
  // see routes/index.ts. Prevents random LAN/local clients from reading the
  // private message threads without first visiting the dashboard.
  r.get('/requests/:requestId', (req, res) => {
    if (!isDashboardClient(req, dashboardSecret)) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    const { requestId } = req.params
    const detail = requestHistoryManager.getRequestDetail(requestId)
    if (!detail) {
      res.status(404).json({ error: 'Request not found' })
      return
    }
    res.json(detail)
  })

  // Captured audio payload for dashboard playback — same dashboard session
  // cookie gate as the request detail endpoint. Serves the binary bytes stored
  // by the audio route under the router data dir.
  r.get('/audio/:requestId', async (req, res) => {
    if (!isDashboardClient(req, dashboardSecret)) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    const { requestId } = req.params
    const entry = requestHistoryManager
      .getRecentRequests()
      .find((r) => r.requestId === requestId)
    const audio = entry?.audio
    if (!entry || !audio?.path) {
      res.status(404).json({ error: 'Audio not found' })
      return
    }
    const stream = createReadStream(audio.path)
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ error: 'Audio not found' })
      else res.destroy()
    })
    res.status(200)
    res.setHeader('Content-Type', audio.contentType || 'audio/wav')
    res.setHeader('Content-Length', audio.bytes)
    stream.pipe(res)
  })

  r.delete('/requests/:requestId', (req, res) => {
    const { requestId } = req.params
    const entry = requestHistoryManager
      .getRecentRequests()
      .find((r) => r.requestId === requestId)
    if (!entry) {
      res.status(404).json({ error: 'Request not found' })
      return
    }
    const activeStatuses = new Set(['waiting', 'running'])
    if (!activeStatuses.has(entry.status)) {
      res.status(409).json({ error: 'Request is not active' })
      return
    }
    const terminated = requestHistoryManager.terminateRequest(requestId)
    if (!terminated) {
      res.status(409).json({ error: 'Request has no active abort handle' })
      return
    }
    logger.info({ requestId }, 'Request terminated via admin API')
    res.json({ ok: true, requestId })
  })

  // ---------------------------------------------------------------------------
  // Per-node model disable/enable
  // ---------------------------------------------------------------------------

  r.put('/inventory/nodes/:host/models/:name', async (req, res) => {
    const host = decodeURIComponent(req.params.host)
    const name = decodeURIComponent(req.params.name)
    const { body } = await readJsonBody(req)
    const disabled = body?.disabled
    if (typeof disabled !== 'boolean') {
      res
        .status(400)
        .json({ error: 'Missing or invalid "disabled" boolean field' })
      return
    }
    const node = discoveryManager.getNodes().get(host)
    if (!node) {
      res.status(404).json({ error: 'Node not found' })
      return
    }
    if (!node.models.has(name)) {
      res.status(404).json({ error: `Model "${name}" not on node` })
      return
    }
    const changed = disabled
      ? disabledModelsStore.disable(host, name)
      : disabledModelsStore.enable(host, name)
    logger.info(
      { host, name, disabled, changed },
      'Model disable state updated',
    )
    res.json({ ok: true, host, name, disabled })
  })

  // ---------------------------------------------------------------------------
  // Force-model override
  // ---------------------------------------------------------------------------

  r.get('/force-model', (_req, res) => {
    const entry = forceModelStore.get()
    res.json(
      entry
        ? { active: true, model: entry.model, expiresAt: entry.expiresAt }
        : { active: false, model: null, expiresAt: null },
    )
  })

  r.post('/force-model', async (req, res) => {
    const { body } = await readJsonBody(req)
    const model = body?.model
    if (!model || typeof model !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "model" field' })
      return
    }

    let resolvedModel: string | null = null
    outer: for (const node of discoveryManager.getNodes().values()) {
      if (!node.reachable) continue
      for (const key of node.models.keys()) {
        if (key === model || key.startsWith(model + ':')) {
          resolvedModel = key
          break outer
        }
      }
    }

    if (!resolvedModel) {
      res.status(404).json({ error: `Model "${model}" not found on any reachable node` })
      return
    }

    forceModelStore.set(resolvedModel)
    const entry = forceModelStore.get()!
    logger.info({ model: resolvedModel, requested: model }, 'Force-model override set via admin API')
    res.json({ ok: true, model: entry.model, expiresAt: entry.expiresAt })
  })

  r.delete('/force-model', (_req, res) => {
    const had = forceModelStore.get() !== null
    forceModelStore.clear()
    logger.info('Force-model override cleared via admin API')
    res.json({ ok: true, cleared: had })
  })

  // ---------------------------------------------------------------------------
  // Cloud model management
  // ---------------------------------------------------------------------------

  r.get('/cloud/models', async (_req, res) => {
    const info = discoveryManager.getCloudInfo()

    if (!info.configured) {
      res.status(503).json({ error: 'Cloud not configured (missing OLLAMA_CLOUD_URL or OLLAMA_CLOUD_API_KEY)' })
      return
    }

    let available: Array<{ name: string; size: number; modified_at: string }> = []
    try {
      const resp = await undiciRequest(`${info.cloudUrl}/api/tags`, {
        headers: { Authorization: `Bearer ${info.cloudApiKey}` },
        headersTimeout: 8000,
        bodyTimeout: 8000,
      })
      if (resp.statusCode === 200) {
        const data = (await resp.body.json()) as { models?: Array<Record<string, unknown>> }
        available = (data.models ?? []).map((m) => ({
          name: m.name as string,
          size: (m.size as number) ?? 0,
          modified_at: (m.modified_at as string) ?? '',
        }))
      } else {
        await resp.body.dump()
        logger.warn({ status: resp.statusCode }, 'ollama.com /api/tags returned non-200')
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Failed to fetch ollama.com /api/tags')
    }

    res.json({
      active: info.models,
      available,
    })
  })

  r.post('/cloud/models', async (req, res) => {
    const info = discoveryManager.getCloudInfo()
    if (!info.configured) {
      res.status(503).json({ error: 'Cloud not configured' })
      return
    }
    const { body } = await readJsonBody(req)
    const name = body?.name
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "name" field' })
      return
    }
    const wasAlreadyActive = discoveryManager.cloudModels.includes(name)
    if (wasAlreadyActive) {
      res.status(409).json({ error: `Model "${name}" already active` })
      return
    }
    discoveryManager.addCloudModel(name)
    logger.info({ name }, 'Cloud model added via admin API')
    res.json({ ok: true, active: discoveryManager.cloudModels })
  })

  r.delete('/cloud/models/:name', (req, res) => {
    const info = discoveryManager.getCloudInfo()
    if (!info.configured) {
      res.status(503).json({ error: 'Cloud not configured' })
      return
    }
    const name = decodeURIComponent(req.params.name)
    const removed = discoveryManager.removeCloudModel(name)
    if (!removed) {
      res.status(404).json({ error: `Model "${name}" not in active list` })
      return
    }
    logger.info({ name }, 'Cloud model removed via admin API')
    res.json({ ok: true, active: discoveryManager.cloudModels })
  })

  // ---------------------------------------------------------------------------
  // Cloud usage
  // ---------------------------------------------------------------------------

  r.get('/cloud/usage', async (_req, res) => {
    const info = discoveryManager.getCloudInfo()
    if (!info.configured) {
      res.status(503).json({ error: 'Cloud not configured' })
      return
    }
    const usage = cloudUsageStore.get()
    if (usage.fetchedAt === 0) {
      try {
        const fresh = await cloudUsageStore.refresh()
        if (fresh.fetchedAt === 0) {
          res.status(503).json({
            error: 'No cloud usage cookie available. Set OLLAMA_CLOUD_SESSION_COOKIE or ensure Chrome is logged in to ollama.com.',
          })
          return
        }
        res.json(fresh)
      } catch (err) {
        res.status(502).json({ error: (err as Error).message })
      }
      return
    }
    res.json(usage)
  })

  return r
}
