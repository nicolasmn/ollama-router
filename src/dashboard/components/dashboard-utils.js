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

export function isCloudRequest(request) {
  if (request.selectedNode && request.selectedNode.includes('ollama.com')) return true
  if (request.selectedModel && request.selectedModel.includes('ollama.com')) return true
  if (request.selectedModel && request.selectedModel.includes('(cloud)')) return true
  if (request.candidates?.some((c) => c.nodeHost?.includes('ollama.com'))) return true
  return request.attempts?.some((a) => a.nodeHost?.includes('ollama.com')) ?? false
}

export function routeTarget(request) {
  const model = request.selectedModel || request.candidates?.[0]?.modelName || '—'
  if (isCloudRequest(request)) {
    return `${model} (cloud)`
  }
  return model
}

export function requestInlineError(request) {
  if (request.status !== 'failed' && request.status !== 'rejected') return null
  if (request.error) return request.error
  const lastAttempt = request.attempts?.[request.attempts.length - 1]
  return lastAttempt?.error || null
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
    : html`<span class="muted">—</span>`
}

// Renders a score breakdown table for a candidate's rationale.
// Used inside cand-detail in the request drawer.
export function renderRoutingRationale(candidate) {
  if (!candidate?.rationale) return ''
  const r = candidate.rationale
  return html`
    <div class="routing-rationale">
      <div class="rationale-row">
        <span class="rationale-label">Size fit</span>
        <span class="rationale-note muted">${r.sizeReason ?? ''}</span>
        <span class="rationale-value ${r.sizeFit > 0 ? 'good' : r.sizeFit < 0 ? 'bad' : ''}">
          ${r.sizeFit > 0 ? `+${r.sizeFit}` : r.sizeFit}
        </span>
      </div>
      <div class="rationale-row">
        <span class="rationale-label">Latency</span>
        <span class="rationale-note"></span>
        <span class="rationale-value">${r.latencyScore.toFixed(1)}</span>
      </div>
      <div class="rationale-row">
        <span class="rationale-label">Throughput</span>
        <span class="rationale-note"></span>
        <span class="rationale-value">${r.tpsScore.toFixed(1)}</span>
      </div>
      ${r.warmBonus
        ? html`<div class="rationale-row">
            <span class="rationale-label">Warm model</span>
            <span class="rationale-note"></span>
            <span class="rationale-value good">+${r.warmBonus}</span>
          </div>`
        : ''}
      ${r.loadPenalty
        ? html`<div class="rationale-row">
            <span class="rationale-label">Load penalty</span>
            <span class="rationale-note"></span>
            <span class="rationale-value bad">−${r.loadPenalty.toFixed(1)}</span>
          </div>`
        : ''}
      ${r.cloudPenalty
        ? html`<div class="rationale-row">
            <span class="rationale-label">Cloud cost</span>
            <span class="rationale-note"></span>
            <span class="rationale-value muted">${r.cloudPenalty}</span>
          </div>`
        : ''}
      ${r.thinkingBonus
        ? html`<div class="rationale-row">
            <span class="rationale-label">Thinking bonus</span>
            <span class="rationale-note"></span>
            <span class="rationale-value good">+${r.thinkingBonus}</span>
          </div>`
        : ''}
      <div class="rationale-row rationale-row--total">
        <span class="rationale-label">Total score</span>
        <span class="rationale-note"></span>
        <span class="rationale-value">${r.totalScore.toFixed(1)}</span>
      </div>
    </div>
  `
}

export function renderMessageThread(request) {
  return renderConversationThread(request)
}

// ─── Conversation Thread Renderer ─────────────────────────────────

function renderTypingIndicator(label = 'Typing') {
  return html`
    <span class="typing-indicator" aria-label="${label}">
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
    </span>
  `
}

function renderContentWithCodeBlocks(content, options = {}) {
  if (!content) {
    return options.showTyping
      ? renderTypingIndicator(options.typingLabel || 'Typing')
      : html`<span class="muted">(empty)</span>`
  }

  const parts = []
  const fencedRegex = /```(\w*)\n?([\s\S]*?)```/g
  let lastIndex = 0
  let match

  while ((match = fencedRegex.exec(content)) !== null) {
    const before = content.slice(lastIndex, match.index)
    if (before) parts.push(renderInlineText(before))
    const lang = match[1] || ''
    const code = match[2]
    parts.push(
      html`<pre class="msg-code-block"><code class="msg-code-lang">${lang
        ? html`<span class="msg-code-label">${lang}</span>`
        : ''}</code><code>${code}</code></pre>`,
    )
    lastIndex = match.index + match[0].length
  }

  const trailing = content.slice(lastIndex)
  if (trailing) parts.push(renderInlineText(trailing))
  return parts
}

function renderInlineText(text) {
  const inlineParts = []
  const inlineRegex = /`([^`]+)`/g
  let lastIdx = 0
  let m

  while ((m = inlineRegex.exec(text)) !== null) {
    const before = text.slice(lastIdx, m.index)
    if (before) inlineParts.push(html`<span class="msg-text">${before}</span>`)
    inlineParts.push(html`<code class="msg-code-inline">${m[1]}</code>`)
    lastIdx = m.index + m[0].length
  }

  const rest = text.slice(lastIdx)
  if (rest) inlineParts.push(html`<span class="msg-text">${rest}</span>`)
  return inlineParts
}

function renderThinkingBlock(thinking, inProgress = false) {
  if (!thinking && !inProgress) return ''
  return html`
    <details class="msg-thinking ${inProgress ? 'is-live' : ''}" ?open=${inProgress}>
      <summary class="msg-thinking-summary">
        <span class="msg-thinking-icon">◆</span>
        Thinking
      </summary>
      <div class="msg-thinking-content">
        ${thinking || renderTypingIndicator('Thinking in progress')}
      </div>
    </details>
  `
}

function renderToolCallBlocks(toolCalls) {
  if (!toolCalls?.length) return ''
  return toolCalls.map((tc) => {
    let prettyArgs = tc.function.arguments
    try {
      prettyArgs = JSON.stringify(JSON.parse(tc.function.arguments), null, 2)
    } catch {
      // keep raw
    }
    return html`
      <div class="msg-tool-call">
        <div class="msg-tool-call-header">
          <span class="msg-tool-call-icon">ƒ</span>
          <span class="msg-tool-call-name">${tc.function.name}</span>
          ${tc.id ? html`<span class="msg-tool-call-id">${tc.id}</span>` : ''}
        </div>
        <pre class="msg-tool-call-args">${prettyArgs}</pre>
      </div>
    `
  })
}

function renderToolResultBlock(msg, allMessages) {
  let fnName = msg.name || ''
  if (!fnName && msg.toolCallId && allMessages) {
    for (const m of allMessages) {
      if (m.toolCalls) {
        const tc = m.toolCalls.find((c) => c.id === msg.toolCallId)
        if (tc) {
          fnName = tc.function.name
          break
        }
      }
    }
  }
  return html`
    <div class="msg-tool-result">
      <div class="msg-tool-result-header">
        <span class="msg-tool-result-icon">↩</span>
        ${fnName
          ? html`<span class="msg-tool-result-name">${fnName}</span>`
          : html`<span class="msg-tool-result-name muted">tool result</span>`}
        ${msg.toolCallId
          ? html`<span class="msg-tool-call-id">${msg.toolCallId}</span>`
          : ''}
      </div>
      <pre class="msg-tool-result-content">${msg.content || html`<span class="muted">(empty)</span>`}</pre>
    </div>
  `
}

function renderMessageBody(msg, allMessages, isLiveAssistant = false) {
  if (msg.role === 'tool') {
    return renderToolResultBlock(msg, allMessages)
  }

  const thinking = renderThinkingBlock(msg.thinking, isLiveAssistant)
  const toolCalls = renderToolCallBlocks(msg.toolCalls)
  const content = renderContentWithCodeBlocks(msg.content, {
    showTyping: isLiveAssistant,
    typingLabel: 'Assistant is typing',
  })

  if (msg.role === 'system' && msg.content?.length > 200) {
    return html`
      ${thinking}
      ${toolCalls}
      <details class="msg-system-details">
        <summary class="msg-system-summary">
          ${msg.content.slice(0, 120).trim()}…
        </summary>
        <div class="msg-body-inner">${content}</div>
      </details>
    `
  }

  return html`${thinking}${toolCalls}<div class="msg-body-inner">${content}</div>`
}

const ROLE_LABELS = {
  system: 'System',
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool',
}

export function renderConversationThread(request) {
  if (!request) {
    return html`<div class="empty">No request selected.</div>`
  }

  if (!request.messageList?.length) {
    return html`<div class="preview-box">
      ${request.promptPreview || 'No preview available.'}
    </div>`
  }

  const messages = request.messageList
  const requestInProgress =
    request.status === 'waiting' || request.status === 'running'

  return html`
    <div class="message-thread">
      ${messages.map(
        (msg, i) => {
          const isLastMessage = i === messages.length - 1
          const isLiveAssistant =
            requestInProgress && isLastMessage && msg.role === 'assistant'

          return html`
          <div class="msg msg--${msg.role}">
            <div class="msg-header">
              <span class="msg-avatar msg-avatar--${msg.role}">
                ${msg.role === 'tool'
                  ? html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>`
                  : msg.role.charAt(0).toUpperCase()}
              </span>
              <span class="msg-role">
                ${ROLE_LABELS[msg.role] ?? msg.role}
              </span>
              ${msg.name ? html`<span class="msg-fn-name">${msg.name}</span>` : ''}
              <span class="msg-index">#${i + 1}</span>
            </div>
            <div class="msg-body">
              ${renderMessageBody(msg, messages, isLiveAssistant)}
            </div>
          </div>
        `
        },
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
