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
  const failed = requests.filter(
    (request) => request.status === 'failed' || request.status === 'rejected',
  ).length

  return html`
    <span class="badge b-blue">${requests.length} tracked</span>
    <span class="badge ${running > 0 ? 'b-yellow' : ''}"
      >${running} running</span
    >
    <span class="badge ${failed > 0 ? 'b-red' : ''}">${failed} failed</span>
  `
}

export class RequestPanel extends LitElement {
  static properties = {
    requests: { attribute: false },
    selectedRequestId: { attribute: false },
    drawerOpen: { type: Boolean },
  }

  constructor() {
    super()
    this.requests = []
    this.selectedRequestId = null
    this.drawerOpen = false
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

  renderRequestRow(request) {
    const statusBadgeClass =
      request.status === 'success'
        ? 'b-green'
        : request.status === 'running'
          ? 'b-blue'
          : 'b-red'
    const metaItems = requestMetaItems(request)

    return html`
      <button
        class="request-row ${this.drawerOpen &&
        this.selectedRequestId === request.requestId
          ? 'active'
          : ''}"
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
                ${index > 0 ? html`<span class="request-meta-dot"></span>` : ''}
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
                  >took ${fmt.ms(request.latency)}</span
                >`
              : ''}
            <span class="mono muted"
              >${fmt.ago(request.finishedAt || request.createdAt)}</span
            >
          </span>
        </span>
      </button>
    `
  }

  render() {
    const visibleRequests = this.requests.slice(0, MAX_VISIBLE_REQUESTS)

    return html`
      <section class="requests-shell panel">
        <div class="panel-head">
          <div class="panel-title">Recent Requests</div>
          <div class="node-meta">${requestSummaryBadges(this.requests)}</div>
        </div>
        <div class="request-list">
          ${visibleRequests.length
            ? visibleRequests.map((request) => this.renderRequestRow(request))
            : html`<div class="empty">No requests received yet.</div>`}
          ${this.requests.length > MAX_VISIBLE_REQUESTS
            ? html`<div class="empty">
                Showing ${MAX_VISIBLE_REQUESTS} of ${this.requests.length}
                tracked requests.
              </div>`
            : ''}
        </div>
      </section>
    `
  }
}

globalThis.customElements.define('request-panel', RequestPanel)
