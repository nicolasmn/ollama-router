import { LitElement, html } from 'lit'

import {
  MAX_VISIBLE_REQUESTS,
  endpointLabel,
  fmt,
  isCloudRequest,
  requestInlineError,
  requestMetaItems,
  requestPreviewText,
  routeTarget,
  statusClass,
} from './dashboard-utils.js'

function requestSummaryBadges(requests = []) {
  const running = requests.filter((r) => r.status === 'running').length
  const waiting = requests.filter((r) => r.status === 'waiting').length
  const failed = requests.filter(
    (r) => r.status === 'failed' || r.status === 'rejected',
  ).length

  return html`
    <span class="badge b-blue">${requests.length} tracked</span>
    <span class="badge ${running > 0 ? 'b-yellow' : ''}">${running} running</span>
    <span class="badge ${waiting > 0 ? 'b-yellow' : ''}">${waiting} waiting</span>
    <span class="badge ${failed > 0 ? 'b-red' : ''}">${failed} failed</span>
  `
}

export class RequestPanel extends LitElement {
  static properties = {
    requests: { attribute: false },
    selectedRequestId: { attribute: false },
    drawerOpen: { type: Boolean },
    collapsed: { state: true },
    page: { state: true },
  }

  constructor() {
    super()
    this.requests = []
    this.selectedRequestId = null
    this.drawerOpen = false
    this.collapsed = false
    this.page = 0
  }

  createRenderRoot() {
    return this
  }

  handleSelect(requestId) {
    this.dispatchEvent(
      new CustomEvent('request-selected', {
        detail: { requestId },
        bubbles: true,
        composed: true,
      }),
    )
  }

  async handleTerminate(requestId, event) {
    event.stopPropagation()
    try {
      await fetch(`/admin/requests/${encodeURIComponent(requestId)}`, { method: 'DELETE' })
    } catch {
      // ignore — dashboard will reflect the change on next WS update
    }
  }

  toggleCollapsed() {
    this.collapsed = !this.collapsed
    if (!this.collapsed) this.page = 0
  }

  prevPage() { this.page = Math.max(0, this.page - 1) }
  nextPage(totalPages) { this.page = Math.min(totalPages - 1, this.page + 1) }

  renderRequestRow(request) {
    const isRunningOrWaiting = request.status === 'running' || request.status === 'waiting'
    const statusBadgeClass =
      request.status === 'success' ? 'b-green'
      : request.status === 'waiting' ? 'b-yellow'
      : request.status === 'running' ? 'b-blue'
      : 'b-red'
    const metaItems = requestMetaItems(request)
    const liveWaitMs =
      request.status === 'waiting'
        ? Math.max(0, Date.now() - (request.createdAt || Date.now()))
        : 0
    const isActive = this.drawerOpen && this.selectedRequestId === request.requestId
    const cloud = isCloudRequest(request)
    const inlineError = requestInlineError(request)

    return html`
      <div class="request-row ${isActive ? 'active' : ''}">
        <button
          class="request-row-main"
          type="button"
          @click=${() => this.handleSelect(request.requestId)}
        >
          <!-- Status dot -->
          <span class="request-status ${statusClass(request.status)}"></span>

          <!-- Main content -->
          <span class="request-main">
            <span class="request-topline">
              <span class="badge">${endpointLabel(request.endpointType)}</span>
              ${cloud ? html`<span class="badge b-blue" title="Routed to ollama.com cloud">☁ cloud</span>` : ''}
              <span class="request-route">${request.requestedModel || 'auto'}</span>
              <span class="mono request-target">→ ${routeTarget(request)}</span>
            </span>
            ${inlineError
              ? html`<span class="request-inline-error" title=${inlineError}>${
                  inlineError.length > 80 ? inlineError.slice(0, 79) + '…' : inlineError
                }</span>`
              : html`<span class="request-preview">${requestPreviewText(request)}</span>`}
            <span class="request-meta">
              ${metaItems.map((item, i) => html`
                ${i > 0 ? html`<span class="request-meta-dot"></span>` : ''}
                <span class="request-meta-item">${item}</span>
              `)}
            </span>
          </span>

          <!-- Side: badge + timing -->
          <span class="request-side">
            <span class="request-side-top">
              <span class="badge ${statusBadgeClass}">${fmt.status(request.status)}</span>
            </span>
            <span class="request-side-bottom">
              ${liveWaitMs > 0
                ? html`<span class="mono muted">waiting ${fmt.duration(liveWaitMs)}</span>`
                : ''}
              ${request.queueWaitMs > 0 && request.status !== 'waiting'
                ? html`<span class="mono muted">queue ${fmt.duration(request.queueWaitMs)}</span>`
                : ''}
              ${request.latency > 0
                ? html`<span class="mono muted">took ${fmt.duration(request.latency)}</span>`
                : ''}
              <span class="mono muted">${fmt.ago(request.finishedAt || request.createdAt)}</span>
            </span>
          </span>
        </button>

        ${isRunningOrWaiting
          ? html`
              <button
                class="request-terminate-btn"
                type="button"
                title="Terminate request"
                @click=${(e) => this.handleTerminate(request.requestId, e)}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2.5"
                  stroke-linecap="round" stroke-linejoin="round"
                  aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            `
          : ''}
      </div>
    `
  }

  render() {
    const totalPages = Math.max(1, Math.ceil(this.requests.length / MAX_VISIBLE_REQUESTS))
    if (this.page >= totalPages) this.page = totalPages - 1
    const start = this.page * MAX_VISIBLE_REQUESTS
    const visibleRequests = this.requests.slice(start, start + MAX_VISIBLE_REQUESTS)

    return html`
      <section class="requests-shell panel">
        <!--
          Panel head mirrors node-card header layout:
            row 1: [title .................. chevron]
            row 2: [badges                         ]
        -->
        <button
          class="panel-head panel-head--btn"
          type="button"
          @click=${this.toggleCollapsed}
        >
          <div class="panel-head-inner">
            <div class="panel-head-top">
              <span class="panel-title">Recent Requests</span>
              <span
                class="panel-collapse-icon"
                style="transform:rotate(${this.collapsed ? '-90deg' : '0deg'})"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round"
                  aria-hidden="true">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </span>
            </div>
            <div class="panel-head-badges">
              ${requestSummaryBadges(this.requests)}
            </div>
          </div>
        </button>

        ${this.collapsed ? '' : html`
          <div class="request-list">
            ${visibleRequests.length
              ? visibleRequests.map((r) => this.renderRequestRow(r))
              : html`<div class="empty">No requests received yet.</div>`}
          </div>
          ${totalPages > 1 ? html`
            <div class="request-pager">
              <button class="pager-btn" type="button"
                ?disabled=${this.page === 0}
                @click=${() => this.prevPage()}>&#8249;</button>
              <span class="pager-label">${this.page + 1} / ${totalPages}</span>
              <button class="pager-btn" type="button"
                ?disabled=${this.page === totalPages - 1}
                @click=${() => this.nextPage(totalPages)}>&#8250;</button>
            </div>
          ` : ''}
        `}
      </section>
    `
  }
}

globalThis.customElements.define('request-panel', RequestPanel)
