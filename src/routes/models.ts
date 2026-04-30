// models.ts - /v1/models endpoint
import express from 'express'
import type { Router } from 'express'
import type { RequestRouter } from '../request-router.js'

export function createModelsRouter(requestRouter: RequestRouter): Router {
  const r = express.Router()

  r.get('/', (_req, res) => {
    res.json({ object: 'list', data: requestRouter.getModelCatalog() })
  })

  return r
}
