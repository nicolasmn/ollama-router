// routes/index.js - Orchestrate all route setup
import { setupChatRoutes } from './chat.js'
import { setupEmbeddingsRoutes } from './embeddings.js'
import { setupModelsRoutes } from './models.js'
import { setupAdminRoutes } from './admin.js'
import { setupOllamaRoutes } from './ollama.js'
import { setupResponsesRoutes } from './responses.js'

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
  requestHistoryManager,
) {
  setupChatRoutes(
    app,
    discoveryManager,
    loadManager,
    requestRouter,
    requestHistoryManager,
  )
  setupEmbeddingsRoutes(
    app,
    discoveryManager,
    loadManager,
    requestRouter,
    requestHistoryManager,
  )
  setupResponsesRoutes(
    app,
    discoveryManager,
    loadManager,
    requestRouter,
    requestHistoryManager,
  )
  setupModelsRoutes(app, requestRouter)
  setupAdminRoutes(app, discoveryManager, loadManager)
  setupOllamaRoutes(app, discoveryManager)
}
