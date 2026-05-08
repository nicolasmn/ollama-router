import { html } from 'lit'

export const MAX_VISIBLE_REQUESTS = 5

export const fmt = {
  bytes: (bytes) => (bytes > 0 ? `${(bytes / 1e9).toFixed(1)} GB` : '—'),
  ctx: (value) =>
    !value
      ? '—'
      : value >= 1000
        ? `${(value / 1000).toFixed(0)}k`
        : String(value),
  duration: (value) => {
    if (value == null || value < 0) return '—'
    if (value < 1000) return `${value.toFixed(0)}ms`
    if (value < 10000) return `${(value / 1000).toFixed(1)}s`
    if (value < 60000) return `${Math.floor(value / 1000)}s`
    return `${Math.floor(value / 60000)}m ${((value % 60000) / 1000).toFixed(0)}s`
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
    if (status === 'waiting') return 'Waiting'
    if (status === 'running') return 'Running'
    if (status === 'aborted') return 'Aborted'
    if (status === 'capacity') return 'Capacity'
    if (status === 'rejected') return 'Rejected'
    return 'Failed'
  },
}

export function formatAbortReason(reason) {
  if (reason === 'client_disconnect') return 'Client disconnected'
  if (reason === 'upstream_abort') return 'Upstream aborted'
  return reason || 'Unknown'
}

export function formatFailureCategory(category) {
  if (category === 'capacity') return 'Capacity'
  if (category === 'network') return 'Network'
  if (category === 'timeout') return 'Timeout'
  if (category === 'upstream_error') return 'Upstream error'
  if (category === 'client_abort') return 'Client abort'
  return category || 'Unknown'
}

export function formatRetryHint(hint) {
  if (hint === 'retry_now') return 'Retry now'
  if (hint === 'retry_later') return 'Retry in a few seconds'
  if (hint === 'switch_model') return 'Try another model'
  if (hint === 'no_retry') return 'No retry needed'
  return hint || 'No hint'
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
  if (status === 'waiting') return 'waiting'
  if (status === 'running') return 'running'
  if (status === 'success') return 'success'
  if (status === 'rejected') return 'rejected'
  if (status === 'capacity') return 'capacity'
  if (status === 'aborted') return 'aborted'
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
  } else if (
    request.attemptCount === 1 &&
    request.status !== 'running' &&
    request.status !== 'waiting'
  ) {
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

export function renderFlagBadges(analysis = {}) {
  const badges = []
  if (analysis.preferReasoning) {
    badges.push(html`<span class="badge b-yellow">reasoning</span>`)
  }
  if (analysis.preferFast) {
    badges.push(html`<span class="badge b-blue">fast</span>`)
  }
  if (analysis.hasCodeSignals) {
    badges.push(html`<span class="badge">code</span>`)
  }
  if (analysis.needsTools) {
    badges.push(html`<span class="badge b-blue">tools</span>`)
  }
  if (analysis.needsVision) {
    badges.push(html`<span class="badge">vision</span>`)
  }
  if (analysis.needsAudio) {
    badges.push(html`<span class="badge">audio</span>`)
  }
  if (analysis.needsEmbeddings) {
    badges.push(html`<span class="badge b-green">embedding</span>`)
  }

  return badges.length
    ? badges
    : html`<span class="muted">No special routing flags</span>`
}

export function renderMessageThread(request) {
  if (!request) {
    return html`<div class="empty">No request selected.</div>`
  }

  if (!request.messageList?.length) {
    return html`<div class="preview-box">
      ${request.promptPreview || 'No preview available.'}
    </div>`
  }

  return html`
    <div class="message-thread">
      ${request.messageList
        .slice()
        .reverse()
        .map(
          (msg, i) => html`
            <div class="msg msg--${msg.role}">
              <div class="msg-header">
                <span class="msg-avatar msg-avatar--${msg.role}"
                  >${msg.role.charAt(0).toUpperCase()}</span
                >
                <span class="msg-role">${msg.role}</span>
                <span class="msg-index">#${i + 1}</span>
              </div>
              <div class="msg-body">
                ${msg.content || html`<span class="muted">(empty)</span>`}
              </div>
            </div>
          `,
        )}
    </div>
  `
}

export function renderAttemptTimeline(attempts = []) {
  if (!attempts.length) {
    return html`<div class="empty">No attempt history recorded.</div>`
  }

  return html`
    <div class="detail-list">
      ${attempts.map((attempt) => {
        const statusBadgeClass =
          attempt.status === 'success'
            ? 'b-green'
            : attempt.status === 'capacity'
              ? 'b-yellow'
              : 'b-red'
        const statusIcon =
          attempt.status === 'success'
            ? '✓'
            : attempt.status === 'capacity'
              ? '⏳'
              : '✗'
        return html`
          <div class="detail-row">
            <div class="detail-row-main">
              <div class="detail-row-title">
                <span class="attempt-icon">${statusIcon}</span>
                ${attempt.modelName}
              </div>
              <div class="detail-row-sub">
                ${attempt.nodeHost || 'unknown node'}
                ${attempt.error ? ` · ${attempt.error}` : ''}
              </div>
            </div>
            <div class="request-side">
              <span class="badge ${statusBadgeClass}">${attempt.status}</span>
              <span class="mono muted">${fmt.duration(attempt.latency)}</span>
            </div>
          </div>
        `
      })}
    </div>
  `
}
