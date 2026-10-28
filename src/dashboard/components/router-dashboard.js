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
    _forceOverride: { state: true },
    _clearingOverride: { state: true },
  }

  constructor() {
    super()
    this.wsState = 'connecting'
    this.payload = { timestamp: 0, nodes: {}, requests: [], scan: {}, cloudUsage: null }
    this.selectedRequestId = null
    this.drawerOpen = false
    this.scanInProgress = false
    this.rescanMessage = ''
    this._forceOverride = null  // { model, expiresAt } | null
    this._clearingOverride = false
    this.ws = null
    this.retryTimer = null
  }

  // Re-run microlighter syntax highlighting after lit re-renders
  // (CSS Custom Highlights don't survive DOM updates).
  updated() {
    this.dispatchEvent(
      new Event('syntax-highlight', { bubbles: true, composed: true }),
    )
  }

  createRenderRoot() {
    return this
  }

  connectedCallback() {
    super.connectedCallback()
    this.connect()
    // Listen for force-model-set from node-card children (bubbled)
    this.addEventListener('force-model-set', (e) => {
      this._forceOverride = { model: e.detail.model, expiresAt: e.detail.expiresAt }
    })
    this.addEventListener('force-model-cleared', () => {
      this._forceOverride = null
    })
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.ws) this.ws.close()
  }

  connect() {
    const protocol = globalThis.location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws = new globalThis.WebSocket(`${protocol}://${globalThis.location.host}/ws`)

    this.ws.onopen = () => { this.wsState = 'connected' }

    this.ws.onclose = () => {
      this.wsState = 'reconnecting'
      this.retryTimer = setTimeout(() => this.connect(), 3000)
    }

    this.ws.onerror = () => { this.wsState = 'disconnected' }

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message.type === 'inventory') {
          this.payload = message.data
          // Keep override banner in sync with server-side truth from WS payload
          this._forceOverride = message.data.forceOverride ?? null
          if (
            this.selectedRequestId &&
            !this.requests.some((request) => request.requestId === this.selectedRequestId)
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
    if (scan.lastScanAgo === -1) return 'Never scanned'
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
    const base = this.requests.find(
      (request) => request.requestId === this.selectedRequestId,
    )
    if (!base) {
      this.#hydratedRequest = null
      return null
    }
    if (!base.hasMessages) return base
    // WS broadcasts omit messageList; the hydrated copy (fetched once plus a
    // light refresh while the drawer is open) carries the full thread.
    return this.#hydratedRequest
      && this.#hydratedRequest.requestId === base.requestId
      ? { ...base, ...this.#hydratedRequest }
      : base
  }

  #hydratedRequest = null
  #hydrateTimer = null

  openRequest(requestId) {
    this.selectedRequestId = requestId
    this.drawerOpen = true
    this.#scheduleHydration(0)
  }

  closeDrawer() {
    this.drawerOpen = false
    if (this.#hydrateTimer) {
      clearInterval(this.#hydrateTimer)
      this.#hydrateTimer = null
    }
  }

  async #scheduleHydration(delayMs = 0) {
    if (this.#hydrateTimer) {
      clearInterval(this.#hydrateTimer)
      this.#hydrateTimer = null
    }
    await this.#hydrateSelected()
    if (!this.drawerOpen) return
    // Keep the open drawer fresh (streaming captures, attempt updates). The
    // single-entry REST response is small compared to the full list.
    this.#hydrateTimer = setInterval(() => {
      if (!this.drawerOpen) return
      this.#hydrateSelected()
    }, 2000)
  }

  async #hydrateSelected() {
    const requestId = this.selectedRequestId
    if (!requestId) return
    try {
      const response = await fetch(
        `/admin/requests/${encodeURIComponent(requestId)}`,
        // Admin payloads are per-process state (routing decisions, message
        // threads) — never let the browser serve a stale 304 from its cache.
        { cache: 'no-store' },
      )
      if (!response.ok) return
      const detail = await response.json()
      if (detail?.requestId !== requestId) return
      if (requestId !== this.selectedRequestId) return
      this.#hydratedRequest = detail
      this.requestUpdate()
    } catch {
      // WS still delivers metadata; hydration is best-effort
    }
  }

  async onRescanClick() {
    if (this.scanInProgress) return
    this.scanInProgress = true
    this.rescanMessage = ''
    try {
      const response = await fetch('/admin/discovery/scan-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!response.ok) throw new Error(`Scan failed: ${response.statusText}`)
      const result = await response.json()
      this.rescanMessage = `Scan complete: ${result.nodeCount} nodes found`
      setTimeout(() => { this.rescanMessage = '' }, 3000)
    } catch (err) {
      this.rescanMessage = `Scan error: ${err.message}`
      setTimeout(() => { this.rescanMessage = '' }, 5000)
    } finally {
      this.scanInProgress = false
    }
  }

  async _clearForceOverride() {
    if (this._clearingOverride) return
    this._clearingOverride = true
    try {
      await fetch('/admin/force-model', { method: 'DELETE' })
      this._forceOverride = null
    } catch {
      // WS will sync state on next tick anyway
    } finally {
      this._clearingOverride = false
    }
  }

  handleRequestSelected(event) {
    this.openRequest(event.detail.requestId)
  }

  _renderForceOverrideBanner() {
    if (!this._forceOverride) return ''
    const { model, expiresAt } = this._forceOverride
    const remainingMs = expiresAt - Date.now()
    const remainingMin = Math.floor(remainingMs / 1000 / 60)
    const ttlLabel = remainingMs <= 0
      ? 'expired'
      : remainingMin < 1
        ? '<1m'
        : `~${remainingMin}m`
    return html`
      <div class="force-override-banner">
        <span class="force-override-icon">▶</span>
        <span class="force-override-label">
          Next request forced to <strong>${model}</strong>
          <span class="force-override-ttl"> &mdash; expires in ${ttlLabel}</span>
        </span>
        <button
          class="force-override-cancel"
          ?disabled=${this._clearingOverride}
          @click=${this._clearForceOverride}
          title="Cancel forced model override"
        >✕ Cancel</button>
      </div>
    `
  }

  render() {
    const summary = this.summary
    const cloudUsage = this.payload.cloudUsage ?? null

    return html`
      <header>
        <div class="logo">
          <img
            class="logo-icon"
            src="/dashboard-assets/logo.svg"
            alt="Ollama Router"
            width="32"
            height="32"
          />
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
              <span class="rescan-icon" aria-hidden="true">↻</span>
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
        ${this._renderForceOverrideBanner()}

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
                (node) =>
                  html`<node-card
                    .node=${node}
                    .forcedModel=${this._forceOverride?.model ?? null}
                    .cloudUsage=${node.cloud ? cloudUsage : null}
                  ></node-card>`,
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
