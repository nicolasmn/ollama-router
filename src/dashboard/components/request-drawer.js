import { LitElement, html } from 'lit'

import { endpointLabel, fmt, routeTarget } from './dashboard-utils.js'

function renderFlagBadges(analysis = {}) {
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

  return badges.length ? badges : html`<span class="muted">No special routing flags</span>`
}

export class RequestDrawer extends LitElement {
  static properties = {
    open: { type: Boolean },
    request: { attribute: false },
  }

  constructor() {
    super()
    this.open = false
    this.request = null
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

  renderRequestDetails() {
    if (!this.request) {
      return html`<div class="empty">Wähle einen Request aus der Liste aus.</div>`
    }

    return html`
      <div class="detail-grid">
        <div class="detail-card">
          <div class="detail-label">Conversation</div>
          <div class="detail-value">
            ${this.request.conversationLabel || 'Single request'}
          </div>
        </div>
        <div class="detail-card">
          <div class="detail-label">Status</div>
          <div class="detail-value">${fmt.status(this.request.status)}</div>
        </div>
        <div class="detail-card">
          <div class="detail-label">Latency</div>
          <div class="detail-value">${fmt.duration(this.request.latency)}</div>
        </div>
        <div class="detail-card">
          <div class="detail-label">Requested Model</div>
          <div class="detail-value mono">
            ${this.request.requestedModel || 'auto'}
          </div>
        </div>
        <div class="detail-card">
          <div class="detail-label">Selected Target</div>
          <div class="detail-value mono">
            ${this.request.selectedModel || routeTarget(this.request)}
          </div>
        </div>
        <div class="detail-card">
          <div class="detail-label">Node</div>
          <div class="detail-value mono">
            ${this.request.selectedNode || '—'}
          </div>
        </div>
        <div class="detail-card">
          <div class="detail-label">HTTP</div>
          <div class="detail-value">${this.request.responseStatus || '—'}</div>
        </div>
        <div class="detail-card">
          <div class="detail-label">Output Tokens</div>
          <div class="detail-value">${this.request.tokensGenerated || 0}</div>
        </div>
      </div>

      <div class="detail-section">
        <h3>Routing Signals</h3>
        <div class="node-meta">
          ${renderFlagBadges(this.request.analysis || {})}
        </div>
        <div class="detail-grid">
          <div class="detail-card">
            <div class="detail-label">Input Summary</div>
            <div class="detail-value">${this.request.inputSummary || '—'}</div>
          </div>
          <div class="detail-card">
            <div class="detail-label">Streaming</div>
            <div class="detail-value">
              ${this.request.stream ? 'yes' : 'no'}
            </div>
          </div>
          <div class="detail-card">
            <div class="detail-label">Estimated Input</div>
            <div class="detail-value">
              ${this.request.analysis?.estimatedInputTokens || 0} tokens
            </div>
          </div>
          <div class="detail-card">
            <div class="detail-label">Max Output</div>
            <div class="detail-value">
              ${this.request.analysis?.maxOutputTokens || 0} tokens
            </div>
          </div>
        </div>
      </div>

      <div class="detail-section">
        <h3>Candidate Ranking</h3>
        <div class="detail-list">
          ${this.request.candidates?.length
            ? this.request.candidates.map(
                (candidate) => html`
                  <div class="detail-row">
                    <div class="detail-row-main">
                      <div class="detail-row-title">${candidate.modelName}</div>
                      <div class="detail-row-sub">
                        ${candidate.nodeHost || 'unknown node'}
                      </div>
                    </div>
                    <div class="mono muted">${candidate.score ?? '—'}</div>
                  </div>
                `,
              )
            : html`<div class="empty">No routing candidates recorded.</div>`}
        </div>
      </div>

      <div class="detail-section">
        <h3>Attempts</h3>
        <div class="detail-list">
          ${this.request.attempts?.length
            ? this.request.attempts.map((attempt) => {
                const statusBadgeClass =
                  attempt.status === 'success'
                    ? 'b-green'
                    : attempt.status === 'capacity'
                      ? 'b-yellow'
                      : 'b-red'
                return html`
                  <div class="detail-row">
                    <div class="detail-row-main">
                      <div class="detail-row-title">${attempt.modelName}</div>
                      <div class="detail-row-sub">
                        ${attempt.nodeHost || 'unknown node'}
                        ${attempt.error ? ` · ${attempt.error}` : ''}
                      </div>
                    </div>
                    <div class="request-side">
                      <span class="badge ${statusBadgeClass}"
                        >${attempt.status}</span
                      >
                      <span class="mono muted"
                        >${fmt.duration(attempt.latency)}</span
                      >
                    </div>
                  </div>
                `
              })
            : html`<div class="empty">No attempt history recorded.</div>`}
        </div>
      </div>

      ${this.request.error
        ? html`
            <div class="detail-section">
              <h3>Error</h3>
              <div class="preview-box">${this.request.error}</div>
            </div>
          `
        : ''}
    `
  }

  render() {
    return html`
      <div class="drawer-shell ${this.open ? 'open' : ''}" aria-hidden=${this.open ? 'false' : 'true'}>
        <div class="drawer-backdrop" @click=${() => this.emitClose()}></div>
        <aside class="drawer">
          <div class="drawer-head">
            <div>
              <div class="drawer-title">Request Details</div>
              <div class="drawer-subtitle">
                ${this.request
                  ? `${endpointLabel(this.request.endpointType)} · ${this.request.requestId}`
                  : 'Wähle einen Request aus der Liste aus.'}
              </div>
            </div>
            <button class="drawer-close" type="button" @click=${() => this.emitClose()}>✕</button>
          </div>
          <div class="drawer-body">${this.renderRequestDetails()}</div>
        </aside>
      </div>
    `
  }
}

globalThis.customElements.define('request-drawer', RequestDrawer)
