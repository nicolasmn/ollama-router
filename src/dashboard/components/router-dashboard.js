import { LitElement, html } from 'lit'

import './dashboard-summary.js'
import './node-card.js'
import './unified-request-drawer.js'
import './request-panel.js'
import { summarizePayload } from './dashboard-utils.js'

export class RouterDashboard extends LitElement {
  static properties = {
    wsState: { state: true },
    payload: { state: true },
    selectedRequestId: { state: true },
    drawerOpen: { state: true },
    scanInProgress: { state: true },
    rescanMessage: { state: true },
  }

  constructor() {
    super()
    this.wsState = 'connecting'
    this.payload = { timestamp: 0, nodes: {}, requests: [], scan: {} }
    this.selectedRequestId = null
    this.drawerOpen = false
    this.scanInProgress = false
    this.rescanMessage = ''
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

  get scanStatus() {
    const scan = this.payload.scan || {}
    if (scan.lastScanAgo === -1) {
      return 'Never scanned'
    }
    return `Scanned ${this._formatTime(scan.lastScanAgo)} ago`
  }

  _formatTime(ms) {
    if (ms < 0) return 'never'
    if (ms < 1000) return 'now'
    const sec = Math.floor(ms / 1000)
    if (sec < 60) return `${sec}s`
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min}m`
    const hr = Math.floor(min / 60)
    return `${hr}h`
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

  async onRescanClick() {
    if (this.scanInProgress) return

    this.scanInProgress = true
    this.rescanMessage = ''

    try {
      const response = await fetch('/discovery/scan-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })

      if (!response.ok) {
        throw new Error(`Scan failed: ${response.statusText}`)
      }

      const result = await response.json()
      this.rescanMessage = `Scan complete: ${result.nodeCount} nodes found`
      setTimeout(() => {
        this.rescanMessage = ''
      }, 3000)
    } catch (err) {
      this.rescanMessage = `Scan error: ${err.message}`
      setTimeout(() => {
        this.rescanMessage = ''
      }, 5000)
    } finally {
      this.scanInProgress = false
    }
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
        <div class="header-controls">
          <div class="scan-status">
            <span class="scan-text">${this.scanStatus}</span>
            <button
              class="rescan-btn ${this.scanInProgress ? 'scanning' : ''}"
              @click=${this.onRescanClick}
              ?disabled=${this.scanInProgress}
              title="Trigger immediate network scan"
            >
              <span class="rescan-icon" aria-hidden="true">⟳</span>
              <span class="rescan-label"
                >${this.scanInProgress ? 'Scanning...' : 'Rescan'}</span
              >
            </button>
            ${this.rescanMessage
              ? html`<span class="rescan-message">${this.rescanMessage}</span>`
              : ''}
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

      <unified-request-drawer
        .open=${this.drawerOpen}
        .request=${this.selectedRequest}
        @drawer-close=${this.closeDrawer}
      ></unified-request-drawer>
    `
  }
}

globalThis.customElements.define('router-dashboard', RouterDashboard)
