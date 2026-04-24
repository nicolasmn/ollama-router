import { LitElement, html } from 'lit'

import { latCls } from './dashboard-utils.js'

export class DashboardSummary extends LitElement {
  static properties = {
    summary: { attribute: false },
  }

  constructor() {
    super()
    this.summary = {
      online: 0,
      totalNodes: 0,
      totalModels: 0,
      totalReqs: 0,
      avgLat: 0,
      avgTps: 0,
    }
  }

  createRenderRoot() {
    return this
  }

  render() {
    return html`
      <div class="summary">
        <div class="stat">
          <div class="stat-label">Nodes Online</div>
          <div class="stat-val green">${this.summary.online || '—'}</div>
          <div class="stat-sub">of ${this.summary.totalNodes} configured</div>
        </div>
        <div class="stat">
          <div class="stat-label">Total Models</div>
          <div class="stat-val blue">${this.summary.totalModels || '—'}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Active Requests</div>
          <div
            class="stat-val ${this.summary.totalReqs > 0 ? 'yellow' : 'blue'}"
          >
            ${this.summary.totalReqs || 0}
          </div>
        </div>
        <div class="stat">
          <div class="stat-label">Avg Latency</div>
          <div
            class="stat-val ${this.summary.avgLat > 0
              ? latCls(this.summary.avgLat)
              : 'muted'}"
          >
            ${this.summary.avgLat > 0
              ? `${Math.round(this.summary.avgLat)} ms`
              : '—'}
          </div>
        </div>
        <div class="stat">
          <div class="stat-label">Avg TPS</div>
          <div
            class="stat-val ${this.summary.avgTps > 0
              ? 'blue'
              : 'muted stat-val-empty'}"
          >
            ${this.summary.avgTps > 0 ? this.summary.avgTps.toFixed(1) : '—'}
          </div>
        </div>
      </div>
    `
  }
}

globalThis.customElements.define('dashboard-summary', DashboardSummary)
