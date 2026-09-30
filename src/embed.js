/*
 * embed.js — host-side loader for the browser-hosted Hermes agent.
 *
 *   <script src="https://<your-hermes-origin>/embed.js"></script>
 *   <script>
 *     const h = Hermes.mount('#chat')                 // fills the element
 *     await h.ready()                                  // backend booted
 *     const s = await h.call('session.create', {})
 *     await h.prompt(s.session_id, 'hello')
 *     h.on('event', e => console.log(e))
 *   </script>
 *
 * or a floating widget with zero markup:
 *
 *   <script src="https://<your-hermes-origin>/embed.js" data-hermes></script>
 *
 * Two display modes:
 *  - Inline iframe — used when the host page is cross-origin isolated
 *    (COOP: same-origin + COEP: require-corp|credentialless). The in-browser
 *    backend needs SharedArrayBuffer, which only exists in isolated contexts.
 *  - Popup — automatic fallback on non-isolated hosts: the target shows a
 *    launcher card; the opened window is isolated by the app's own headers.
 *    Same API either way; embed-peer.js bridges via window.opener there.
 *
 * The agent, its vault worker, and all secrets run on the hermes origin —
 * the host page only ever sees the JSON-RPC surface it explicitly calls.
 * First API use from a new origin raises a consent prompt on the app side.
 */
(function () {
  'use strict'

  var NS = 'hermes-embed'
  // Default target = the origin this script was served from — a self-hosted
  // copy embeds its own deployment without configuration.
  var DEFAULT_SRC = window.location.origin
  try {
    if (document.currentScript && document.currentScript.src) {
      DEFAULT_SRC = new URL(document.currentScript.src).origin
    }
  } catch (e) { /* keep default */ }

  function frameSrc(base) {
    base = (base || DEFAULT_SRC).replace(/\/+$/, '')
    return base + '/?embed=1'
  }

  function originOf(base) {
    try { return new URL(base || DEFAULT_SRC).origin } catch (e) { return '*' }
  }

  // One channel per attached surface (iframe or popup): owns the postMessage
  // listener, pending call map, and event subscribers.
  function Channel(targetWin, base) {
    this.win = targetWin
    this.origin = originOf(base)
    this.nextId = 1
    this.pending = {}
    this.handlers = { event: [] }
    this.readyPromise = null
    this._onMessage = this._onMessage.bind(this)
    window.addEventListener('message', this._onMessage)
  }
  Channel.prototype._onMessage = function (ev) {
    var m = ev.data
    if (!m || m.ns !== NS) return
    if (ev.source !== this.win) return
    if (ev.origin !== this.origin && this.origin !== '*') return
    if (m.t === 'ready' || m.t === 'backend-ready') {
      if (this._readyResolve && m.t === 'backend-ready') this._readyResolve(this)
      this._emit('event', { type: m.t })
    } else if (m.t === 'result' || m.t === 'error') {
      var p = this.pending[m.id]
      if (!p) return
      delete this.pending[m.id]
      if (m.t === 'error') p.reject(new Error(m.error || 'call failed'))
      else p.resolve(m.result)
    } else if (m.t === 'event') {
      this._emit('event', m.payload)
    }
  }
  Channel.prototype._emit = function (name, payload) {
    var fns = this.handlers[name] || []
    for (var i = 0; i < fns.length; i++) {
      try { fns[i](payload) } catch (e) { /* host handler errors are theirs */ }
    }
  }
  Channel.prototype._send = function (m) {
    this.win.postMessage(Object.assign({ ns: NS, v: 1 }, m), this.origin)
  }
  Channel.prototype.call = function (method, params) {
    var self = this
    return new Promise(function (resolve, reject) {
      var id = 'e' + self.nextId++
      self.pending[id] = { resolve: resolve, reject: reject }
      self._send({ t: 'call', id: id, method: method, params: params || {} })
    })
  }
  Channel.prototype.prompt = function (sessionId, text) {
    return this.call('prompt.submit', { session_id: sessionId, text: text })
  }
  Channel.prototype.on = function (name, fn) {
    (this.handlers[name] = this.handlers[name] || []).push(fn)
    return this
  }
  Channel.prototype.off = function (name, fn) {
    var fns = this.handlers[name] || []
    var i = fns.indexOf(fn)
    if (i >= 0) fns.splice(i, 1)
    return this
  }
  Channel.prototype.ready = function () {
    var self = this
    if (!this.readyPromise) {
      this.readyPromise = new Promise(function (resolve) { self._readyResolve = resolve })
    }
    return this.readyPromise
  }
  Channel.prototype._failAll = function (reason) {
    for (var id in this.pending) {
      this.pending[id].reject(new Error(reason))
      delete this.pending[id]
    }
    this._emit('event', { type: 'closed', reason: reason })
  }
  Channel.prototype.unmount = function () {
    window.removeEventListener('message', this._onMessage)
    var el = this.el
    if (el && el.parentNode) el.parentNode.removeChild(el)
    this._failAll('unmounted')
  }

  function openPopup(base) {
    return window.open(frameSrc(base), 'hermes-agent',
      'width=940,height=700,menubar=no,toolbar=no,location=no,status=no')
  }

  function makeFrame(base) {
    var f = document.createElement('iframe')
    f.src = frameSrc(base)
    // cross-origin-isolated lets the iframe run SharedArrayBuffer/Atomics,
    // which the in-browser backend's blocking pump needs. clipboard-write and
    // microphone cover the copy button and the PWA voice grant.
    f.setAttribute('allow', 'cross-origin-isolated; clipboard-write; microphone')
    f.setAttribute('allowfullscreen', '')
    f.style.border = '0'
    f.style.width = '100%'
    f.style.height = '100%'
    f.style.display = 'block'
    return f
  }

  // Non-isolated hosts can't give an iframe SharedArrayBuffer, and COOP
  // severs window.opener on cross-origin popups — so no postMessage bridge
  // exists there at all. The fallback is a launcher card that opens the agent
  // as a standalone popup; the programmatic API rejects with a clear error.
  function mountLauncher(el, base) {
    var card = document.createElement('div')
    card.style.cssText =
      'width:100%;height:100%;min-height:120px;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:12px;background:#1b1b1f;' +
      'color:#eee;font-family:system-ui,sans-serif;border-radius:8px'
    var label = document.createElement('div')
    label.style.cssText = 'font-size:14px'
    label.textContent = 'Hermes Agent'
    var btn = document.createElement('button')
    btn.textContent = 'Open agent'
    btn.style.cssText =
      'padding:10px 22px;border-radius:8px;border:0;background:#4f7cff;' +
      'color:#fff;font-weight:600;cursor:pointer'
    card.appendChild(label)
    card.appendChild(btn)
    el.appendChild(card)
    var popup = null
    var open = function () {
      if (popup && !popup.closed) { popup.focus(); return popup }
      popup = openPopup(base)
      if (!popup) throw new Error('Hermes: popup blocked — allow popups for this site')
      return popup
    }
    btn.addEventListener('click', open)
    var noApi = function () {
      return Promise.reject(new Error(
        'Hermes API needs a cross-origin isolated host (COOP: same-origin + ' +
        'COEP: require-corp). On this page the agent runs as a standalone popup.'))
    }
    return {
      el: card,
      open: open,
      call: noApi,
      prompt: noApi,
      ready: noApi,
      on: function () { return this },
      unmount: function () { el.removeChild(card) },
    }
  }

  function mount(target, opts) {
    opts = opts || {}
    var el = typeof target === 'string' ? document.querySelector(target) : target
    if (!el) throw new Error('Hermes.mount: target not found')
    if (!window.crossOriginIsolated) {
      return mountLauncher(el, opts.src)
    }
    var frame = makeFrame(opts.src)
    el.appendChild(frame)
    var ch = new Channel(frame.contentWindow, opts.src)
    ch.el = frame
    return ch
  }

  function bubble(opts) {
    opts = opts || {}
    var open = false
    var btn = document.createElement('button')
    btn.setAttribute('aria-label', 'Open agent')
    btn.style.cssText =
      'position:fixed;right:20px;bottom:20px;width:56px;height:56px;' +
      'border-radius:50%;border:0;cursor:pointer;background:#1b1b1f;' +
      'color:#fff;font-size:24px;box-shadow:0 4px 16px rgba(0,0,0,.35);z-index:2147483647'
    btn.textContent = opts.icon || '✳'
    document.body.appendChild(btn)

    var panel = null
    var ch = null
    if (window.crossOriginIsolated) {
      panel = document.createElement('div')
      panel.style.cssText =
        'position:fixed;right:20px;bottom:88px;width:min(420px,calc(100vw - 40px));' +
        'height:min(640px,calc(100vh - 120px));border-radius:12px;overflow:hidden;' +
        'box-shadow:0 12px 40px rgba(0,0,0,.4);z-index:2147483647;display:none;' +
        'background:#fff'
      document.body.appendChild(panel)
    }
    var popup = null
    btn.addEventListener('click', function () {
      if (!panel) {
        // Non-isolated host: the popup is the only full-fidelity surface.
        // (No API bridge — COOP severs the opener cross-origin.)
        if (!popup || popup.closed) popup = openPopup(opts.src)
        else popup.focus()
        return
      }
      open = !open
      panel.style.display = open ? 'block' : 'none'
      if (open && !ch) {
        var frame = makeFrame(opts.src)
        panel.appendChild(frame)
        ch = new Channel(frame.contentWindow, opts.src)
        ch.el = frame
        if (opts.onEvent) ch.on('event', opts.onEvent)
      }
    })
    return {
      el: btn,
      open: function () { if (!open) btn.click() },
      close: function () { if (panel && open) btn.click() },
      channel: function () { return ch },
    }
  }

  window.Hermes = { mount: mount, bubble: bubble }

  // Auto-widget: <script src=".../embed.js" data-hermes></script>
  var me = document.currentScript
  if (me && me.hasAttribute('data-hermes')) {
    var boot = function () { bubble({ src: me.getAttribute('data-hermes-src') || undefined }) }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
    else boot()
  }
})()
