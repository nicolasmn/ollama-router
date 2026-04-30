import { LitElement, html } from 'lit'

import { fmt, latCls, renderCaps } from './dashboard-utils.js'

export class NodeCard extends LitElement {
  static properties = {
    node: { attribute: false },
    _removing: { state: true },
    _removeError: { state: true },
  }

  constructor() {
    super()
    this.node = null
    this._removing = false
    this._removeError = ''
  }

  createRenderRoot() {
    return this
  }

  async _onRemove() {
    if (this._removing || !this.node) return
    this._removing = true
    this._removeError = ''
    try {
      const res = await fetch(
        `/admin/inventory/nodes/${encodeURIComponent(this.node.host)}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? res.statusText)
      }
      // Optimistically dispatch so parent can react if needed
      this.dispatchEvent(
        new CustomEvent('node-removed', {
          bubbles: true,
          composed: true,
          detail: { host: this.node.host },
        }),
      )
    } catch (err) {
      this._removeError = err.message
      setTimeout(() => { this._removeError = '' }, 4000)
    } finally {
      this._removing = false
    }
  }

  render() {
    if (!this.node) {
      return html``
    }

    const models = Object.values(this.node.models || {})
    const hostShort = this.node.host.replace(/^https?:\/\//, '')

    return html`
      <div class="node-card ${this.node.reachable ? 'ok' : 'err'}">
        <div class="node-header">
          <div class="node-title">
            <div class="node-dot ${this.node.reachable ? 'ok' : 'err'}"></div>
            <span class="node-host">${hostShort}</span>
          </div>
          <div class="node-meta">
            <span class="badge ${this.node.reachable ? 'b-green' : 'b-red'}">
              ${this.node.reachable ? 'Online' : 'Offline'}
            </span>
            ${this.node.activeRequests > 0
              ? html`<span class="badge b-blue"
                  >${this.node.activeRequests} active</span
                >`
              : ''}
            <span class="badge">
              ${models.length} model${models.length === 1 ? '' : 's'}
            </span>
            ${!this.node.reachable
              ? html`
                  <button
                    class="btn-remove ${this._removing ? 'removing' : ''}"
                    title="Remove stale node from inventory"
                    ?disabled=${this._removing}
                    @click=${this._onRemove}
                  >
                    ${this._removing ? 'Removing…' : '✕ Remove'}
                  </button>
                  ${this._removeError
                    ? html`<span class="remove-error">${this._removeError}</span>`
                    : ''}
                `
              : ''}
          </div>
        </div>

        ${models.length === 0
          ? html`<div class="empty">No models discovered on this node</div>`
          : html`
              <div class="models-wrap">
                <table>
                  <colgroup>
                    <col class="c-model" />
                    <col class="c-size" />
                    <col class="c-params" />
                    <col class="c-ctx" />
                    <col class="c-latency" />
                    <col class="c-tps" />
                    <col class="c-reqs" />
                    <col class="c-failures" />
                    <col class="c-lastused" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Size</th>
                      <th>Params</th>
                      <th>Ctx</th>
                      <th>Latency</th>
                      <th>TPS</th>
                      <th>Reqs</th>
                      <th>Fails</th>
                      <th>Last used</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${models.map(
                      (model) => html`
                        <tr
                          class="${model.activeRequests > 0
                            ? 'model-active'
                            : ''}"
                        >
                          <td class="td-model">
                            <div class="model-name">
                              ${model.activeRequests > 0
                                ? html`<span
                                    class="model-active-dot"
                                    title="${model.activeRequests} request(s) running"
                                  ></span>`
                                : ''}
                              ${model.name}
                            </div>
                            <div class="model-fam">${model.family || '\u2014'}</div>
                            <div class="model-caps">
                              ${renderCaps(model.profile)}
                            </div>
                          </td>
                          <td class="mono">${fmt.bytes(model.size)}</td>
                          <td class="mono">
                            ${fmt.params(model.profile?.parameters)}
                          </td>
                          <td class="mono">
                            ${fmt.ctx(model.profile?.contextLength)}
                          </td>
                          <td>
                            <span class="mono ${latCls(model.recentLatency)}">
                              ${fmt.duration(model.recentLatency)}
                            </span>
                          </td>
                          <td class="mono">${fmt.tps(model.recentTps)}</td>
                          <td class="mono">${model.totalRequests || 0}</td>
                          <td class="mono ${model.failures > 0 ? 'bad' : ''}">
                            ${model.failures || 0}
                          </td>
                          <td
                            class="mono muted"
                            title="${model.lastRoutedAt
                              ? new Date(model.lastRoutedAt).toLocaleString()
                              : 'Never used'}"
                          >
                            ${fmt.ago(model.lastRoutedAt)}
                          </td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              </div>
            `}
      </div>
    `
  }
}

globalThis.customElements.define('node-card', NodeCard)
