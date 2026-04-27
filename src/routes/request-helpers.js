// request-helpers.js - Shared request handling utilities

export function makeRequestId() {
  return Math.random().toString(36).slice(2, 11)
}

export function handleSelectionError(err, res, requestId, contextMessage, logger) {
  if (err?.statusCode === 404 || err?.code === 'MODEL_NOT_FOUND') {
    logger.warn({ requestId, error: err.message }, contextMessage)
    res.status(404).json({ error: err.message })
    return true
  }
  return false
}

function hasNoCandidates(candidates) {
  return !candidates || (Array.isArray(candidates) && candidates.length === 0)
}

function respondNoCandidates(requestId, taskType, res, logger) {
  logger.warn({ requestId, taskType }, 'No suitable models available')
  res.status(503).json({ error: 'No suitable models available' })
}

export async function selectCandidatesOrHandleError({
  requestId,
  reqBody,
  taskType,
  res,
  selectFn,
  selectionErrorMessage,
  logger,
}) {
  try {
    const candidates = await selectFn(reqBody)
    if (hasNoCandidates(candidates)) {
      respondNoCandidates(requestId, taskType, res, logger)
      return null
    }

    return candidates
  } catch (err) {
    const handled = handleSelectionError(
      err,
      res,
      requestId,
      selectionErrorMessage,
      logger,
    )
    if (handled) return null
    throw err
  }
}

/**
 * Forward a request to Ollama
 * @param {string} baseUrl
 * @param {string} modelName
 * @param {Object} reqBody - already-translated Ollama body
 * @param {string} endpoint
 */
export async function forwardRequest(baseUrl, modelName, reqBody, endpoint) {
  const { request } = await import('undici')
  const { INFERENCE_TIMEOUT } = await import('../config.js')
  const resp = await request(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reqBody),
    headersTimeout: INFERENCE_TIMEOUT,
    bodyTimeout: INFERENCE_TIMEOUT,
  })

  if (resp.statusCode === 503) throw new Error('Node busy')
  if (resp.statusCode < 200 || resp.statusCode >= 300) {
    let detail = ''
    try { detail = await resp.body.text() } catch { /* ignore */ }
    throw new Error(`HTTP ${resp.statusCode}${detail ? ': ' + detail : ''}`)
  }

  return resp.body.json()
}
