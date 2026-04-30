// routes/index.ts - Register all routes on the Express app
import type { Application } from 'express'
import type { DiscoveryManager } from '../discovery-manager.js'
import type { LoadManager } from '../load-manager.js'
import type { RequestRouter } from '../request-router.js'
import type { RequestHistoryManager } from '../request-history.js'

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
  const adminRouter = createAdminRouter({ discoveryManager, loadManager, requestHistoryManager })

  // Health at root level — used by load balancers and orchestrators
  app.get('/health', (req, res) => adminRouter.handle(req, res, () => {}))

  app.use('/v1/models', createModelsRouter(requestRouter))
  setupChatRoutes(app, discoveryManager, loadManager, requestRouter, requestHistoryManager)
  setupEmbeddingsRoutes(app, discoveryManager, loadManager, requestRouter, requestHistoryManager)
  setupResponsesRoutes(app, discoveryManager, loadManager, requestRouter, requestHistoryManager)
  setupMessagesRoutes(app, discoveryManager, loadManager, requestRouter, requestHistoryManager)
  setupOllamaInferenceRoutes(app, discoveryManager, loadManager, requestRouter, requestHistoryManager)
  setupOllamaRoutes(app, discoveryManager)
  app.use('/admin', adminRouter)
}

/** @deprecated use createRoutes */
export function setupAllRoutes(app: Application, deps: RouteDeps): void {
  createRoutes(app, deps.discoveryManager, deps.loadManager, deps.requestRouter, deps.requestHistoryManager)
}
