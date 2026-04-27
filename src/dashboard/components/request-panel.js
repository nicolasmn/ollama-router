import { LitElement, html } from 'lit'

import {
  MAX_VISIBLE_REQUESTS,
  compactPreview,
  endpointLabel,
  fmt,
  requestMetaItems,
  routeTarget,
  statusClass,
} from './dashboard-utils.js'

function requestSummaryBadges(requests = []) {
  const running = requests.filter(
    (request) => request.status === 'running',
  ).length
  const waiting = requests.filter(
    (request) => request.status === 'waiting',
  ).length
  const failed = requests.filter(
    (request) => request.status === 'failed' || request.status === 'rejected',
  ).length

  return html`
    <span class="badge b-blue">${requests.length} tracked</span>
    <span class="badge ${running > 0 ? 'b-yellow' : ''}"
      >${running} running</span
    >
    <span class="badge ${waiting > 0 ? 'b-yellow' : ''}"
      >${waiting} waiting</span
    >
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

  handleViewMessages(requestId) {
    this.dispatchEvent(
      new CustomEvent('view-messages', {
        detail: { requestId },
        bubbles: true,
        composed: true,
      }),
    )
  }

  toggleCollapsed() {
    this.collapsed = !this.collapsed
    if (!this.collapsed) this.page = 0
  }

  prevPage() {
    this.page = Math.max(0, this.page - 1)
  }

  nextPage(totalPages) {
    this.page = Math.min(totalPages - 1, this.page + 1)
  }

  renderRequestRow(request) {
    const statusBadgeClass =
      request.status === 'success'
        ? 'b-green'
        : request.status === 'waiting'
          ? 'b-yellow'
          : request.status === 'running'
            ? 'b-blue'
            : 'b-red'
    const metaItems = requestMetaItems(request)

    const isActive =
      this.drawerOpen && this.selectedRequestId === request.requestId
    const hasMessages = request.messageList?.length > 0

    return html`
      <div class="request-row ${isActive ? 'active' : ''}">
        <button
          class="request-row-main"
          type="button"
          @click=${() => this.handleSelect(request.requestId)}
        >
          <span class="request-status ${statusClass(request.status)}"></span>
          <span class="request-main">
            <span class="request-topline">
              <span class="badge">${endpointLabel(request.endpointType)}</span>
              <span class="request-route"
                >${request.requestedModel || 'auto'}</span
              >
              <span class="request-target">→ ${routeTarget(request)}</span>
            </span>
            <span class="request-preview"
              >${compactPreview(request.promptPreview)}</span
            >
            <span class="request-meta">
              ${metaItems.map(
                (item, index) => html`
                  ${index > 0
                    ? html`<span class="request-meta-dot"></span>`
                    : ''}
                  <span class="request-meta-item">${item}</span>
                `,
              )}
            </span>
          </span>
          <span class="request-side">
            <span class="request-side-top">
              <span class="badge ${statusBadgeClass}"
                >${fmt.status(request.status)}</span
              >
            </span>
            <span class="request-side-bottom">
              ${request.latency > 0
                ? html`<span class="mono muted"
                    >took ${fmt.duration(request.latency)}</span
                  >`
                : ''}
              <span class="mono muted"
                >${fmt.ago(request.finishedAt || request.createdAt)}</span
              >
            </span>
          </span>
        </button>
        <div class="request-actions">
          <button
            class="request-action-btn"
            type="button"
            title="View details"
            @click=${() => this.handleSelect(request.requestId)}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
          </button>
          ${hasMessages
            ? html`<button
                class="request-action-btn"
                type="button"
                title="View messages"
                @click=${() => this.handleViewMessages(request.requestId)}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path
                    d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
                  ></path>
                </svg>
                ${request.messageList.length}
              </button>`
            : ''}
        </div>
      </div>
    `
  }

  render() {
    const totalPages = Math.max(
      1,
      Math.ceil(this.requests.length / MAX_VISIBLE_REQUESTS),
    )
    // clamp page if requests shrink
    if (this.page >= totalPages) this.page = totalPages - 1
    const start = this.page * MAX_VISIBLE_REQUESTS
    const visibleRequests = this.requests.slice(
      start,
      start + MAX_VISIBLE_REQUESTS,
    )

    return html`
      <section class="requests-shell panel">
        <button
          class="panel-head panel-head--btn"
          type="button"
          @click=${this.toggleCollapsed}
        >
          <div>
            <div class="panel-title">Recent Requests</div>
          </div>
          <div style="display:flex;align-items:center;gap:0.75rem">
            <div class="node-meta">${requestSummaryBadges(this.requests)}</div>
            <span class="panel-collapse-icon"
              >${this.collapsed ? '▸' : '▾'}</span
            >
          </div>
        </button>
        ${this.collapsed
          ? ''
          : html`
              <div class="request-list">
                ${visibleRequests.length
                  ? visibleRequests.map((request) =>
                      this.renderRequestRow(request),
                    )
                  : html`<div class="empty">No requests received yet.</div>`}
              </div>
              ${totalPages > 1
                ? html`
                    <div class="request-pager">
                      <button
                        class="pager-btn"
                        type="button"
                        ?disabled=${this.page === 0}
                        @click=${() => this.prevPage()}
                      >
                        ‹
                      </button>
                      <span class="pager-label"
                        >${this.page + 1} / ${totalPages}</span
                      >
                      <button
                        class="pager-btn"
                        type="button"
                        ?disabled=${this.page === totalPages - 1}
                        @click=${() => this.nextPage(totalPages)}
                      >
                        ›
                      </button>
                    </div>
                  `
                : ''}
            `}
      </section>
    `
  }
}

globalThis.customElements.define('request-panel', RequestPanel)
