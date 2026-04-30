// routes/index.ts - Mount all sub-routers and setup all app routes
import express from 'express'
import type { Application, Router } from 'express'
import type { DiscoveryManager } from '../discovery-manager.js'
import type { LoadManager } from '../load-manager.js'
import type { RequestRouter } from '../request-router.js'
import type { RequestHistoryManager } from '../request-history.js'

import { createModelsRouter } from './models.js'
import { createAdminRouter } from './admin.js'
import { createChatRouter } from './chat.js'
import { createEmbeddingsRouter } from './embeddings.js'
import { createResponsesRouter } from './responses.js'
import { createMessagesRouter } from './messages.js'
import { setupOllamaInferenceRoutes } from './ollama-inference.js'
import { setupOllamaRoutes } from './ollama.js'

export interface RouteDeps {
  discoveryManager: DiscoveryManager
  loadManager: LoadManager
  requestRouter: RequestRouter
  requestHistoryManager: RequestHistoryManager
}

/** Mount all OpenAI-compatible routes on a Router (for express.use mounting). */
export function createOpenAIRouter(deps: RouteDeps): Router {
  const r = express.Router()
  r.use('/v1/models', createModelsRouter(deps.requestRouter))
  r.use('/v1', createChatRouter(deps))
  r.use('/v1', createEmbeddingsRouter(deps))
  r.use('/v1', createResponsesRouter(deps))
  r.use('/v1', createMessagesRouter(deps))
  r.use('/admin', createAdminRouter(deps))
  return r
}

/** Register all routes on the Express app (including Ollama-native routes). */
export function setupAllRoutes(app: Application, deps: RouteDeps): void {
  app.use(createOpenAIRouter(deps))
  setupOllamaInferenceRoutes(
    app,
    deps.discoveryManager,
    deps.loadManager,
    deps.requestRouter,
    deps.requestHistoryManager,
  )
  setupOllamaRoutes(app, deps.discoveryManager)
}
