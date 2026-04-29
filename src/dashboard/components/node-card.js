import { LitElement, html } from 'lit'

import { fmt, latCls, renderCaps } from './dashboard-utils.js'

export class NodeCard extends LitElement {
  static properties = {
    node: { attribute: false },
  }

  constructor() {
    super()
    this.node = null
  }

  createRenderRoot() {
    return this
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
                            <div class="model-fam">${model.family || '—'}</div>
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
