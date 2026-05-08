import { LitElement, html } from 'lit'

import {
  endpointLabel,
  fmt,
  formatAbortReason,
  formatFailureCategory,
  formatRetryHint,
  renderFlagBadges,
  renderConversationThread,
  routeTarget,
} from './dashboard-utils.js'

export class UnifiedRequestDrawer extends LitElement {
  static properties = {
    open: { type: Boolean },
    request: { attribute: false },
    attemptExpanded: { state: true },
  }

  constructor() {
    super()
    this.open = false
    this.request = null
    this.attemptExpanded = false
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

  toggleAttempts() {
    this.attemptExpanded = !this.attemptExpanded
  }

  shouldExpandAttempts() {
    if (!this.request) return false
    // Expand if failed/rejected or 2+ attempts
    return (
      this.request.status === 'failed' ||
      this.request.status === 'rejected' ||
      (this.request.attempts?.length ?? 0) > 1
    )
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
  // Each row joins plan-score + outcome for the same model@node.
  // Orphaned attempts (fallbacks beyond top-N) are appended at the end.
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

  renderRoutingRow({ candidate, attempt }) {
    const modelName = candidate?.modelName ?? attempt?.modelName
    const nodeHost = candidate?.nodeHost ?? attempt?.nodeHost
    const score = candidate?.score ?? null
    const status = attempt?.status ?? null
    const latency = attempt?.latency ?? 0
    const error = attempt?.error ?? null

    const isSelected =
      modelName === this.request.selectedModel &&
      (!this.request.selectedNode || nodeHost === this.request.selectedNode)
    const isFailed =
      status !== null &&
      status !== 'success' &&
      status !== 'running' &&
      status !== 'waiting'
    const isPending = !attempt

    let rowMod = ''
    if (isSelected) rowMod = 'routing-row--selected'
    else if (isFailed) rowMod = 'routing-row--failed'
    else if (isPending) rowMod = 'routing-row--pending'

    const icon = isSelected ? '✓' : isFailed ? '✗' : isPending ? '·' : '↗'
    let iconMod = 'routing-icon--skip'
    if (isSelected) iconMod = 'routing-icon--ok'
    else if (isFailed) iconMod = 'routing-icon--fail'

    let statusBadgeClass = 'b-blue'
    if (status === 'success') statusBadgeClass = 'b-green'
    else if (status === 'capacity') statusBadgeClass = 'b-yellow'
    else if (isFailed) statusBadgeClass = 'b-red'

    return html`
      <div class="routing-row ${rowMod}">
        <span class="routing-icon ${iconMod}">${icon}</span>
        <div class="routing-row-body">
          <div class="routing-row-top">
            <span class="routing-model mono">${modelName}</span>
            ${score !== null
              ? html`<span class="routing-score">${score}</span>`
              : ''}
          </div>
          ${nodeHost || error
            ? html`<div class="routing-row-sub">
                ${nodeHost
                  ? html`<span class="routing-node">${nodeHost}</span>`
                  : ''}
                ${error
                  ? html`<span class="routing-error">${error}</span>`
                  : ''}
              </div>`
            : ''}
        </div>
        <div class="routing-row-right">
          ${status
            ? html`<span class="badge ${statusBadgeClass}">${status}</span>`
            : html`<span class="routing-pending">skipped</span>`}
          ${latency > 0
            ? html`<span class="mono muted">${fmt.duration(latency)}</span>`
            : ''}
        </div>
      </div>
    `
  }

  // MARK: META

  renderCompactMetadata() {
    if (!this.request) {
      return html`<div class="empty">Select a request from the list.</div>`
    }

    return html`
      <div class="metadata-compact">
        <!-- Row 1: Routing Signals | Latency -->
        <div class="metadata-row">
          <div class="metadata-col">
            <div class="metadata-label">Routing Signals</div>
            <div class="metadata-value">
              ${renderFlagBadges(this.request.analysis || {})}
            </div>
          </div>
          <div class="metadata-col">
            <div class="metadata-label">Latency</div>
            <div class="metadata-value">
              ${fmt.duration(this.request.latency)}
              ${this.request.queueWaitMs > 0 || this.request.executionTimeMs > 0
                ? html`<div class="muted" style="margin-top:0.3rem">
                    Queue ${fmt.duration(this.request.queueWaitMs || 0)} · Exec
                    ${fmt.duration(this.request.executionTimeMs || 0)}
                  </div>`
                : ''}
            </div>
          </div>
        </div>

        <!-- Row 2: Tokens | Input -->
        <div class="metadata-row">
          <div class="metadata-col">
            <div class="metadata-label">Tokens out</div>
            <div class="metadata-value">
              ${this.request.tokensGenerated || 0}
            </div>
          </div>
          <div class="metadata-col">
            <div class="metadata-label">Input</div>
            <div class="metadata-value">
              ${this.request.inputSummary || '—'}
            </div>
          </div>
        </div>
      </div>
    `
  }

  renderActionableInsights() {
    if (!this.request) return ''
    const hasAbortReason = Boolean(this.request.abortReason)
    const hasFailureCategory = Boolean(this.request.failureCategory)
    const hasRetryHint = Boolean(this.request.retryHint)
    if (!hasAbortReason && !hasFailureCategory && !hasRetryHint) return ''

    return html`
      <div class="detail-section">
        <h3>Insights</h3>
        <div class="detail-list">
          ${hasAbortReason
            ? html`<div class="detail-row">
                <div class="detail-row-main">
                  <div class="detail-row-title">Abort reason</div>
                  <div class="detail-row-sub">
                    ${formatAbortReason(this.request.abortReason)}
                  </div>
                </div>
              </div>`
            : ''}
          ${hasFailureCategory
            ? html`<div class="detail-row">
                <div class="detail-row-main">
                  <div class="detail-row-title">Failure category</div>
                  <div class="detail-row-sub">
                    ${formatFailureCategory(this.request.failureCategory)}
                  </div>
                </div>
              </div>`
            : ''}
          ${hasRetryHint
            ? html`<div class="detail-row">
                <div class="detail-row-main">
                  <div class="detail-row-title">Recommended action</div>
                  <div class="detail-row-sub">
                    ${formatRetryHint(this.request.retryHint)}
                  </div>
                </div>
              </div>`
            : ''}
        </div>
      </div>
    `
  }

  renderRoutingSection() {
    if (!this.request) return ''

    const candidates = this.request.candidates || []
    const attempts = this.request.attempts || []
    if (!candidates.length && !attempts.length) return ''

    const isExpanded = this.attemptExpanded || this.shouldExpandAttempts()
    const selectedModel = this.selectedModelLabel()
    const selectedNode = this.request.selectedNode || null
    const rows = this.buildRoutingPath(candidates, attempts)
    const failedCount = attempts.filter(
      (a) =>
        a.status !== 'success' &&
        a.status !== 'running' &&
        a.status !== 'waiting',
    ).length

    // MARK: DETAILS

    const statusBadgeClass =
      this.request.status === 'success'
        ? 'b-green'
        : this.request.status === 'running'
          ? 'b-blue'
          : 'b-red'

    return html`
      <div class="detail-section">
          <h3>Routing Decision</h3>
          ${
            rows.length > 1 || failedCount > 0
              ? html`<details>
                  <summary class="selection-toggle-stats">
                    ${rows.length > 1
                      ? html`<span class="selection-stat"
                          >${rows.length} candidates</span
                        >`
                      : ''}
                    ${failedCount > 0
                      ? html`<span class="selection-stat selection-stat--warn"
                          >${failedCount} failed</span
                        >`
                      : ''}
                  </summary>
                  ${
                    // render rows in reverse order, skipping the first one which is the final selection
                    rows
                      .slice(1)
                      .reverse()
                      .map((row) => this.renderRoutingRow(row))
                  }
                </details>`
              : ''
          }
            <div class="selection-toggle-value">
              <span class="mono">${selectedModel}</span>
              ${
                selectedNode
                  ? html`
                      <span class="selection-node">${selectedNode}</span>
                      <span class="selection-status badge ${statusBadgeClass}">
                        ${fmt.status(this.request.status)}
                      </span>
                    `
                  : ''
              }
            </div>
          </div>
      </div>
    `
  }

  renderRequestDetails() {
    if (!this.request) {
      return html`<div class="empty">Select a request from the list.</div>`
    }

    return html`
      ${this.renderRoutingSection()} ${this.renderCompactMetadata()}
      ${this.renderActionableInsights()}

      <div class="detail-section">
        <h3>Conversation</h3>
        ${renderConversationThread(this.request)}
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
            <button
              class="drawer-close"
              type="button"
              @click=${() => this.emitClose()}
            >
              ✕
            </button>
          </div>
          <div class="drawer-body">${this.renderRequestDetails()}</div>
        </aside>
      </div>
    `
  }
}

globalThis.customElements.define('unified-request-drawer', UnifiedRequestDrawer)
