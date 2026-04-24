import { html } from 'lit'

export const MAX_VISIBLE_REQUESTS = 10

export const fmt = {
  bytes: (bytes) => (bytes > 0 ? `${(bytes / 1e9).toFixed(1)} GB` : '—'),
  ctx: (value) =>
    !value
      ? '—'
      : value >= 1000
        ? `${(value / 1000).toFixed(0)}k`
        : String(value),
  ms: (value) => {
    if (!value || value <= 0) return '—'
    if (value >= 1000) return `${(value / 1000).toFixed(1)}s`
    return `${Math.round(value)} ms`
  },
  tps: (value) => (value > 0 ? value.toFixed(1) : '—'),
  params: (value) => (value > 0 ? `${value.toFixed(1)}B` : '—'),
  ago: (timestamp) => {
    if (!timestamp) return '—'
    const delta = Date.now() - timestamp
    if (delta < 5000) return 'just now'
    if (delta < 60000) return `${Math.floor(delta / 1000)}s ago`
    if (delta < 3600000) return `${Math.floor(delta / 60000)}m ago`
    return `${Math.floor(delta / 3600000)}h ago`
  },
  status: (status) => {
    if (status === 'success') return 'Success'
    if (status === 'running') return 'Running'
    if (status === 'rejected') return 'Rejected'
    return 'Failed'
  },
}

export function latCls(value) {
  if (!value || value <= 0) return 'muted'
  if (value < 500) return 'good'
  if (value < 2000) return 'warn'
  return 'bad'
}

export function endpointLabel(endpointType) {
  if (endpointType === 'embeddings') return 'Embeddings'
  if (endpointType === 'completions') return 'Completions'
  return 'Chat'
}

export function statusClass(status) {
  if (status === 'running') return 'running'
  if (status === 'success') return 'success'
  if (status === 'rejected') return 'rejected'
  return 'failed'
}

export function routeTarget(request) {
  return request.selectedModel || request.candidates?.[0]?.modelName || '—'
}

export function compactPreview(text) {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!value) return 'No preview'

  const sentenceBreak = value.search(/[.!?]\s/u)
  if (sentenceBreak > 40 && sentenceBreak < 120) {
    return value.slice(0, sentenceBreak + 1)
  }

  if (value.length <= 120) return value
  return `${value.slice(0, 119)}…`
}

export function requestMetaItems(request) {
  const items = []
  if (request.inputSummary) items.push(request.inputSummary)
  if (request.candidateCount > 0) {
    items.push(
      `${request.candidateCount} candidate${request.candidateCount === 1 ? '' : 's'}`,
    )
  }
  if (request.attemptCount > 1) {
    items.push(`${request.attemptCount} attempts`)
  } else if (request.attemptCount === 1 && request.status !== 'running') {
    items.push('1 attempt')
  }
  if (request.stream) items.push('stream')
  return items
}

export function renderCaps(profile = {}) {
  const caps = []
  if (profile.supportsVision) {
    caps.push(html`<span class="cap vision">Vision</span>`)
  }
  if (profile.supportsTools) {
    caps.push(html`<span class="cap tools">Tools</span>`)
  }
  if (profile.supportsThinking) {
    caps.push(html`<span class="cap thinking">Thinking</span>`)
  }
  if (profile.supportsAudio) {
    caps.push(html`<span class="cap audio">Audio</span>`)
  }
  if (profile.isEmbedding) {
    caps.push(html`<span class="cap embedding">Embed</span>`)
  }

  return caps.length
    ? html`<div class="caps">${caps}</div>`
    : html`<span class="muted cap-fallback">text</span>`
}

export function summarizePayload(nodes = []) {
  const allModels = nodes.flatMap((node) => Object.values(node.models || {}))
  const online = nodes.filter((node) => node.reachable).length
  const totalReqs = nodes.reduce(
    (sum, node) => sum + (node.activeRequests || 0),
    0,
  )
  const lats = allModels
    .map((model) => model.recentLatency)
    .filter((value) => value > 0)
  const tpsList = allModels
    .map((model) => model.recentTps)
    .filter((value) => value > 0)
  const avgLat = lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : 0
  const avgTps = tpsList.length
    ? tpsList.reduce((a, b) => a + b, 0) / tpsList.length
    : 0

  return {
    online,
    totalNodes: nodes.length,
    totalModels: allModels.length,
    totalReqs,
    avgLat,
    avgTps,
  }
}
