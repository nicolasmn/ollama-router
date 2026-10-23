import { LitElement, html, svg } from 'lit'

import { fmt, latCls, renderCaps } from './dashboard-utils.js'

export class NodeCard extends LitElement {
  static properties = {
    node: { attribute: false },
    forcedModel: { attribute: false },
    cloudUsage: { attribute: false },
    _removing: { state: true },
    _removeError: { state: true },
    _waking: { state: true },
    _wakeError: { state: true },
    _wakeSuccess: { state: true },
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
    this.cloudUsage = null
    this._removing = false
    this._removeError = ''
    this._waking = false
    this._wakeError = ''
    this._wakeSuccess = false
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
    if (changedProps.has('node') && this.node && !this._collapseInitialized) {
      this._collapseInitialized = true
      this._collapsed = !this.node.reachable
    }
  }

  connectedCallback() {
    super.connectedCallback()
    if (this.node?.cloud) {
      this._fetchCloudAvailable()
    }
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

  async _onWake() {
    if (this._waking || !this.node) return
    this._waking = true
    this._wakeError = ''
    this._wakeSuccess = false
    try {
      const res = await fetch(
        `/admin/inventory/nodes/${encodeURIComponent(this.node.host)}/wake`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? res.statusText)
      }
      this._wakeSuccess = true
      setTimeout(() => { this._wakeSuccess = false }, 5000)
      this.dispatchEvent(
        new CustomEvent('node-wake-triggered', {
          bubbles: true,
          composed: true,
          detail: { host: this.node.host },
        }),
      )
    } catch (err) {
      this._wakeError = err.message
      setTimeout(() => { this._wakeError = '' }, 5000)
    } finally {
      this._waking = false
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

  /**
   * Footer row: usage bars on the left + model-add selector on the right.
   */
  _renderCloudFooter(activeNames) {
    const u = this.cloudUsage
    const barCls = (pct) => (pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '')

    const inactive = this._cloudAvailable
      .filter((m) => !activeNames.has(m.name))
      .sort((a, b) => a.name.localeCompare(b.name))
    const addPlaceholder = this._cloudLoading
      ? 'Loading models…'
      : inactive.length === 0
        ? 'No more models available'
        : '+ Add cloud model…'

    return html`
      <div class="cloud-usage-footer">
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
        ${u
          ? html`
              <div class="cloud-usage-bars">
                <div class="usage-bar-row">
                  <span class="usage-label">Session</span>
                  <div class="usage-track">
                    <div
                      class="usage-fill ${barCls(u.sessionPct)}"
                      style="width:${u.sessionPct}%"
                    ></div>
                  </div>
                  <span class="usage-pct ${barCls(u.sessionPct)}"
                    >${u.sessionPct}%</span
                  >
                  <span class="usage-reset muted"
                    >↺ ${fmt.countdown(u.sessionResetMs)}</span
                  >
                </div>
                <div class="usage-bar-row">
                  <span class="usage-label">Weekly</span>
                  <div class="usage-track">
                    <div
                      class="usage-fill ${barCls(u.weeklyPct)}"
                      style="width:${u.weeklyPct}%"
                    ></div>
                  </div>
                  <span class="usage-pct ${barCls(u.weeklyPct)}"
                    >${u.weeklyPct}%</span
                  >
                  <span class="usage-reset muted"
                    >↺ ${fmt.countdown(u.weeklyResetMs)}</span
                  >
                </div>
              </div>
            `
          : ''}
      </div>
    `
  }

  _renderModelTable(models, { isCloud, isEmbedding, isDecision, activeNames }) {
    if (models.length === 0) return ''
    const tpsHeader = isEmbedding ? 'Dim' : isDecision ? 'OPTS' : 'TPS'
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
              <th title="Time to first token (EMA over recent requests)">TTFT</th>
              <th
                title=${isDecision
                  ? 'Max SystemOne choice criteria per question, learned from upstream caps'
                  : 'Decoding speed (tokens/s), excluding model load'}
                >${tpsHeader}</th
              >
              <th>Req/Fails</th>
              <th>Last used</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${models.map((model) =>
              this._renderModelRow(model, { isCloud, isEmbedding }),
            )}
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
          ${(() => {
            const hasTtft = model.recentTtft > 0
            const latencyMs = hasTtft ? model.recentTtft : model.recentLatency
            const title = hasTtft
              ? `First token after ${fmt.duration(latencyMs)} · model load ~${fmt.duration(model.recentLoadMs)}`
              : 'Recent response latency (legacy metric, TTFT pending)'
            return html`<span class="mono ${latCls(latencyMs)}"
              title=${title}>${fmt.duration(latencyMs)}</span
            >`
          })()}
        </td>
        <td class="mono">
          ${(() => {
            if (isEmbedding) return model.profile?.embeddingDim || '\u2014'
            if (isDecision) {
              const cap = model.systemoneMaxCriteria || 0
              return html`<span class="mono ${cap ? '' : 'muted'}"
                >${cap ? `≤${cap}` : '—'}</span
              >`
            }
            return html`<span
                class="mono ${fmt.tps(model.recentTps) === '—' ? 'muted' : ''}"
                title="Decoding speed (tokens/s), excluding model load"
                >${fmt.tps(model.recentTps)}</span
              >`
          })()}
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
                  : svg`<rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" />`}
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
    const chatModels = models.filter(
      (m) => !m.profile?.isEmbedding && !m.profile?.supportsDecision,
    )
    const decisionModels = models.filter(
      (m) => m.profile?.supportsDecision && !m.profile?.isEmbedding,
    )
    const embeddingModels = models.filter((m) => m.profile?.isEmbedding)
    const hostShort = this.node.host.replace(/^https?:\/\//, '')
    const isCloud = !!this.node.cloud
    const activeNames = new Set(models.map((m) => m.name))
    const cardStateClass = this.node.reachable ? 'ok' : 'err'
    const plan = this.cloudUsage?.plan ?? null
    const canWake = !this.node.reachable && !!this.node.mac && !isCloud

    const cloudBadgeLabel = plan ? `☁️  Cloud ・${plan}` : '☁️  Cloud'
    const cloudBadgeCls =
      plan === 'Max' ? 'b-purple' : plan === 'Pro' ? 'b-green' : 'b-blue'

    return html`
      <div class="node-card ${cardStateClass}">
        <div class="node-header">
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
              ${isCloud
                ? html`<span class="badge ${cloudBadgeCls}"
                    >${cloudBadgeLabel}</span
                  >`
                : ''}
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

          <div class="node-actions">
            ${canWake
              ? html`
                  <button
                    class="node-action-btn node-action-wake ${this._waking ? 'waking' : ''} ${this._wakeSuccess ? 'wake-ok' : ''}"
                    title="Send Wake-on-LAN magic packet to ${this.node.mac}"
                    aria-label="Wake node"
                    ?disabled=${this._waking}
                    @click=${this._onWake}
                  >
                    ${this._waking
                      ? html`<span class="node-action-spinner"></span>`
                      : html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`}
                  </button>
                  ${this._wakeError
                    ? html`<span class="wake-error">${this._wakeError}</span>`
                    : ''}
                  ${this._wakeSuccess
                    ? html`<span class="wake-success">Packet sent!</span>`
                    : ''}
                `
              : ''}
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
                    ? html`<span class="remove-error"
                        >${this._removeError}</span
                      >`
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
                      <span class="node-empty-icon">📢</span>
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
                          isDecision: false,
                          activeNames,
                        })
                      : ''}
                    ${decisionModels.length > 0
                      ? html`
                          <div class="models-section-header">
                            Decision models
                          </div>
                          ${this._renderModelTable(decisionModels, {
                            isCloud,
                            isEmbedding: false,
                            isDecision: true,
                            activeNames,
                          })}
                        `
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
                  `}
              ${isCloud ? this._renderCloudFooter(activeNames) : ''}
            `}
      </div>
    `
  }
}

globalThis.customElements.define('node-card', NodeCard)
