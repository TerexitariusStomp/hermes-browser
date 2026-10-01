/*
 * embed-peer.js — in-app side of the embeddable-agent bridge.
 *
 * Injected into every page load by assemble.mjs; activates only when the app
 * runs inside a frame (or ?embed=1). Opens its own /api/ws JSON-RPC socket —
 * routed to the in-browser backend by bootstrap's WebSocket shim — and
 * forwards host `call` frames onto it, returning `result`/`error` frames and
 * streaming backend `event` notifications to the host page.
 *
 * Consent: the first API call from an embedded surface prompts the user,
 * inside this origin, to allow the embedder origin. Grants persist in
 * localStorage — a hidden iframe cannot silently drive the user's agent.
 * Secrets never cross the boundary: vault resolution stays inside.
 */
(function () {
  'use strict'

  var framed = (function () {
    try { return window.parent !== window } catch (e) { return true }
  })()
  var embedParam = /[?&]embed\b/.test(window.location.search)
  if (!framed && !embedParam) return
  var host = framed ? window.parent : window.opener
  if (!host) return

  var hostOrigin = ''
  try { hostOrigin = new URL(document.referrer).origin } catch (e) { /* none */ }

  // penpal owns the postMessage handshake + origin validation + call
  // matching. We expose exactly one method: `call(method, params)`, still
  // consent-gated before touching the backend socket.
  var remote = null
  import('./vendor/penpal.mjs').then(function (mod) {
    var messenger = new mod.WindowMessenger({
      remoteWindow: host,
      allowedOrigins: hostOrigin ? [hostOrigin] : undefined,
    })
    var conn = mod.connect({
      messenger: messenger,
      timeout: 60000,
      methods: {
        call: function (method, params) {
          return ensureConsent().then(function (ok) {
            if (!ok) throw new Error('embedder not granted')
            return rpc(method, params)
          })
        },
      },
    })
    conn.promise.then(function (r) {
      remote = r
      remote.emitEvent({ type: 'ready' })
    }).catch(function (e) {
      console.error('[embed-peer] penpal connect failed: ' + e)
    })
  }).catch(function (e) {
    console.error('[embed-peer] penpal import failed: ' + e)
  })

  function emit(payload) {
    if (remote) {
      try { remote.emitEvent(payload) } catch (e) { /* detached */ }
    }
  }

  // --- per-origin consent grants -------------------------------------------

  var GRANTS_KEY = 'hermes.embed.grants'
  function grants() {
    try { return JSON.parse(localStorage.getItem(GRANTS_KEY) || '{}') } catch (e) { return {} }
  }
  function setGrant(origin, verdict) {
    var g = grants()
    g[origin] = verdict
    try { localStorage.setItem(GRANTS_KEY, JSON.stringify(g)) } catch (e) { /* ephemeral */ }
  }

  var consentShowing = null  // {origin, resolve} while the overlay is up
  function askConsent(origin) {
    if (consentShowing) return consentShowing.promise
    var resolveIt
    var promise = new Promise(function (r) { resolveIt = r })
    consentShowing = { origin: origin, promise: promise }
    var wrap = document.createElement('div')
    wrap.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483647;' +
      'display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif'
    var card = document.createElement('div')
    card.style.cssText =
      'background:#1b1b1f;color:#eee;border-radius:12px;padding:24px;max-width:380px;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.5)'
    var title = document.createElement('div')
    title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:10px'
    title.textContent = 'Embedded agent access'
    var body = document.createElement('div')
    body.style.cssText = 'font-size:13px;line-height:1.5;color:#bbb;margin-bottom:16px'
    body.textContent = (origin || 'The embedding site') +
      ' wants to drive this Hermes agent — it could submit prompts and run tools ' +
      'as you, including network requests using keys you have saved here.'
    var row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end'
    var deny = document.createElement('button')
    deny.textContent = 'Deny'
    deny.style.cssText = 'padding:8px 16px;border-radius:8px;border:1px solid #555;background:transparent;color:#eee;cursor:pointer'
    var allow = document.createElement('button')
    allow.textContent = 'Allow'
    allow.style.cssText = 'padding:8px 16px;border-radius:8px;border:0;background:#4f7cff;color:#fff;cursor:pointer;font-weight:600'
    var finish = function (verdict) {
      setGrant(origin, verdict)
      document.body.removeChild(wrap)
      consentShowing = null
      resolveIt(verdict === 'allow')
    }
    deny.addEventListener('click', function () { finish('deny') })
    allow.addEventListener('click', function () { finish('allow') })
    row.appendChild(deny); row.appendChild(allow)
    card.appendChild(title); card.appendChild(body); card.appendChild(row)
    wrap.appendChild(card)
    document.body.appendChild(wrap)
    return promise
  }

  function ensureConsent() {
    var g = grants()[hostOrigin]
    if (g === 'allow') return Promise.resolve(true)
    if (g === 'deny') return Promise.resolve(false)
    // A host origin we cannot name still gets consent keyed by 'unknown-embed'.
    return askConsent(hostOrigin || 'unknown-embed')
  }

  // --- backend ws ------------------------------------------------------------

  var sock = null
  var wsQueue = []
  var rpcNext = 1
  var rpcPending = {}

  function ws() {
    if (sock) return sock
    var token = (window.__HERMES_BOOTSTRAP__ || {}).sessionToken || ''
    sock = new WebSocket('/api/ws?token=' + encodeURIComponent(token))
    sock.onopen = function () {
      for (var i = 0; i < wsQueue.length; i++) sock.send(wsQueue[i])
      wsQueue = []
    }
    sock.onmessage = function (ev) {
      var m
      try { m = JSON.parse(ev.data) } catch (e) { return }
      if (m.id !== undefined && rpcPending[m.id]) {
        var p = rpcPending[m.id]
        delete rpcPending[m.id]
        if (m.error) p.reject(new Error(m.error.message || 'rpc error'))
        else p.resolve(m.result)
      } else if (m.method === 'event') {
        emit(m.params)
      }
    }
    sock.onclose = function () {
      sock = null
      for (var id in rpcPending) {
        rpcPending[id].reject(new Error('backend socket closed'))
        delete rpcPending[id]
      }
    }
    return sock
  }

  function rpc(method, params) {
    return new Promise(function (resolve, reject) {
      var id = 'emb-' + rpcNext++
      rpcPending[id] = { resolve: resolve, reject: reject }
      var s = ws()
      var frame = JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} })
      if (s.readyState === 1) s.send(frame)
      else wsQueue.push(frame)
    })
  }

  var readyTimer = setInterval(function () {
    if (window.__HERMES_BACKEND_READY__) {
      clearInterval(readyTimer)
      emit({ type: 'backend-ready' })
    }
  }, 500)
})()
