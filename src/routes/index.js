// routes/index.js - Orchestrate all route setup
import { setupChatRoutes } from './chat.js'
import { setupEmbeddingsRoutes } from './embeddings.js'
import { setupModelsRoutes } from './models.js'
import { setupAdminRoutes } from './admin.js'

/**
 * Create and attach route handlers to the Express app
 * @param {Express.Application} app - Express application
 * @param {DiscoveryManager} discoveryManager - discovery manager instance
 * @param {LoadManager} loadManager - load manager instance
 * @param {RequestRouter} requestRouter - request router instance
 */
export function createRoutes(
  app,
  discoveryManager,
  loadManager,
  requestRouter,
) {
  setupChatRoutes(app, discoveryManager, loadManager, requestRouter)
  setupEmbeddingsRoutes(app, discoveryManager, loadManager, requestRouter)
  setupModelsRoutes(app, requestRouter)
  setupAdminRoutes(app, discoveryManager, loadManager)
}
