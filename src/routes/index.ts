// routes/index.ts - Mount all sub-routers
import express from 'express'
import type { Router } from 'express'
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
import { createOllamaInferenceRouter } from './ollama-inference.js'
import { createOllamaRouter } from './ollama.js'

export interface RouteDeps {
  discoveryManager: DiscoveryManager
  loadManager: LoadManager
  requestRouter: RequestRouter
  requestHistoryManager: RequestHistoryManager
}

export function createRouter(deps: RouteDeps): Router {
  const r = express.Router()

  r.use('/v1/models', createModelsRouter(deps.requestRouter))
  r.use('/v1', createChatRouter(deps))
  r.use('/v1', createEmbeddingsRouter(deps))
  r.use('/v1', createResponsesRouter(deps))
  r.use('/v1', createMessagesRouter(deps))
  r.use('/', createOllamaInferenceRouter(deps))
  r.use('/', createOllamaRouter(deps))
  r.use('/admin', createAdminRouter(deps))

  return r
}
