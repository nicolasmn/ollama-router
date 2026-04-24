import { LitElement, html } from 'lit'

import './dashboard-summary.js'
import './node-card.js'
import './request-drawer.js'
import './request-panel.js'
import { summarizePayload } from './dashboard-utils.js'

export class RouterDashboard extends LitElement {
  static properties = {
    wsState: { state: true },
    payload: { state: true },
    selectedRequestId: { state: true },
    drawerOpen: { state: true },
  }

  constructor() {
    super()
    this.wsState = 'connecting'
    this.payload = { timestamp: 0, nodes: {}, requests: [] }
    this.selectedRequestId = null
    this.drawerOpen = false
    this.ws = null
    this.retryTimer = null
  }

  createRenderRoot() {
    return this
  }

  connectedCallback() {
    super.connectedCallback()
    this.connect()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.ws) this.ws.close()
  }

  connect() {
    const protocol = globalThis.location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws = new globalThis.WebSocket(
      `${protocol}://${globalThis.location.host}/ws`,
    )

    this.ws.onopen = () => {
      this.wsState = 'connected'
    }

    this.ws.onclose = () => {
      this.wsState = 'reconnecting'
      this.retryTimer = setTimeout(() => this.connect(), 3000)
    }

    this.ws.onerror = () => {
      this.wsState = 'disconnected'
    }

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message.type === 'inventory') {
          this.payload = message.data
          if (
            this.selectedRequestId &&
            !this.requests.some(
              (request) => request.requestId === this.selectedRequestId,
            )
          ) {
            this.selectedRequestId = null
            this.drawerOpen = false
          }
        }
      } catch {
        // Ignore malformed payloads from the socket.
      }
    }
  }

  get nodes() {
    return Object.values(this.payload.nodes || {})
  }

  get requests() {
    return this.payload.requests || []
  }

  get summary() {
    return summarizePayload(this.nodes)
  }

  get selectedRequest() {
    return this.requests.find(
      (request) => request.requestId === this.selectedRequestId,
    )
  }

  openRequest(requestId) {
    this.selectedRequestId = requestId
    this.drawerOpen = true
  }

  closeDrawer() {
    this.drawerOpen = false
  }

  handleRequestSelected(event) {
    this.openRequest(event.detail.requestId)
  }

  render() {
    const summary = this.summary

    return html`
      <header>
        <div class="logo">
          <span class="logo-icon">🦙</span>
          <h1>Ollama Router <span>/ Dashboard</span></h1>
        </div>
        <div class="ws-status">
          <div class="dot ${this.wsState}"></div>
          <span>
            ${this.wsState === 'connected'
              ? 'Live'
              : this.wsState === 'reconnecting'
                ? 'Reconnecting…'
                : this.wsState === 'disconnected'
                  ? 'Error'
                  : 'Connecting…'}
          </span>
        </div>
      </header>

      <main>
        <dashboard-summary .summary=${summary}></dashboard-summary>

        <request-panel
          .requests=${this.requests}
          .selectedRequestId=${this.selectedRequestId}
          .drawerOpen=${this.drawerOpen}
          @request-selected=${this.handleRequestSelected}
        ></request-panel>

        <div class="nodes">
          ${this.nodes.length
            ? this.nodes.map(
                (node) => html`<node-card .node=${node}></node-card>`,
              )
            : html`<div class="empty">No nodes configured.</div>`}
        </div>

        <div class="footer">
          Last update:
          ${this.payload.timestamp
            ? new Date(this.payload.timestamp).toLocaleTimeString()
            : '—'}
        </div>
      </main>

      <request-drawer
        .open=${this.drawerOpen}
        .request=${this.selectedRequest}
        @drawer-close=${this.closeDrawer}
      ></request-drawer>
    `
  }
}

globalThis.customElements.define('router-dashboard', RouterDashboard)
