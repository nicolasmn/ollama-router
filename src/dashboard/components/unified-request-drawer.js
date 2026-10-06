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

/** Virtual model aliases that are never real model names and should not be
 * shown as "not found" in the routing section even when the selected model
 * differs from the requested one. */
const VIRTUAL_MODEL_ALIASES = new Set(['auto', 'auto-fast', 'auto-think', 'auto-local'])

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
    this.expandedCandidates = new Set()
  }

  // Re-run microlighter syntax highlighting after lit re-renders the
  // conversation thread (CSS Custom Highlights don't survive DOM updates).
  updated() {
    if (this.open && this.request) {
      this.dispatchEvent(
        new Event('syntax-highlight', { bubbles: true, composed: true }),
      )
    }
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

  // ─── Candidate card ──────────────────────────────────────────────

  renderCandidateCard({ candidate, attempt }, isWinner) {
    const modelName     = candidate?.modelName ?? attempt?.modelName ?? '—'
    const nodeHost      = candidate?.nodeHost  ?? attempt?.nodeHost  ?? ''
    const score         = candidate?.score ?? null
    const requestStatus = this.request?.status
    const inProgress    = requestStatus === 'waiting' || requestStatus === 'running'

    // For the winner card while the request is still in-progress, always use
    // request.status so the badge stays in sync with the panel list. The
    // attempt status can lag behind (e.g. still 'waiting' when the request is
    // already 'running') because attempts are only updated on discrete events.
    // Once the request reaches a terminal state, fall back to attempt.status
    // for the precise per-attempt outcome.
    const status = isWinner && inProgress
      ? requestStatus
      : attempt?.status ?? (isWinner ? requestStatus ?? null : null)

    const key = this.candidateKey(modelName, nodeHost)

    const isOpen = this.expandedCandidates.has(key) ||
      (isWinner && !this.expandedCandidates.has(`__collapsed_${key}`))

    let badgeClass = 'b-muted'
    let badgeLabel = 'Skipped'
    if (isWinner) {
      if (status === 'success')        { badgeClass = 'b-green';  badgeLabel = 'Success' }
      else if (status === 'running')   { badgeClass = 'b-blue';   badgeLabel = 'Running' }
      else if (status === 'waiting')   { badgeClass = 'b-yellow'; badgeLabel = 'Waiting' }
      else if (status)                 { badgeClass = 'b-red';    badgeLabel = fmt.status(status) }
      else                             { badgeClass = 'b-blue';   badgeLabel = 'Selected' }
    } else if (status) {
      if (status === 'success')        { badgeClass = 'b-green';  badgeLabel = 'Success' }
      else if (status === 'capacity')  { badgeClass = 'b-yellow'; badgeLabel = 'Capacity' }
      else                             { badgeClass = 'b-red';    badgeLabel = fmt.status(status) }
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

  // A non-interactive card shown at the end of the list when the originally
  // requested model was not found and the request was rerouted.
  renderMissingModelCard(modelName) {
    return html`
      <div class="cand-card" style="opacity:0.6">
        <div class="cand-header" style="cursor:default">
          <div class="cand-line1">
            <span class="cand-model mono">${modelName}</span>
            <span class="badge b-red">Not found</span>
          </div>
          <div class="cand-line2">
            <span class="cand-ip muted">originally requested — rerouted to auto</span>
          </div>
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
    const selectedModel  = this.request.selectedModel
    const selectedNode   = this.request.selectedNode
    const requestedModel = this.request.requestedModel
    const inProgress     = this.request.status === 'waiting' || this.request.status === 'running'
    // Only show the "not found" card for concrete model names, not virtual
    // aliases like "auto" which are expected to resolve to a different model.
    const wasRerouted = selectedModel && requestedModel &&
      selectedModel !== requestedModel &&
      !VIRTUAL_MODEL_ALIASES.has(requestedModel)

    return html`
      <div class="detail-section">
        <div class="section-title-row">
          <h3>Routing Decision</h3>
          ${rows.length > 1
            ? html`<span class="section-count">${rows.length} candidates</span>`
            : ''}
        </div>
        <div class="candidate-list">
          ${rows.map(({ candidate, attempt }, rowIndex) => {
            const modelName = candidate?.modelName ?? attempt?.modelName
            const nodeHost  = candidate?.nodeHost  ?? attempt?.nodeHost
            // A candidate is the winner when its model+node matches selectedModel/selectedNode.
            // When selectedModel is not yet set (request still in-progress before
            // recordSelection fires), treat the first candidate as winner so the badge
            // correctly reflects the in-progress status instead of showing "Skipped".
            const isWinner = selectedModel
              ? modelName === selectedModel && (!selectedNode || nodeHost === selectedNode)
              : inProgress && rowIndex === 0
            return this.renderCandidateCard({ candidate, attempt }, isWinner)
          })}
          ${wasRerouted ? this.renderMissingModelCard(requestedModel) : ''}
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
          <div class="metadata-row span-all">
            <div class="metadata-col">
              <div class="metadata-label">Model load</div>
              <div class="metadata-value">
                ${r.modelLoadMs > 0 ? fmt.duration(r.modelLoadMs) : '—'}
                ${r.modelLoadMs > 0
                  ? html`<span class="muted">time to load model into memory</span>`
                  : ''}
              </div>
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
