import { LitElement, html } from 'lit'

import { fmt, latCls, renderCaps } from './dashboard-utils.js'

export class NodeCard extends LitElement {
  static properties = {
    node: { attribute: false },
    _removing: { state: true },
    _removeError: { state: true },
    _cloudAvailable: { state: true },
    _cloudLoading: { state: true },
    _cloudError: { state: true },
    _cloudMutating: { state: true },
  }

  constructor() {
    super()
    this.node = null
    this._removing = false
    this._removeError = ''
    this._cloudAvailable = []
    this._cloudLoading = false
    this._cloudError = ''
    this._cloudMutating = false
  }

  createRenderRoot() {
    return this
  }

  connectedCallback() {
    super.connectedCallback()
    // Pre-fetch available models when card mounts for a cloud node so the
    // dropdown is ready without a user gesture.
    if (this.node?.cloud) this._fetchCloudAvailable()
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

  /** Fetch the list of models available on ollama.com (not yet active). */
  async _fetchCloudAvailable() {
    this._cloudLoading = true
    this._cloudError = ''
    try {
      const res = await fetch('/admin/cloud/models')
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText)
      const data = await res.json()
      // available = all models from ollama.com; filter out already-active ones in render
      this._cloudAvailable = data.available ?? []
    } catch (err) {
      this._cloudError = err.message
    } finally {
      this._cloudLoading = false
    }
  }

  async _addModel(name) {
    if (!name || this._cloudMutating) return
    this._cloudMutating = true
    try {
      const res = await fetch('/admin/cloud/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText)
      // Refresh available list so dropdown removes the just-added model
      await this._fetchCloudAvailable()
    } catch (err) {
      this._cloudError = err.message
      setTimeout(() => { this._cloudError = '' }, 4000)
    } finally {
      this._cloudMutating = false
    }
  }

  async _removeModel(name) {
    if (this._cloudMutating) return
    this._cloudMutating = true
    try {
      const res = await fetch(`/admin/cloud/models/${encodeURIComponent(name)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText)
      await this._fetchCloudAvailable()
    } catch (err) {
      this._cloudError = err.message
      setTimeout(() => { this._cloudError = '' }, 4000)
    } finally {
      this._cloudMutating = false
    }
  }

  _onDropdownChange(e) {
    const name = e.target.value
    if (!name) return
    e.target.value = '' // reset to placeholder
    this._addModel(name)
  }

  /** Render the always-visible "add model" dropdown row at the bottom of the table. */
  _renderAddRow(activeNames) {
    const inactive = this._cloudAvailable
      .filter((m) => !activeNames.has(m.name))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
    return html`
      <tr class="cloud-add-row">
        <td colspan="9">
          <div class="cloud-add-wrap">
            ${this._cloudError
              ? html`<span class="cloud-add-error">${this._cloudError}</span>`
              : ''}
            <select
              class="cloud-add-select"
              ?disabled=${this._cloudMutating || this._cloudLoading}
              @change=${this._onDropdownChange}
            >
              <option value="">
                ${this._cloudLoading
                  ? 'Loading models…'
                  : inactive.length === 0
                    ? 'No more models available'
                    : '+ Add cloud model…'}
              </option>
              ${inactive.map(
                (m) => html` <option value=${m.name}>${m.name}</option> `,
              )}
            </select>
          </div>
        </td>
      </tr>
    `
  }

  render() {
    if (!this.node) return html``

    const models = Object.values(this.node.models || {})
    const hostShort = this.node.host.replace(/^https?:\/\//, '')
    const isCloud = !!this.node.cloud
    const activeNames = new Set(models.map((m) => m.name))

    const cardStateClass = this.node.reachable ? 'ok' : 'err'

    return html`
      <div class="node-card ${cardStateClass}">
        <div class="node-header">
          <div class="node-title">
            <div class="node-dot ${this.node.reachable ? 'ok' : 'err'}"></div>
            <span class="node-host">${hostShort}</span>
          </div>
          <div class="node-meta">
            ${isCloud ? html`<span class="badge b-blue">☁ Cloud</span>` : ''}
            <span class="badge ${this.node.reachable ? 'b-green' : 'b-red'}">
              ${this.node.reachable ? 'Online' : 'Offline'}
            </span>
            ${this.node.activeRequests > 0
              ? html`<span class="badge b-blue">${this.node.activeRequests} active</span>`
              : ''}
            ${Number.isFinite(this.node.maxConcurrentRequests)
              ? html`<span class="badge ${this.node.atCapacity ? 'b-red' : ''}">
                  ${Math.round((this.node.utilization || 0) * 100)}%
                  · ${this.node.activeRequests || 0}/${this.node.maxConcurrentRequests}
                </span>`
              : ''}
            <span class="badge">
              ${models.length} model${models.length === 1 ? '' : 's'}
            </span>
            ${!isCloud && !this.node.reachable
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

        <div class="models-wrap">
          <table>
            <colgroup>
              <col class="c-model" />
              ${isCloud ? '' : html`<col class="c-size" />`}
              <col class="c-params" />
              <col class="c-ctx" />
              <col class="c-latency" />
              <col class="c-tps" />
              <col class="c-reqs" />
              <col class="c-failures" />
              <col class="c-lastused" />
              ${isCloud ? html`<col class="c-action" />` : ''}
            </colgroup>
            <thead>
              <tr>
                <th>Model</th>
                ${isCloud ? '' : html`<th>Size</th>`}
                <th>Params</th>
                <th>Ctx</th>
                <th>Latency</th>
                <th>TPS</th>
                <th>Reqs</th>
                <th>Fails</th>
                <th>Last used</th>
                ${isCloud ? html`<th></th>` : ''}
              </tr>
            </thead>
            <tbody>
              ${models.length === 0 && !isCloud
                ? html`
                    <tr><td colspan="9" class="empty">No models discovered on this node.</td></tr>
                  `
                : models.map((model) => html`
                    <tr class="${model.activeRequests > 0 ? 'model-active' : ''}">
                      <td class="td-model">
                        <div class="model-name">
                          ${model.activeRequests > 0
                            ? html`<span class="model-active-dot" title="${model.activeRequests} request(s) running"></span>`
                            : ''}
                          ${model.name}
                        </div>
                        <div class="model-fam">${model.family || '\u2014'}</div>
                        <div class="model-caps">${renderCaps(model.profile)}</div>
                      </td>
                      ${isCloud ? '' : html`<td class="mono">${fmt.bytes(model.size)}</td>`}
                      <td class="mono">${fmt.params(model.profile?.parameters)}</td>
                      <td class="mono">${fmt.ctx(model.profile?.contextLength)}</td>
                      <td>
                        <span class="mono ${latCls(model.recentLatency)}">
                          ${fmt.duration(model.recentLatency)}
                        </span>
                      </td>
                      <td class="mono">${fmt.tps(model.recentTps)}</td>
                      <td class="mono">${model.totalRequests || 0}</td>
                      <td class="mono ${model.failures > 0 ? 'bad' : ''}">${model.failures || 0}</td>
                      <td
                        class="mono muted"
                        title="${model.lastRoutedAt
                          ? new Date(model.lastRoutedAt).toLocaleString()
                          : 'Never used'}"
                      >
                        ${fmt.ago(model.lastRoutedAt)}
                      </td>
                      ${isCloud
                        ? html`
                            <td class="td-action">
                              <button
                                class="btn-cloud-remove"
                                title="Remove ${model.name} from cloud node"
                                ?disabled=${this._cloudMutating}
                                @click=${() => this._removeModel(model.name)}
                              >✕</button>
                            </td>
                          `
                        : ''}
                    </tr>
                  `)}
              ${isCloud ? this._renderAddRow(activeNames) : ''}
            </tbody>
          </table>
        </div>
      </div>
    `
  }
}

globalThis.customElements.define('node-card', NodeCard)
