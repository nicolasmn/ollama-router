import { LitElement, html } from 'lit'

import { endpointLabel } from './dashboard-utils.js'

function renderMessageThread(request) {
  if (!request) {
    return html`<div class="empty">No request selected.</div>`
  }

  if (!request.messageList?.length) {
    return html`<div class="preview-box">
      ${request.promptPreview || 'No preview available.'}
    </div>`
  }

  return html`
    <div class="message-thread">
      ${request.messageList.map(
        (msg, i) => html`
          <div class="msg msg--${msg.role}">
            <div class="msg-header">
              <span class="msg-avatar msg-avatar--${msg.role}"
                >${msg.role.charAt(0).toUpperCase()}</span
              >
              <span class="msg-role">${msg.role}</span>
              <span class="msg-index">#${i + 1}</span>
            </div>
            <div class="msg-body">
              ${msg.content || html`<span class="muted">(empty)</span>`}
            </div>
          </div>
        `,
      )}
    </div>
  `
}

export class MessageDrawer extends LitElement {
  static properties = {
    open: { type: Boolean },
    request: { attribute: false },
  }

  constructor() {
    super()
    this.open = false
    this.request = null
  }

  createRenderRoot() {
    return this
  }

  emitClose() {
    this.dispatchEvent(
      new CustomEvent('message-drawer-close', {
        bubbles: true,
        composed: true,
      }),
    )
  }

  render() {
    const msgCount = this.request?.messageList?.length ?? 0
    const subtitle = this.request
      ? `${endpointLabel(this.request.endpointType)} · ${msgCount} message${msgCount === 1 ? '' : 's'}`
      : ''

    return html`
      <div
        class="msg-drawer-shell ${this.open ? 'open' : ''}"
        aria-hidden=${this.open ? 'false' : 'true'}
      >
        <div class="drawer-backdrop" @click=${() => this.emitClose()}></div>
        <aside class="msg-drawer">
          <div class="drawer-head">
            <div>
              <div class="drawer-title">Messages</div>
              <div class="drawer-subtitle">${subtitle}</div>
            </div>
            <button
              class="drawer-close"
              type="button"
              @click=${() => this.emitClose()}
            >
              ✕
            </button>
          </div>
          <div class="drawer-body">${renderMessageThread(this.request)}</div>
        </aside>
      </div>
    `
  }
}

globalThis.customElements.define('message-drawer', MessageDrawer)
