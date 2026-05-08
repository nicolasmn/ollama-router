// routes/index.ts - Register all routes on the Express app
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Application } from 'express'
import type { DiscoveryManager } from '../discovery-manager.js'
import type { LoadManager } from '../load-manager.js'
import type { RequestRouter } from '../request-router.js'
import type { RequestHistoryManager } from '../request-history.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DASHBOARD_HTML = readFileSync(
  join(__dirname, '..', 'dashboard', 'index.html'),
  'utf8',
)

import { createModelsRouter } from './models.js'
import { createAdminRouter } from './admin.js'
import { setupChatRoutes } from './chat.js'
import { setupEmbeddingsRoutes } from './embeddings.js'
import { setupResponsesRoutes } from './responses.js'
import { setupMessagesRoutes } from './messages.js'
import { setupOllamaInferenceRoutes } from './ollama-inference.js'
import { setupOllamaRoutes } from './ollama.js'

export interface RouteDeps {
  discoveryManager: DiscoveryManager
  loadManager: LoadManager
  requestRouter: RequestRouter
  requestHistoryManager: RequestHistoryManager
}

export function createRoutes(
  app: Application,
  discoveryManager: DiscoveryManager,
  loadManager: LoadManager,
  requestRouter: RequestRouter,
  requestHistoryManager: RequestHistoryManager,
): void {
  app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.send(DASHBOARD_HTML)
  })

  // Health at root level — used by load balancers and orchestrators
  app.get('/health', (_req, res) => {
    const reachableNodes = discoveryManager.getReachableNodeCount()
    const status = reachableNodes > 0 ? 'ok' : 'degraded'
    res.status(reachableNodes > 0 ? 200 : 503).json({ status, reachableNodes })
  })

  app.use('/v1/models', createModelsRouter(requestRouter))
  setupChatRoutes(app, discoveryManager, loadManager, requestRouter, requestHistoryManager)
  setupEmbeddingsRoutes(app, discoveryManager, loadManager, requestRouter, requestHistoryManager)
  setupResponsesRoutes(app, discoveryManager, loadManager, requestRouter, requestHistoryManager)
  setupMessagesRoutes(app, discoveryManager, loadManager, requestRouter, requestHistoryManager)
  setupOllamaInferenceRoutes(app, discoveryManager, loadManager, requestRouter, requestHistoryManager)
  setupOllamaRoutes(app, discoveryManager)
  app.use('/admin', createAdminRouter({ discoveryManager, loadManager, requestHistoryManager }))
}

/** @deprecated use createRoutes */
export function setupAllRoutes(app: Application, deps: RouteDeps): void {
  createRoutes(app, deps.discoveryManager, deps.loadManager, deps.requestRouter, deps.requestHistoryManager)
}
