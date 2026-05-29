import { LitElement, html, svg } from 'lit'

import { fmt, latCls, renderCaps } from './dashboard-utils.js'

export class NodeCard extends LitElement {
  static properties = {
    node: { attribute: false },
    forcedModel: { attribute: false },
    _removing: { state: true },
    _removeError: { state: true },
    _cloudAvailable: { state: true },
    _cloudLoading: { state: true },
    _cloudError: { state: true },
    _cloudMutating: { state: true },
    _collapsed: { state: true },
    _forcingModel: { state: true },
    _forceError: { state: true },
    _togglingModel: { state: true },
  }

  constructor() {
    super()
    this.node = null
    this.forcedModel = null
    this._removing = false
    this._removeError = ''
    this._cloudAvailable = []
    this._cloudLoading = false
    this._cloudError = ''
    this._cloudMutating = false
    this._collapsed = false
    this._forcingModel = ''
    this._forceError = ''
    this._togglingModel = ''
    this._lastKnownModels = {}
    this._collapseInitialized = false
  }

  _toggleCollapsed() {
    this._collapsed = !this._collapsed
  }

  createRenderRoot() {
    return this
  }

  updated(changedProps) {
    // Set initial collapsed state based on reachability — only once on first
    // node assignment. After that the user's manual toggle takes precedence.
    if (changedProps.has('node') && this.node && !this._collapseInitialized) {
      this._collapseInitialized = true
      this._collapsed = !this.node.reachable
    }
  }

  connectedCallback() {
    super.connectedCallback()
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
      setTimeout(() => {
        this._removeError = ''
      }, 4000)
    } finally {
      this._removing = false
    }
  }

  async _fetchCloudAvailable() {
    this._cloudLoading = true
    this._cloudError = ''
    try {
      const res = await fetch('/admin/cloud/models')
      if (!res.ok)
        throw new Error(
          (await res.json().catch(() => ({}))).error ?? res.statusText,
        )
      const data = await res.json()
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
      if (!res.ok)
        throw new Error(
          (await res.json().catch(() => ({}))).error ?? res.statusText,
        )
      await this._fetchCloudAvailable()
    } catch (err) {
      this._cloudError = err.message
      setTimeout(() => {
        this._cloudError = ''
      }, 4000)
    } finally {
      this._cloudMutating = false
    }
  }

  async _removeModel(name) {
    if (this._cloudMutating) return
    this._cloudMutating = true
    try {
      const res = await fetch(
        `/admin/cloud/models/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      )
      if (!res.ok)
        throw new Error(
          (await res.json().catch(() => ({}))).error ?? res.statusText,
        )
      await this._fetchCloudAvailable()
    } catch (err) {
      this._cloudError = err.message
      setTimeout(() => {
        this._cloudError = ''
      }, 4000)
    } finally {
      this._cloudMutating = false
    }
  }

  _onDropdownChange(e) {
    const name = e.target.value
    if (!name) return
    e.target.value = ''
    this._addModel(name)
  }

  /**
   * Toggle the disabled state of a model on this node.
   * Disabled models stay visible but are skipped by the router.
   */
  async _toggleDisabled(name, currentlyDisabled) {
    if (this._togglingModel || !this.node) return
    this._togglingModel = name
    try {
      const res = await fetch(
        `/admin/inventory/nodes/${encodeURIComponent(this.node.host)}/models/${encodeURIComponent(name)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ disabled: !currentlyDisabled }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? res.statusText)
      }
      this.dispatchEvent(
        new CustomEvent('model-disabled-changed', {
          bubbles: true,
          composed: true,
          detail: { host: this.node.host, name, disabled: !currentlyDisabled },
        }),
      )
    } catch (err) {
      this._forceError = err.message
      setTimeout(() => {
        this._forceError = ''
      }, 4000)
    } finally {
      this._togglingModel = ''
    }
  }

  /**
   * Force the given model name for the next routed request.
   * POSTs to /admin/force-model and fires a bubbling 'force-model-set' event
   * so router-dashboard can update the override banner immediately.
   */
  async _forceModel(name) {
    if (this._forcingModel) return
    this._forcingModel = name
    this._forceError = ''
    try {
      const res = await fetch('/admin/force-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? res.statusText)
      this.dispatchEvent(
        new CustomEvent('force-model-set', {
          bubbles: true,
          composed: true,
          detail: { model: body.model, expiresAt: body.expiresAt },
        }),
      )
    } catch (err) {
      this._forceError = err.message
      setTimeout(() => {
        this._forceError = ''
      }, 4000)
    } finally {
      this._forcingModel = ''
    }
  }

  async _cancelForceModel() {
    if (this._forcingModel) return
    this._forcingModel = '__cancel__'
    try {
      const res = await fetch('/admin/force-model', { method: 'DELETE' })
      if (!res.ok) throw new Error(res.statusText)
      this.dispatchEvent(
        new CustomEvent('force-model-cleared', {
          bubbles: true,
          composed: true,
        }),
      )
    } catch (err) {
      this._forceError = err.message
      setTimeout(() => {
        this._forceError = ''
      }, 4000)
    } finally {
      this._forcingModel = ''
    }
  }

  _renderAddRow(activeNames) {
    const inactive = this._cloudAvailable
      .filter((m) => !activeNames.has(m.name))
      .sort((a, b) => a.name.localeCompare(b.name))
    let addPlaceholder
    if (this._cloudLoading) {
      addPlaceholder = 'Loading models…'
    } else if (inactive.length === 0) {
      addPlaceholder = 'No more models available'
    } else {
      addPlaceholder = '+ Add cloud model…'
    }
    return html`
      <tr class="cloud-add-row">
        <td colspan="10">
          <div class="cloud-add-wrap">
            ${this._cloudError
              ? html`<span class="cloud-add-error">${this._cloudError}</span>`
              : ''}
            <select
              class="cloud-add-select"
              ?disabled=${this._cloudMutating || this._cloudLoading}
              @change=${this._onDropdownChange}
            >
              <option value="">${addPlaceholder}</option>
              ${inactive.map(
                (m) => html`<option value=${m.name}>${m.name}</option>`,
              )}
            </select>
          </div>
        </td>
      </tr>
    `
  }

  /**
   * Render one models table — used twice per node (chat + embeddings).
   * Embedding tables replace the TPS column with the embedding dimension
   * and hide the ▶ force-model button (forcing makes no sense for embeddings).
   */
  _renderModelTable(models, { isCloud, isEmbedding, activeNames }) {
    if (models.length === 0) return ''
    const tpsHeader = isEmbedding ? 'Dim' : 'TPS'
    const tableClasses = [
      isCloud ? 'cloud-table' : '',
      isEmbedding ? 'embed-table' : '',
    ]
      .filter(Boolean)
      .join(' ')
    return html`
      <div class="models-wrap">
        <table class="${tableClasses}">
          <colgroup>
            <col class="c-model" />
            ${isCloud ? '' : html`<col class="c-size" />`}
            <col class="c-params" />
            <col class="c-ctx" />
            <col class="c-latency" />
            <col class="c-tps" />
            <col class="c-reqs" />
            <col class="c-lastused" />
            <col class="c-action" />
          </colgroup>
          <thead>
            <tr>
              <th>Model</th>
              ${isCloud ? '' : html`<th>Size</th>`}
              <th>Params</th>
              <th>Ctx</th>
              <th>Latency</th>
              <th>${tpsHeader}</th>
              <th>Req/Fails</th>
              <th>Last used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${models.map((model) =>
              this._renderModelRow(model, { isCloud, isEmbedding }),
            )}
            ${isCloud && !isEmbedding ? this._renderAddRow(activeNames) : ''}
          </tbody>
        </table>
      </div>
    `
  }

  _renderModelRow(model, { isCloud, isEmbedding }) {
    return html`
      <tr
        class="${model.activeRequests > 0
          ? 'model-active'
          : ''} ${model.disabled ? 'model-disabled' : ''} ${this.forcedModel ===
        model.name
          ? 'model-forced'
          : ''}"
      >
        <td class="td-model">
          <div class="model-name">
            ${this.forcedModel === model.name
              ? html`<span
                  class="model-forced-pin"
                  title="Pinned for next request"
                  >▶</span
                >`
              : ''}
            ${model.activeRequests > 0
              ? html`<span
                  class="model-active-dot"
                  title="${model.activeRequests} request(s) running"
                ></span>`
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
          <span class="mono ${latCls(model.recentLatency)}"
            >${fmt.duration(model.recentLatency)}</span
          >
        </td>
        <td class="mono">
          ${isEmbedding
            ? model.profile?.embeddingDim || '\u2014'
            : fmt.tps(model.recentTps)}
        </td>
        <td class="mono">
          ${model.totalRequests || 0}<span class="muted">/</span
          ><span class="${model.failures > 0 ? 'bad' : 'muted'}"
            >${model.failures || 0}</span
          >
        </td>
        <td
          class="mono muted"
          title="${model.lastRoutedAt
            ? new Date(model.lastRoutedAt).toLocaleString()
            : 'Never used'}"
        >
          ${fmt.ago(model.lastRoutedAt)}
        </td>
        <td class="td-action">
          <div class="td-action-inner">
            ${isEmbedding
              ? ''
              : html`
                  <button
                    class="btn-force-model ${this.forcedModel === model.name
                      ? 'is-active'
                      : ''}"
                    title="${this.forcedModel === model.name
                      ? 'Cancel force override for ' + model.name
                      : 'Force ' + model.name + ' for the next request'}"
                    ?disabled=${!this.node.reachable ||
                    model.disabled ||
                    this._forcingModel !== ''}
                    @click=${() =>
                      this.forcedModel === model.name
                        ? this._cancelForceModel()
                        : this._forceModel(model.name)}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <line x1="12" y1="6" x2="21" y2="6" />
                      <line x1="12" y1="12" x2="21" y2="12" />
                      <line x1="12" y1="18" x2="21" y2="18" />
                      <path d="M4 14 V 9 a 3 3 0 0 1 3 -3 h 5" />
                      <polyline points="9 3 12 6 9 9" />
                    </svg>
                  </button>
                `}
            <button
              class="btn-toggle-disabled"
              title="${model.disabled
                ? 'Enable ' + model.name + ' on this node'
                : 'Disable ' +
                  model.name +
                  ' on this node (router will skip it)'}"
              ?disabled=${this._togglingModel === model.name}
              @click=${() => this._toggleDisabled(model.name, !!model.disabled)}
              style="${isCloud ? 'display:none' : ''}"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                ${model.disabled
                  ? svg`<polygon points="7 4 20 12 7 20 7 4" />`
                  : svg`<rect x="6" y="5" width="4" height="14" rx="1" />
                      <rect x="14" y="5" width="4" height="14" rx="1" />`}
              </svg>
            </button>
            ${isCloud
              ? html`
                  <button
                    class="btn-cloud-remove"
                    title="Remove ${model.name} from cloud node"
                    ?disabled=${this._cloudMutating}
                    @click=${() => this._removeModel(model.name)}
                  >
                    ✕
                  </button>
                `
              : ''}
          </div>
        </td>
      </tr>
    `
  }

  render() {
    if (!this.node) return html``

    const liveModels = this.node.models || {}
    if (this.node.reachable && Object.keys(liveModels).length > 0) {
      this._lastKnownModels = liveModels
    }
    const effectiveModels =
      Object.keys(liveModels).length > 0 ? liveModels : this._lastKnownModels
    const models = Object.values(effectiveModels)
    const chatModels = models.filter((m) => !m.profile?.isEmbedding)
    const embeddingModels = models.filter((m) => m.profile?.isEmbedding)
    const hostShort = this.node.host.replace(/^https?:\/\//, '')
    const isCloud = !!this.node.cloud
    const activeNames = new Set(models.map((m) => m.name))
    const cardStateClass = this.node.reachable ? 'ok' : 'err'

    return html`
      <div class="node-card ${cardStateClass}">
        <!-- ── Header: split into summary (collapse trigger) + action buttons ── -->
        <div class="node-header">
          <!-- Left: clickable summary area -->
          <button
            class="node-summary"
            type="button"
            aria-expanded=${!this._collapsed}
            @click=${this._toggleCollapsed}
          >
            <div class="node-title">
              <div class="node-dot ${this.node.reachable ? 'ok' : 'err'}"></div>
              <span class="node-host">${hostShort}</span>
            </div>
            <div class="node-badges">
              ${isCloud ? html`<span class="badge b-blue">☁ Cloud</span>` : ''}
              <span class="badge ${this.node.reachable ? 'b-green' : 'b-red'}">
                ${this.node.reachable ? 'Online' : 'Offline'}
              </span>
              ${this.node.activeRequests > 0
                ? html`<span class="badge b-blue"
                    >${this.node.activeRequests} active</span
                  >`
                : ''}
              ${Number.isFinite(this.node.maxConcurrentRequests)
                ? html`<span
                    class="badge ${this.node.atCapacity ? 'b-red' : ''}"
                  >
                    ${this.node.activeRequests || 0}/${this.node
                      .maxConcurrentRequests}
                  </span>`
                : ''}
              <span class="badge">
                ${models.length} model${models.length === 1 ? '' : 's'}
              </span>
            </div>
          </button>

          <!-- Right: fixed action buttons -->
          <div class="node-actions">
            ${!isCloud
              ? html`
                  <button
                    class="node-action-btn node-action-remove"
                    title="Remove node from inventory"
                    aria-label="Remove node"
                    ?disabled=${this._removing}
                    @click=${this._onRemove}
                  >
                    ${this._removing
                      ? html`<span class="node-action-spinner"></span>`
                      : html`<svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                        >
                          <polyline points="3 6 5 6 21 6" />
                          <path
                            d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"
                          />
                          <path d="M10 11v6M14 11v6" />
                          <path d="M9 6V4h6v2" />
                        </svg>`}
                  </button>
                  ${this._removeError
                    ? html`<span class="remove-error">
                        ${this._removeError}</span
                      > `
                    : ''}
                `
              : ''}
            <button
              class="node-action-btn node-action-collapse"
              type="button"
              aria-label=${this._collapsed ? 'Expand node' : 'Collapse node'}
              @click=${this._toggleCollapsed}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
                style="transition: transform 0.2s; transform: rotate(${this
                  ._collapsed
                  ? '-90deg'
                  : '0deg'})"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>
        </div>

        ${this._collapsed
          ? ''
          : html`
              ${this._forceError
                ? html`<div class="force-error-banner">
                    ${this._forceError}
                  </div>`
                : ''}
              ${models.length === 0 && !isCloud
                ? html`
                    <div class="node-empty-state">
                      <span class="node-empty-icon">📭</span>
                      <span class="node-empty-text">No models discovered</span>
                      <span class="node-empty-sub">
                        ${this.node.reachable
                          ? 'Node online but no models loaded.'
                          : 'Node offline.'}
                      </span>
                    </div>
                  `
                : html`
                    ${chatModels.length > 0
                      ? this._renderModelTable(chatModels, {
                          isCloud,
                          isEmbedding: false,
                          activeNames,
                        })
                      : ''}
                    ${embeddingModels.length > 0
                      ? html`
                          <div class="models-section-header">
                            Embedding models
                          </div>
                          ${this._renderModelTable(embeddingModels, {
                            isCloud,
                            isEmbedding: true,
                            activeNames,
                          })}
                        `
                      : ''}
                    ${isCloud && chatModels.length === 0
                      ? html`
                          <div class="models-wrap">
                            <table class="cloud-table">
                              <tbody>
                                ${this._renderAddRow(activeNames)}
                              </tbody>
                            </table>
                          </div>
                        `
                      : ''}
                  `}
            `}
      </div>
    `
  }
}

globalThis.customElements.define('node-card', NodeCard)
