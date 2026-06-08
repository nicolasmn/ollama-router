import { LitElement, html } from 'lit'

import {
  endpointLabel,
  fmt,
  formatAbortReason,
  formatFailureCategory,
  formatRetryHint,
  renderFlagBadges,
  renderConversationThread,
  renderRoutingRationale,
  routeTarget,
} from './dashboard-utils.js'

export class UnifiedRequestDrawer extends LitElement {
  static properties = {
    open: { type: Boolean },
    request: { attribute: false },
    expandedCandidates: { state: true },
  }

  constructor() {
    super()
    this.open = false
    this.request = null
    // Set of candidate keys (modelName@nodeHost) that are expanded
    this.expandedCandidates = new Set()
  }

  createRenderRoot() {
    return this
  }

  emitClose() {
    this.dispatchEvent(
      new CustomEvent('drawer-close', {
        bubbles: true,
        composed: true,
      }),
    )
  }

  async handleTerminate() {
    if (!this.request) return
    try {
      await fetch(`/admin/requests/${encodeURIComponent(this.request.requestId)}`, { method: 'DELETE' })
    } catch {
      // ignore — dashboard will reflect change on next WS update
    }
  }

  candidateKey(modelName, nodeHost) {
    return `${modelName}@${nodeHost}`
  }

  toggleCandidate(key) {
    const next = new Set(this.expandedCandidates)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    this.expandedCandidates = next
  }

  selectedModelLabel() {
    if (!this.request) return '—'
    return (
      this.request.selectedModel ||
      this.request.candidates?.[0]?.modelName ||
      routeTarget(this.request)
    )
  }

  // Merge candidates (router's scored plan) with attempts (actual execution).
  buildRoutingPath(candidates, attempts) {
    const usedAttempts = new Set()
    const rows = candidates.map((candidate) => {
      const idx = attempts.findIndex(
        (a, i) =>
          !usedAttempts.has(i) &&
          a.modelName === candidate.modelName &&
          a.nodeHost === candidate.nodeHost,
      )
      const attempt = idx !== -1 ? attempts[idx] : null
      if (idx !== -1) usedAttempts.add(idx)
      return { candidate, attempt }
    })
    const orphans = attempts
      .filter((_, i) => !usedAttempts.has(i))
      .map((attempt) => ({ candidate: null, attempt }))
    return [...rows, ...orphans]
  }

  selectedCandidate() {
    if (!this.request) return null
    const candidates = this.request.candidates || []
    const selectedModel = this.request.selectedModel
    const selectedNode = this.request.selectedNode
    if (!selectedModel) return candidates[0] ?? null
    return (
      candidates.find(
        (c) =>
          c.modelName === selectedModel &&
          (!selectedNode || c.nodeHost === selectedNode),
      ) ?? candidates[0] ?? null
    )
  }

  // ─── Candidate card ───────────────────────────────────────────────

  renderCandidateCard({ candidate, attempt }, isWinner) {
    const modelName = candidate?.modelName ?? attempt?.modelName ?? '—'
    const nodeHost  = candidate?.nodeHost  ?? attempt?.nodeHost  ?? ''
    const score     = candidate?.score ?? null
    const status    = attempt?.status ?? null
    const key       = this.candidateKey(modelName, nodeHost)

    // Winner card is open by default (first render only — user can collapse)
    const isOpen = this.expandedCandidates.has(key) ||
      (isWinner && !this.expandedCandidates.has(`__collapsed_${key}`))

    let badgeClass = 'b-muted'
    let badgeLabel = 'Skipped'
    if (isWinner) {
      if (status === 'success')        { badgeClass = 'b-green'; badgeLabel = 'Success' }
      else if (status === 'running')   { badgeClass = 'b-blue';  badgeLabel = 'Running' }
      else if (status === 'waiting')   { badgeClass = 'b-blue';  badgeLabel = 'Waiting' }
      else if (status)                 { badgeClass = 'b-red';   badgeLabel = fmt.status(status) }
      else                             { badgeClass = 'b-blue';  badgeLabel = 'Selected' }
    } else if (status) {
      if (status === 'success')        { badgeClass = 'b-green'; badgeLabel = 'Success' }
      else if (status === 'capacity')  { badgeClass = 'b-yellow'; badgeLabel = 'Capacity' }
      else                             { badgeClass = 'b-red';   badgeLabel = fmt.status(status) }
    }

    const scoreDetail = candidate?.rationale
      ? renderRoutingRationale(candidate)
      : score !== null
        ? html`<div class="cand-score-only">${score.toFixed(1)}</div>`
        : ''

    return html`
      <div class="cand-card ${isWinner ? 'winner' : ''} ${isOpen ? 'open' : ''}">
        <div class="cand-header"
          @click=${() => {
            if (isWinner && !this.expandedCandidates.has(key)) {
              // First click on winner: mark it manually collapsed
              this.expandedCandidates = new Set([...this.expandedCandidates, `__collapsed_${key}`])
            }
            this.toggleCandidate(key)
          }}
        >
          <div class="cand-line1">
            <span class="cand-model mono">${modelName}</span>
            <span class="badge ${badgeClass}">${badgeLabel}</span>
          </div>
          <div class="cand-line2">
            <span class="cand-ip">${nodeHost}</span>
            <div class="cand-meta">
              ${score !== null
                ? html`<span class="cand-score-label">score</span>
                       <span class="cand-score-val ${isWinner ? 'winner' : ''}">${score.toFixed(1)}</span>`
                : ''}
              <span class="cand-expand">▸</span>
            </div>
          </div>
        </div>
        <div class="cand-detail">
          ${scoreDetail}
        </div>
      </div>
    `
  }

  // ─── Routing section ──────────────────────────────────────────────

  renderRoutingSection() {
    if (!this.request) return ''
    const candidates = this.request.candidates || []
    const attempts   = this.request.attempts   || []
    if (!candidates.length && !attempts.length) return ''

    const rows = this.buildRoutingPath(candidates, attempts)
    const selectedModel = this.request.selectedModel
    const selectedNode  = this.request.selectedNode

    return html`
      <div class="detail-section">
        <div class="section-title-row">
          <h3>Routing Decision</h3>
          ${rows.length > 1
            ? html`<span class="section-count">${rows.length} candidates</span>`
            : ''}
        </div>
        <div class="candidate-list">
          ${rows.map(({ candidate, attempt }) => {
            const modelName = candidate?.modelName ?? attempt?.modelName
            const nodeHost  = candidate?.nodeHost  ?? attempt?.nodeHost
            const isWinner  = modelName === selectedModel &&
              (!selectedNode || nodeHost === selectedNode)
            return this.renderCandidateCard({ candidate, attempt }, isWinner)
          })}
        </div>
      </div>
    `
  }

  // ─── Execution (metadata) ─────────────────────────────────────────

  renderExecutionSection() {
    if (!this.request) return ''
    const r = this.request
    return html`
      <div class="detail-section">
        <h3>Execution</h3>
        <div class="metadata-compact">
          <div class="metadata-row">
            <div class="metadata-col">
              <div class="metadata-label">Latency</div>
              <div class="metadata-value">
                ${fmt.duration(r.latency)}
                ${r.queueWaitMs > 0 || r.executionTimeMs > 0
                  ? html`<div class="muted" style="margin-top:0.3rem">
                      Queue ${fmt.duration(r.queueWaitMs || 0)} · Exec
                      ${fmt.duration(r.executionTimeMs || 0)}
                    </div>`
                  : ''}
              </div>
            </div>
            <div class="metadata-col">
              <div class="metadata-label">Signals</div>
              <div class="metadata-value">
                ${renderFlagBadges(r.analysis || {})}
              </div>
            </div>
          </div>
          <div class="metadata-row">
            <div class="metadata-col">
              <div class="metadata-label">Tokens in</div>
              <div class="metadata-value">${r.tokensPrompt ?? '—'}</div>
            </div>
            <div class="metadata-col">
              <div class="metadata-label">Tokens out</div>
              <div class="metadata-value">${r.tokensGenerated ?? 0}</div>
            </div>
          </div>
          <div class="metadata-row">
            <div class="metadata-col">
              <div class="metadata-label">Input</div>
              <div class="metadata-value">${r.inputSummary || '—'}</div>
            </div>
            <div class="metadata-col">
              <div class="metadata-label">Stream</div>
              <div class="metadata-value">${r.stream ? 'Yes' : 'No'}</div>
            </div>
          </div>
        </div>
      </div>
    `
  }

  // ─── Actionable insights ──────────────────────────────────────────

  renderActionableInsights() {
    if (!this.request) return ''
    const hasAbortReason      = Boolean(this.request.abortReason)
    const hasFailureCategory  = Boolean(this.request.failureCategory)
    const hasRetryHint        = Boolean(this.request.retryHint)
    if (!hasAbortReason && !hasFailureCategory && !hasRetryHint) return ''

    return html`
      <div class="detail-section">
        <h3>Insights</h3>
        <div class="detail-list">
          ${hasAbortReason
            ? html`<div class="detail-row">
                <div class="detail-row-main">
                  <div class="detail-row-title">Abort reason</div>
                  <div class="detail-row-sub">${formatAbortReason(this.request.abortReason)}</div>
                </div>
              </div>`
            : ''}
          ${hasFailureCategory
            ? html`<div class="detail-row">
                <div class="detail-row-main">
                  <div class="detail-row-title">Failure category</div>
                  <div class="detail-row-sub">${formatFailureCategory(this.request.failureCategory)}</div>
                </div>
              </div>`
            : ''}
          ${hasRetryHint
            ? html`<div class="detail-row">
                <div class="detail-row-main">
                  <div class="detail-row-title">Recommended action</div>
                  <div class="detail-row-sub">${formatRetryHint(this.request.retryHint)}</div>
                </div>
              </div>`
            : ''}
        </div>
      </div>
    `
  }

  // ─── Main render ──────────────────────────────────────────────────

  renderRequestDetails() {
    if (!this.request) {
      return html`<div class="empty">Select a request from the list.</div>`
    }

    return html`
      ${this.renderRoutingSection()}
      ${this.renderExecutionSection()}
      ${this.renderActionableInsights()}

      <div class="detail-section">
        <h3>Conversation</h3>
        <div class="conversation-scroll">
          ${renderConversationThread(this.request)}
        </div>
      </div>

      ${this.request.error
        ? html`
            <div class="detail-section error-section">
              <h3>Error</h3>
              <div class="preview-box error-box">${this.request.error}</div>
            </div>
          `
        : ''}
    `
  }

  render() {
    const isActive = this.request &&
      (this.request.status === 'running' || this.request.status === 'waiting')
    return html`
      <div
        class="drawer-shell ${this.open ? 'open' : ''}"
        aria-hidden=${this.open ? 'false' : 'true'}
      >
        <div class="drawer-backdrop" @click=${() => this.emitClose()}></div>
        <aside class="drawer">
          <div class="drawer-head">
            <div>
              <div class="drawer-title">Request Details</div>
              <div class="drawer-subtitle">
                ${this.request
                  ? `${endpointLabel(this.request.endpointType)} · ${this.request.requestId}`
                  : 'Select a request from the list.'}
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:0.5rem">
              ${isActive
                ? html`<button
                    class="drawer-terminate-btn"
                    type="button"
                    title="Terminate this request"
                    @click=${() => this.handleTerminate()}
                  >Terminate</button>`
                : ''}
              <button
                class="drawer-close"
                type="button"
                @click=${() => this.emitClose()}
              >✕</button>
            </div>
          </div>
          <div class="drawer-body">${this.renderRequestDetails()}</div>
        </aside>
      </div>
    `
  }
}

globalThis.customElements.define('unified-request-drawer', UnifiedRequestDrawer)
