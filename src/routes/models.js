// models.js - Model catalog endpoints
export function setupModelsRoutes(app, requestRouter) {
  // Alias without /v1 prefix (used by some Letta provider health checks)
  app.get('/models', (req, res) => {
    res.json({ object: 'list', data: requestRouter.getModelCatalog() })
  })

  /**
   * GET /v1/models - OpenAI-style model listing
   */
  app.get('/v1/models', (req, res) => {
    const models = requestRouter.getModelCatalog()

    res.json({
      object: 'list',
      data: models,
    })
  })

  /**
   * GET /v1/models/:model - OpenAI-style model details
   */
  app.get('/v1/models/:model', (req, res) => {
    const model = requestRouter.getModelById(req.params.model)
    if (!model) {
      return res
        .status(404)
        .json({ error: `Model ${req.params.model} not found` })
    }

    return res.json({
      ...model,
      permission: [],
    })
  })
}
