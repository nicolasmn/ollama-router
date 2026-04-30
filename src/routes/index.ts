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

/** OpenAI-compatible routes as a mountable Router. */
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

/** Register all routes directly on the Express app (matches JS createRoutes signature). */
export function createRoutes(
  app: Application,
  discoveryManager: DiscoveryManager,
  loadManager: LoadManager,
  requestRouter: RequestRouter,
  requestHistoryManager: RequestHistoryManager,
): void {
  const deps: RouteDeps = {
    discoveryManager,
    loadManager,
    requestRouter,
    requestHistoryManager,
  }
  app.use(createOpenAIRouter(deps))
  setupOllamaInferenceRoutes(
    app,
    discoveryManager,
    loadManager,
    requestRouter,
    requestHistoryManager,
  )
  setupOllamaRoutes(app, discoveryManager)
}
