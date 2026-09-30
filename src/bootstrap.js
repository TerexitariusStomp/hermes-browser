/**
 * bootstrap.js — runs BEFORE the vendored Hermes dist-webapp bundle.
 *
 * Installs the __HERMES_* globals the upstream browser bridge reads, then
 * replaces window.fetch and window.WebSocket so every same-origin /api/*
 * call is served by the in-page Pyodide backend worker. The vendored
 * renderer is byte-identical to upstream.
 *
 * Transport: page -> worker over a SharedArrayBuffer ring + Atomics
 * doorbell (the worker can be blocked in Atomics.wait inside Python, so
 * postMessage alone cannot reach it). Worker -> page uses postMessage.
 */
(function () {
  'use strict'

  var BASE_PATH = ''
  var origin = window.location.origin

  // --- 1. Hermes webapp bootstrap globals -------------------------------
  window.__HERMES_UI_SURFACE__ = 'webapp'
  window.__HERMES_BASE_PATH__ = BASE_PATH
  window.__HERMES_AUTH_REQUIRED__ = false

  var sessionKey = 'hermes.webapp.session.v1:' + JSON.stringify([origin, BASE_PATH])
  var sessionToken
  try {
    sessionToken = sessionStorage.getItem(sessionKey)
    if (!sessionToken || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) {
      var bytes = new Uint8Array(32)
      crypto.getRandomValues(bytes)
      sessionToken = btoa(String.fromCharCode.apply(null, bytes))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 43)
      sessionStorage.setItem(sessionKey, sessionToken)
    }
  } catch (e) {
    sessionToken = 'x'.repeat(43)
  }

  // --- 2. Ring buffer to the backend worker ------------------------------
  var RING_CAP = 4 * 1024 * 1024
  var sab = new SharedArrayBuffer(16 + RING_CAP)
  var hdr = new Int32Array(sab, 0, 4)   // [0]=seq doorbell [1]=write [2]=read
  var data = new Uint8Array(sab, 16)
  var enc = new TextEncoder()
  var FRAG_MORE = 0x80000000            // len-field flag: more fragments follow
  var FRAG_MAX = 1024 * 1024            // fragment payload — always fits an empty ring
  var PENDING_MAX = 64 * 1024 * 1024    // queued-bytes cap before real drops

  function ringWriteRecord(record) {   // record: framed [len|flags][payload]
    var need = record.byteLength
    var w = Atomics.load(hdr, 1)
    var r = Atomics.load(hdr, 2)
    var free = (w >= r ? RING_CAP - (w - r) : r - w) - 1
    if (need > free) return false
    for (var i = 0; i < need; i++) data[(w + i) % RING_CAP] = record[i]
    w = (w + need) % RING_CAP
    Atomics.store(hdr, 1, w)
    Atomics.add(hdr, 0, 1)
    Atomics.notify(hdr, 0)
    return true
  }

  var pendingWrites = []               // FIFO of framed records awaiting space
  var pendingBytes = 0
  var flushTimer = null
  function flushPending() {
    flushTimer = null
    while (pendingWrites.length && ringWriteRecord(pendingWrites[0])) {
      pendingBytes -= pendingWrites.shift().byteLength
    }
    if (pendingWrites.length) flushTimer = setTimeout(flushPending, 4)
  }
  function enqueueRecord(record) {
    pendingWrites.push(record)
    pendingBytes += record.byteLength
    if (pendingBytes > PENDING_MAX) {
      var dropped = pendingWrites.shift()
      pendingBytes -= dropped.byteLength
      console.error('[hermes-web] ring backpressure overflow; dropped record')
    }
    flushPending()
  }

  function postToWorker(msg) {
    var bytes = enc.encode(JSON.stringify(msg))
    // Fragment oversized frames; single-producer ordering keeps fragments
    // contiguous — the worker concatenates until a record without FRAG_MORE.
    var dv = new DataView(new ArrayBuffer(4))
    if (bytes.length <= FRAG_MAX) {
      dv.setUint32(0, bytes.length, true)
      enqueueRecord(concatBytes(dv.buffer, bytes))
      return
    }
    for (var off = 0; off < bytes.length; off += FRAG_MAX) {
      var chunk = bytes.subarray(off, Math.min(off + FRAG_MAX, bytes.length))
      var last = off + FRAG_MAX >= bytes.length
      var h = new DataView(new ArrayBuffer(4))
      h.setUint32(0, last ? chunk.length : (chunk.length | FRAG_MORE), true)
      enqueueRecord(concatBytes(h.buffer, chunk))
    }
  }
  function concatBytes(a, b) {
    var out = new Uint8Array(a.byteLength + b.byteLength)
    out.set(new Uint8Array(a), 0)
    out.set(b, a.byteLength)
    return out
  }

  // --- 3. Vault boundary ------------------------------------------------
  // Secrets the user enters (model.save_key etc.) are intercepted BEFORE the
  // backend worker sees them: the raw value goes to the vault worker, and
  // the .env/config write carries only a `vault:<handle>` placeholder.
  // Outbound fetches resolving `vault:` placeholders go through the same
  // worker — key material never enters the Pyodide heap or page JS.

  var vaultWorker = new Worker('./vault-worker.mjs', { type: 'module' })
  var vaultNext = 1
  var vaultPending = {}
  var vaultDead = null
  vaultWorker.onmessage = function (ev) {
    var m = ev.data
    if (vaultPending[m.id]) {
      vaultPending[m.id](m)
      delete vaultPending[m.id]
    }
  }
  vaultWorker.onmessageerror = function (e) { console.error('[vault] messageerror ' + e) }
  function vaultFailAll(err) {
    vaultDead = err
    console.error('[vault] worker failed: ' + err)
    Object.keys(vaultPending).forEach(function (id) {
      vaultPending[id]({ id: Number(id), error: String(err) })
      delete vaultPending[id]
    })
  }
  vaultWorker.onerror = function (e) { vaultFailAll(e && e.message || 'worker error') }

  function vaultCall(op, payload) {
    return new Promise(function (resolve) {
      if (vaultDead) return resolve({ error: vaultDead })
      var id = vaultNext++
      vaultPending[id] = resolve
      setTimeout(function () {
        if (vaultPending[id]) {
          delete vaultPending[id]
          console.error('[vault] ' + op + ' timed out')
          resolve({ error: 'vault timeout' })
        }
      }, 15000)
      try {
        vaultWorker.postMessage(Object.assign({ id: id, op: op }, payload))
      } catch (e) {
        delete vaultPending[id]
        console.error('[vault] postMessage threw: ' + e)
        resolve({ error: String(e) })
      }
    })
  }

  var SECRET_WRITE_METHODS = {
    'model.save_key': ['api_key'],
    'model.save_credential': ['key', 'secret', 'api_key'],
    'config.set_secret': ['value'],
    'connectors.connect': ['token', 'api_key', 'secret'],
  }

  async function vaultResolveHeaders(headers, grant) {
    // Replace any `vault:<handle>` header values with the real secret.
    // `grant` is the broker grant of the session that originated the request;
    // the worker fails fast on handles outside its scope (remote sub-grants).
    var out = {}
    for (var k in headers) {
      var v = headers[k]
      if (typeof v === 'string' && v.indexOf('vault:') !== -1) {
        var resp = await vaultCall('resolveHeader', { value: v, grant: grant || undefined })
        if (resp && resp.error) throw new Error(resp.error)
        out[k] = (resp && resp.value) || v
      } else {
        out[k] = v
      }
    }
    return out
  }

  // --- 4. Backend worker --------------------------------------------------
  var worker = new Worker('./backend-worker.mjs', { type: 'module' })
  var rpcLog = (window.__HERMES_API_LOG__ = [])
  var bootReady = false
  var bootWaiters = []

  var pendingFetch = {}
  var sockets = {}
  var nextId = 1

  // --- Share-as-gateway: remote session state ----------------------------
  // A remote client (Desktop pointed at baseUrl+token, curl) arrives through
  // the relay as multiplexed frames. Each remote ws client gets a local
  // socket id in the same numeric space; each remote REST call a local fetch
  // id. Worker->page replies for those ids route back to the relay instead
  // of resolving a page-side promise.
  var share = null
  var remoteRest = {}     // localFetchId -> relay request id
  var remoteSocks = {}    // localSocketId -> cid
  var remoteByCid = {}    // cid -> localSocketId
  var rpcMethods = {}     // 'sockId:rpcId' -> method (for session.create results)

  // Mint a broker grant for a freshly created agent session, then bind it
  // worker-side so fetches on `prompt-turn-<sid>` carry the grant id.
  // Local sessions get full authority ('*', revocable); remote share clients
  // get a sub-grant of the share broker grant — default-deny on secrets.
  function bindSessionGrant(sid, isRemote) {
    var spec = isRemote
      ? { kind: 'remote', session_id: sid, parent: share && share.grant || null, handles: [] }
      : { kind: 'session', session_id: sid, handles: '*' }
    vaultCall('createGrant', spec).then(function (r) {
      if (r && r.grant) {
        postToWorker({ t: 'grant-bind', session: sid, grant: r.grant })
      }
    })
  }

  // Inspect an inbound JSON-RPC response for a session.create result.
  function maybeBindSession(sockId, data) {
    var m
    try { m = JSON.parse(data) } catch (e) { return }
    if (m.id === undefined) return
    var method = rpcMethods[sockId + ':' + m.id]
    delete rpcMethods[sockId + ':' + m.id]
    if (method === 'session.create' && m.result && m.result.session_id) {
      bindSessionGrant(m.result.session_id, remoteSocks[sockId] !== undefined)
    }
  }

  function trackRpcMethod(sockId, data) {
    var m
    try { m = JSON.parse(data) } catch (e) { return }
    if (m.method !== undefined && m.id !== undefined) {
      rpcMethods[sockId + ':' + m.id] = m.method
    }
  }

  worker.onmessage = function (ev) {
    var msg = ev.data
    if (msg.type === 'fetch-response' && remoteRest[msg.id] !== undefined) {
      var rid = remoteRest[msg.id]
      delete remoteRest[msg.id]
      shareSend({ t: 'rest-res', id: rid, status: msg.status, headers: msg.headers, bodyB64: msg.bodyB64 })
      return
    }
    if (msg.type === 'ws-event' && remoteSocks[msg.id] !== undefined) {
      var cid = remoteSocks[msg.id]
      if (msg.event === 'open') {
        shareSend({ t: 'ws-opened', cid: cid })
      } else if (msg.event === 'message') {
        maybeBindSession(msg.id, msg.data)
        shareSend({ t: 'ws-msg', cid: cid, data: msg.data })
      } else if (msg.event === 'close' || msg.event === 'error') {
        shareSend({ t: 'ws-close', cid: cid, code: msg.code || 1000, reason: msg.reason || '' })
        delete remoteSocks[msg.id]
        if (remoteByCid[cid] === msg.id) delete remoteByCid[cid]
      }
      return
    }
    if (msg.type === 'fetch-response' && pendingFetch[msg.id]) {
      var p = pendingFetch[msg.id]
      delete pendingFetch[msg.id]
      var bodyBytes = null
      if (msg.bodyB64) {
        var bin = atob(msg.bodyB64)
        bodyBytes = new Uint8Array(bin.length)
        for (var i = 0; i < bin.length; i++) bodyBytes[i] = bin.charCodeAt(i)
      }
      p.resolve(new Response(bodyBytes, { status: msg.status, headers: msg.headers }))
    } else if (msg.type === 'ws-event' && sockets[msg.id]) {
      sockets[msg.id]._onWorkerEvent(msg)
    } else if (msg.type === 'net-request') {
      handleNetRequest(msg)
    } else if (msg.type === 'substrate-request') {
      substrateCall(msg.op, msg.args || {}).then(function (result) {
        postToWorker({ t: 'substrate-resp', id: msg.id, result: result })
      })
    } else if (msg.type === 'wasi-request') {
      wasiCall(msg.op, msg.args || {}).then(function (result) {
        postToWorker({ t: 'wasi-resp', id: msg.id, result: result })
      })
    } else if (msg.type === 'pwa-request') {
      handlePwaRequest(msg)
    } else if (msg.type === 'host-request') {
      handleHostRequest(msg)
    } else if (msg.type === 'log') {
      (msg.stream === 'err' ? console.warn : console.log)('[backend]', msg.text)
    } else if (msg.type === 'boot-ready') {
      bootReady = true
      window.__HERMES_BACKEND_READY__ = true
      bootWaiters.splice(0).forEach(function (f) { f() })
    } else if (msg.type === 'boot-failed') {
      console.error('[hermes-web] backend boot failed:', msg.error)
    }
  }

  // The backend's Python httpx transport asks the page to perform fetches so
  // vault resolution happens outside the agent's heap.
  // --- local model endpoint ----------------------------------------------
  // `local-llm.hermes` never hits the network: requests route to the in-page
  // wllama engine (local-llm.js, lazy-loaded). OpenAI-compatible surface so
  // upstream's named-provider machinery drives it unchanged. No secrets
  // involved — vault is bypassed by design (weights are public).
  var LOCAL_LLM_HOST = 'local-llm.hermes'
  var localLlmMod = null

  function handleLocalLlm(msg) {
    var u
    try {
      u = new URL(msg.url)
    } catch (e) {
      postToWorker({ t: 'net-resp', id: msg.id, status: 400, headers: {}, body: '' })
      return
    }
    var bodyText = ''
    if (msg.bodyB64) {
      try {
        var raw = Uint8Array.from(atob(msg.bodyB64), function (c) { return c.charCodeAt(0) })
        bodyText = new TextDecoder().decode(raw)
      } catch (e) {}
    }
    var modP = localLlmMod
      ? Promise.resolve(localLlmMod)
      : import('./local-llm.js').then(function (m) { localLlmMod = m; return m })
    console.log('[local-llm] ' + msg.method + ' ' + u.pathname)
    modP.then(function (m) {
      return m.handleRequest(u.pathname, msg.method, bodyText)
    }).then(function (r) {
      var b = unescape(encodeURIComponent(r.body || ''))
      postToWorker({ t: 'net-resp', id: msg.id, status: r.status, headers: r.headers || {}, body: btoa(b) })
    }).catch(function (e) {
      console.log('[local-llm] ERR ' + String(e).slice(0, 200))
      postToWorker({ t: 'net-resp', id: msg.id, status: 500, headers: { 'content-type': 'application/json' },
        body: btoa(JSON.stringify({ error: { message: String(e).slice(0, 300) } })) })
    })
  }

  // --- PWA grant bridge ---------------------------------------------------
  // Browser-native capability ops (notifications, FSA, mic, wake lock,
  // periodic sync) run against the page's own APIs via pwa-bridge.js —
  // fixed op vocabulary, no code crosses the boundary.
  var pwaMod = null

  function handlePwaRequest(msg) {
    var modP = pwaMod
      ? Promise.resolve(pwaMod)
      : import('./pwa-bridge.js').then(function (m) { pwaMod = m; return m })
    modP.then(function (m) {
      return m.handle(msg.op, msg.args || {})
    }).then(function (result) {
      postToWorker({ t: 'pwa-resp', id: msg.id, result: result })
    }).catch(function (e) {
      postToWorker({ t: 'pwa-resp', id: msg.id, result: { error: String(e).slice(0, 300) } })
    })
  }

  // --- Local host substrate (P6/T3, opt-in) -------------------------------
  // Fixed-op bridge to a companion host-agent.py the user runs on their own
  // machine; the pairing token resolves via vault like provider secrets.
  var hostMod = null

  function handleHostRequest(msg) {
    var modP = hostMod
      ? Promise.resolve(hostMod)
      : import('./host-bridge.js').then(function (m) { hostMod = m; return m })
    modP.then(function (m) {
      return m.handle(msg.op, msg.args || {}, {
        vaultCall: vaultCall,
        resolveHeaders: function (h) { return vaultResolveHeaders(h, '') },
      })
    }).then(function (result) {
      postToWorker({ t: 'host-resp', id: msg.id, result: result })
    }).catch(function (e) {
      postToWorker({ t: 'host-resp', id: msg.id, result: { error: String(e).slice(0, 300) } })
    })
  }

  function handleNetRequest(msg) {
    try {
      if (new URL(msg.url).hostname === LOCAL_LLM_HOST) {
        handleLocalLlm(msg)
        return
      }
    } catch (e) {}
    vaultResolveHeaders(msg.headers || {}, msg.grant).then(function (headers) {
      // Bare-browser fetch is subject to each provider's CORS header
      // allowlist; headers outside it fail preflight. x-stainless-* are
      // OpenAI-SDK build diagnostics with no request semantics; upstream's
      // X-OpenRouter-Cache(-TTL) response-cache hints are absent from
      // openrouter.ai's Access-Control-Allow-Headers (they degrade to
      // uncached responses, the request still succeeds). Non-CORS-capable
      // providers belong on the extension/native substrate instead.
      var HOST_HEADER_DENY = {
        'openrouter.ai': ['x-openrouter-cache', 'x-openrouter-cache-ttl'],
      }
      var hostDeny = null
      try {
        hostDeny = HOST_HEADER_DENY[new URL(msg.url).hostname] || null
      } catch (e) {}
      Object.keys(headers).forEach(function (k) {
        var kl = k.toLowerCase()
        if (kl.indexOf('x-stainless-') === 0) delete headers[k]
        else if (hostDeny && hostDeny.indexOf(kl) !== -1) delete headers[k]
      })
      var init = { method: msg.method, headers: headers }
      if (msg.bodyB64) init.body = Uint8Array.from(atob(msg.bodyB64), function (c) { return c.charCodeAt(0) })
      var urlTag = msg.url.split('?')[0]
      console.log('[net] -> ' + msg.method + ' ' + urlTag)
      return realFetch(msg.url, init).then(function (resp) {
        console.log('[net] ' + msg.method + ' ' + urlTag + ' -> ' + resp.status)
        return resp.arrayBuffer().then(function (ab) {
          var bytes = new Uint8Array(ab)
          // Chunked base64: byte-at-a-time concat is O(n²) and a ~30MB catalog
          // response wedges the page main thread for minutes.
          var bin = ''
          var CH = 0x8000
          for (var i = 0; i < bytes.length; i += CH)
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH))
          var hs = {}
          resp.headers.forEach(function (v, k) { hs[k] = v })
          postToWorker({ t: 'net-resp', id: msg.id, status: resp.status, headers: hs, body: btoa(bin) })
        })
      })
    }).catch(function (e) {
      console.log('[net] ' + msg.method + ' ' + msg.url.split('?')[0] + ' -> ERR ' + String(e).slice(0, 120))
      postToWorker({ t: 'net-resp', id: msg.id, status: 599, headers: {}, body: '', error: String(e) })
    })
  }

  // --- 5. fetch shim ------------------------------------------------------
  var realFetch = window.fetch
  window.fetch = function (input, init) {
    var url
    try {
      var href = input instanceof Request ? input.url : String(input)
      url = new URL(href, origin)
    } catch (e) {
      return realFetch.apply(this, arguments)
    }
    if (url.origin !== origin || !url.pathname.startsWith('/api/')) {
      return realFetch.apply(this, arguments)
    }
    var method = (init && init.method) || (input && input.method) || 'GET'
    rpcLog.push({ kind: 'rest', method: method, path: url.pathname + url.search, ts: Date.now() })
    return new Promise(function (resolve, reject) {
      var id = nextId++
      pendingFetch[id] = { resolve: resolve, reject: reject }
      var bodyPromise
      if (init && init.body !== undefined && init.body !== null) {
        if (typeof init.body === 'string') bodyPromise = Promise.resolve({ text: init.body })
        else if (init.body instanceof Blob) {
          bodyPromise = init.body.arrayBuffer().then(function (ab) {
            var b = new Uint8Array(ab), s = ''
            for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
            return { b64: btoa(s), type: init.body.type }
          })
        } else bodyPromise = Promise.resolve({ text: String(init.body) })
      } else if (input instanceof Request && input.method !== 'GET' && input.method !== 'HEAD') {
        bodyPromise = input.arrayBuffer().then(function (ab) {
          var b = new Uint8Array(ab), s = ''
          for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
          return { b64: btoa(s) }
        })
      } else bodyPromise = Promise.resolve(null)
      bodyPromise.then(function (body) {
        // A real browser request carries Host/Origin; the shim synthesizes
        // them so the app's DNS-rebinding middleware sees the true surface.
        // Headers may arrive as a Headers instance, a Request, a pair array,
        // or a plain object — normalize through Headers, then flatten.
        var hdrs = {}
        var merge = function (h) {
          if (!h) return
          new Headers(h).forEach(function (v, k) { hdrs[k] = v })
        }
        merge(input instanceof Request ? input.headers : null)
        merge(init && init.headers)
        if (!hdrs.host) hdrs.host = url.host
        // Ambient private-session auth — the same credential upstream injects
        // into index.html. Callers that already set the header keep theirs.
        if (!hdrs['x-hermes-session-token'] && !hdrs['authorization']) {
          hdrs['x-hermes-session-token'] = sessionToken
        }
        postToWorker({
          t: 'rest', id: id, method: method,
          path: url.pathname + url.search,
          headers: hdrs,
          body: body,
        })
      }).catch(reject)
    })
  }

  // --- 6. WebSocket shim --------------------------------------------------
  var RealWebSocket = window.WebSocket

  function LocalSocket(url, protocols) {
    var u = new URL(url, origin)
    this.url = url
    this.readyState = 0
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null
    this._id = nextId++
    this._listeners = {}
    this._queue = []
    sockets[this._id] = this
    rpcLog.push({ kind: 'ws-open', path: u.pathname + u.search, ts: Date.now() })
    var wsHeaders = { host: u.host, origin: window.location.origin }
    if (protocols) {
      wsHeaders['sec-websocket-protocol'] =
        Array.isArray(protocols) ? protocols.join(', ') : String(protocols)
    }
    postToWorker({ t: 'ws-open', id: this._id, path: u.pathname + u.search, headers: wsHeaders })
    this._path = u.pathname + u.search
  }
  LocalSocket.CONNECTING = 0; LocalSocket.OPEN = 1
  LocalSocket.CLOSING = 2; LocalSocket.CLOSED = 3
  LocalSocket.prototype = {
    get CONNECTING() { return 0 }, get OPEN() { return 1 },
    get CLOSING() { return 2 }, get CLOSED() { return 3 },
    send: function (d) {
      if (this.readyState === 0) { this._queue.push(d); return }
      if (this.readyState !== 1) { throw new Error('WebSocket is not open') }
      var self = this
      trackRpcMethod(this._id, d)
      // Intercept secret writes: strip the raw key, store via vault worker,
      // forward only the vault: handle downstream.
      var handled = maybeVaultWrite(d, this._id)
      if (handled) {
        handled.then(function (rewritten) {
          if (rewritten) {
            rpcLog.push({ kind: 'ws-send', id: self._id, data: rewritten.slice(0, 4000), ts: Date.now() })
            postToWorker({ t: 'ws-send', id: self._id, data: rewritten })
          }
        }).catch(function (e) { console.error('[vault] write chain failed: ' + e) })
        return
      }
      rpcLog.push({ kind: 'ws-send', id: this._id, data: String(d).slice(0, 4000), ts: Date.now() })
      postToWorker({ t: 'ws-send', id: this._id, data: d })
    },
    close: function (code, reason) {
      if (this.readyState >= 2) return
      this.readyState = 3
      postToWorker({ t: 'ws-close', id: this._id, code: code, reason: reason })
      this._fire('close', { code: code || 1000, reason: reason || '', wasClean: true })
    },
    addEventListener: function (t, f) { (this._listeners[t] = this._listeners[t] || []).push(f) },
    removeEventListener: function (t, f) {
      var l = this._listeners[t] || []
      var i = l.indexOf(f); if (i >= 0) l.splice(i, 1)
    },
    _fire: function (t, ev) {
      ev = ev || {}; ev.type = t; if (ev.target === undefined) ev.target = this
      if (typeof this['on' + t] === 'function') this['on' + t](ev)
      var l = this._listeners[t] || []
      for (var i = 0; i < l.length; i++) l[i].call(this, ev)
    },
    _onWorkerEvent: function (msg) {
      if (msg.event === 'open') {
        this.readyState = 1
        this._fire('open')
        for (var i = 0; i < this._queue.length; i++) this.send(this._queue[i])
        this._queue = []
      } else if (msg.event === 'message') {
        rpcLog.push({ kind: 'ws-recv', id: this._id, data: String(msg.data).slice(0, 4000), ts: Date.now() })
        maybeBindSession(this._id, msg.data)
        this._fire('message', { data: msg.data })
      } else if (msg.event === 'close') {
        this.readyState = 3
        this._fire('close', { code: msg.code || 1000, reason: msg.reason || '', wasClean: true })
      } else if (msg.event === 'error') {
        this._fire('error', {})
      }
    },
  }

  function maybeVaultWrite(data, sockId) {
    var parsed
    try { parsed = JSON.parse(data) } catch (e) { return null }
    var fields = parsed && SECRET_WRITE_METHODS[parsed.method]
    if (!fields) return null
    var copies = fields.filter(function (f) { return parsed.params && typeof parsed.params[f] === 'string' })
    if (!copies.length) return null
    var isRemote = sockId !== undefined && remoteSocks[sockId] !== undefined
    console.log('[vault] storeSecret for ' + parsed.method + ' fields=' + copies.join(','))
    return Promise.all(copies.map(function (f) {
      return vaultCall('storeSecret', { value: parsed.params[f], label: parsed.method + ':' + f })
        .then(function (resp) {
          // Never forward the raw secret — a failed store becomes an explicit
          // dead placeholder so downstream resolution fails loudly.
          parsed.params[f] = resp && resp.handle ? 'vault:' + resp.handle : 'vault:unavailable'
          // Remote-sourced secrets belong to the remote grants' scope —
          // they were never the browser's own to begin with.
          if (isRemote && resp && resp.handle) {
            vaultCall('grantAddHandle', { grant: share.grant, handle: resp.handle })
            vaultCall('listGrants').then(function (r) {
              ;(r && r.grants || []).forEach(function (g) {
                if (g.parent === share.grant && !g.revoked)
                  vaultCall('grantAddHandle', { grant: g.grant, handle: resp.handle })
              })
            })
          }
        })
    })).then(function () { return JSON.stringify(parsed) })
  }

  window.WebSocket = function (url, protocols) {
    try {
      var u = new URL(url, origin)
      if (u.host === window.location.host && u.pathname.startsWith('/api/')) {
        return new LocalSocket(url, protocols)
      }
    } catch (e) { /* fall through */ }
    return protocols !== undefined ? new RealWebSocket(url, protocols) : new RealWebSocket(url)
  }
  window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1
  window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3
  window.WebSocket.prototype = RealWebSocket.prototype

  // --- 6b. Extension substrate client ------------------------------------
  // The Hermes substrate extension's content script exposes fixed browser ops
  // (navigate/click/type/scroll/snapshot/screenshot on agent-owned tabs,
  // grant-gated + audited there). Page JS supplies only data — never code.
  // Responses ride the same ECDH channel as the fetch bridge: the page
  // mints an ephemeral keypair, the extension encrypts results to it.

  var subKeyPairPromise = crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey'])
  var substrateExtPub = null   // JWK — learned from rooted-extension-pong
  var substratePresent = null  // null = unknown, true/false after first ping
  var substratePending = {}
  var substrateSeq = 1

  function hexToBytes(h) {
    var b = new Uint8Array(h.length / 2)
    for (var i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
    return b
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data) return
    var d = ev.data
    if (d.type === 'rooted-extension-pong' && d.pubKey) {
      substrateExtPub = d.pubKey
      substratePresent = true
    } else if (d.type === 'hermes-substrate-response') {
      var p = substratePending[d.id]
      if (p) { delete substratePending[d.id]; p(d) }
    }
  })

  function substratePing(timeoutMs) {
    if (substratePresent === true) return Promise.resolve(true)
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        if (substratePresent === null) substratePresent = false
        resolve(substratePresent === true)
      }, timeoutMs || 800)
      window.postMessage({ type: 'rooted-extension-ping', id: 'subping' + Date.now() }, window.location.origin)
      // pong handler sets substratePresent; resolve early if it lands
      var poll = setInterval(function () {
        if (substratePresent === true) { clearInterval(poll); clearTimeout(timer); resolve(true) }
      }, 40)
    })
  }

  function substrateCall(op, args, opts) {
    return substratePing().then(function (present) {
      if (!present) return { error: 'extension_absent' }
      return subKeyPairPromise.then(function (kp) {
        return crypto.subtle.exportKey('jwk', kp.publicKey).then(function (ephPub) {
          var id = 'sub' + (substrateSeq++)
          return new Promise(function (resolve) {
            var timer = setTimeout(function () {
              delete substratePending[id]
              resolve({ error: 'substrate_timeout' })
            }, (opts && opts.timeoutMs) || 90000)
            substratePending[id] = function (d) {
              clearTimeout(timer)
              if (d.error) return resolve({ error: d.error })
              if (d.result) return resolve(d.result)
              if (d.iv && d.ct && substrateExtPub) {
                crypto.subtle.importKey('jwk', substrateExtPub,
                  { name: 'ECDH', namedCurve: 'P-256' }, false, []
                ).then(function (extPub) {
                  return crypto.subtle.deriveKey(
                    { name: 'ECDH', public: extPub }, kp.privateKey,
                    { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
                }).then(function (shared) {
                  return crypto.subtle.decrypt(
                    { name: 'AES-GCM', iv: hexToBytes(d.iv) }, shared, hexToBytes(d.ct))
                }).then(function (pt) {
                  resolve(JSON.parse(new TextDecoder().decode(pt)))
                }).catch(function () { resolve({ error: 'decrypt_failed' }) })
                return
              }
              resolve({ error: 'empty_response' })
            }
            window.postMessage({
              type: 'hermes-substrate-call', id: id, op: op,
              args: args || {}, ephPub: ephPub,
            }, window.location.origin)
          })
        })
      })
    })
  }

  window.__HERMES_SUBSTRATE__ = {
    call: substrateCall,
    present: substratePing,
  }
  // Read-side vault surface for the grants UI and smoke tests — stores and
  // resolutions still flow through the same worker ops; nothing here hands
  // raw secret values to page JS (resolve ops return to the worker only).
  window.__HERMES_VAULT__ = { call: vaultCall }

  // --- 6b. WASI runner (in-page cowasm userspace) ---------------------------
  // The runner bundle is lazily imported on first wasi op — it installs
  // window.__HERMES_WASI__ and boots the cowasm kernel on demand. Until it
  // loads, ops report unavailable honestly rather than pretending a shell
  // exists.

  var wasiRunnerPromise = null
  function wasiRunner() {
    if (!wasiRunnerPromise) {
      wasiRunnerPromise = import('./wasi/wasi-runner.js').then(function () {
        var r = window.__HERMES_WASI__
        if (!r || typeof r.call !== 'function') throw new Error('wasi runner did not register')
        return r
      })
      wasiRunnerPromise.catch(function () { wasiRunnerPromise = null })
    }
    return wasiRunnerPromise
  }

  function wasiCall(op, args) {
    return wasiRunner().then(function (runner) {
      return runner.call(op, args || {})
    }).then(function (r) {
      return r && typeof r === 'object' ? r : { error: 'wasi_bad_response' }
    }).catch(function (e) {
      if (op === 'status') {
        return { available: false, reason: String(e && e.message || e) }
      }
      return { error: String(e && e.message || e) }
    })
  }

  // --- 7. Share-as-gateway -----------------------------------------------
  // The tab dials OUT to a rendezvous relay; remote
  // clients arrive multiplexed over that one socket and are fed into the
  // same worker frames the local webapp uses — upstream code sees a stock
  // sidecar socket, the relay sees only opaque envelopes. Secret writes
  // from remote clients get the same vault interception as local ones.

  function shareSend(obj) {
    if (share && share.ws && share.ws.readyState === 1) {
      share.ws.send(JSON.stringify(obj))
    }
  }

  function onRelayMessage(ev) {
    var m
    try { m = JSON.parse(ev.data) } catch (e) { return }
    if (m.t === 'ws-open' && typeof m.cid === 'string') {
      var id = nextId++
      remoteSocks[id] = m.cid
      remoteByCid[m.cid] = id
      // Synthesize the same upgrade the local webapp makes: same session
      // token, same host/origin — upstream's guard sees a stock sidecar.
      postToWorker({
        t: 'ws-open', id: id,
        path: '/api/ws?token=' + sessionToken,
        headers: { host: window.location.host, origin: window.location.origin },
      })
    } else if (m.t === 'ws-msg' && typeof m.cid === 'string') {
      var lid = remoteByCid[m.cid]
      if (lid === undefined) return
      trackRpcMethod(lid, m.data)
      var handled = maybeVaultWrite(m.data, lid)   // remote secret writes -> vault too
      if (handled) {
        handled.then(function (rw) { if (rw) postToWorker({ t: 'ws-send', id: lid, data: rw }) })
      } else {
        postToWorker({ t: 'ws-send', id: lid, data: m.data })
      }
    } else if (m.t === 'ws-close' && typeof m.cid === 'string') {
      var lid2 = remoteByCid[m.cid]
      if (lid2 === undefined) return
      postToWorker({ t: 'ws-close', id: lid2, code: m.code, reason: m.reason })
    } else if (m.t === 'rest' && typeof m.id === 'string') {
      var rid = nextId++
      remoteRest[rid] = m.id
      var hdrs = Object.assign({}, m.headers)
      delete hdrs['x-hermes-session-token']
      delete hdrs['authorization']
      hdrs['x-hermes-session-token'] = sessionToken
      hdrs.host = window.location.host
      postToWorker({
        t: 'rest', id: rid, method: m.method || 'GET',
        path: m.path, headers: hdrs,
        body: m.bodyB64 ? { b64: m.bodyB64 } : null,
      })
    } else if (m.t === 'end') {
      stopShare(m.reason || 'ended')
    }
  }

  function defaultRelayBase() {
    return window.__HERMES_RELAY_URL__ ||
      (function () { try { return localStorage.getItem('hermes.relayUrl') } catch (e) { return null } })() ||
      window.location.origin
  }

  function startShare(relayBase) {
    relayBase = (relayBase || defaultRelayBase()).replace(/\/+$/, '')
    if (share) return Promise.resolve(share.meta)
    return realFetch(relayBase + '/s', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then(function (res) {
      if (!res.ok) throw new Error('relay mint failed: ' + res.status)
      return res.json()
    }).then(function (meta) {
      // Broker grant the remote sessions sub-scope under — revoking it (via
      // stopShare or the grants UI) locks every remote client out of vault.
      return vaultCall('createGrant', { kind: 'broker', handles: '*' }).then(function (r) {
        return { meta: meta, grant: (r && r.grant) || null }
      })
    }).then(function (m0) {
      var meta = m0.meta
      var wsBase = relayBase.replace(/^http/, 'ws')
      var ws = new RealWebSocket(wsBase + '/s/' + meta.sid + '/agent?token=' + encodeURIComponent(meta.agentToken))
      share = { ws: ws, meta: meta, grant: m0.grant, relayBase: relayBase, state: 'connecting' }
      ws.onmessage = onRelayMessage
      ws.onopen = function () { if (share) { share.state = 'live'; updateShareUI() } }
      ws.onclose = function () {
        if (share && share.ws === ws) stopShare('relay-closed')
      }
      ws.onerror = function () { if (share) { share.state = 'error'; updateShareUI() } }
      updateShareUI()
      return meta
    })
  }

  function stopShare(reason) {
    if (!share) return Promise.resolve()
    var s = share
    // Tear down server-side first so the session is gone before the agent
    // socket closes (and clients get a definite end, not a dangling 503).
    var done = realFetch(s.relayBase + '/s/' + s.meta.sid + '?token=' + encodeURIComponent(s.meta.agentToken), { method: 'DELETE' })
      .catch(function () { /* offline — DO expires on its own */ })
      .then(function () {
        try { s.ws.close(1000, reason || 'stopped') } catch (e) { /* gone */ }
      })
    // Tell the backend every remote socket is gone.
    for (var lid in remoteSocks) postToWorker({ t: 'ws-close', id: Number(lid), code: 1001, reason: 'share-ended' })
    remoteSocks = {}
    remoteByCid = {}
    remoteRest = {}
    // Revoke the broker grant and every remote sub-grant it minted — any
    // in-flight or future vault resolution by those sessions fails fast.
    if (s.grant) {
      vaultCall('revokeGrant', { grant: s.grant })
      vaultCall('listGrants').then(function (r) {
        ;(r && r.grants || []).forEach(function (g) {
          if (g.parent === s.grant && !g.revoked) vaultCall('revokeGrant', { grant: g.grant })
        })
      })
    }
    share = null
    updateShareUI()
    return done
  }

  window.__HERMES_SHARE__ = {
    start: startShare,
    stop: stopShare,
    get session() { return share && share.meta },
    get state() { return share ? share.state : 'off' },
  }

  // --- Share UI: self-contained chip + dialog ----------------------------
  // The vendored webapp is byte-identical upstream; the share surface is a
  // floating control injected by this bootstrap so no upstream file changes.
  var shareChip, sharePanel, shareBody
  function updateShareUI() {
    if (!shareChip) return
    var on = !!share
    shareChip.textContent = on ? (share.state === 'live' ? 'Gateway live' : 'Gateway: ' + share.state) : 'Share gateway'
    shareChip.style.borderColor = on && share.state === 'live' ? '#4caf50' : ''
    if (sharePanel && sharePanel.style.display !== 'none') renderSharePanel()
  }
  function renderSharePanel() {
    if (!shareBody) return
    if (!share) {
      shareBody.innerHTML = ''
      var p = document.createElement('p')
      p.textContent = 'Expose this tab as a remote Hermes gateway. Point Desktop (Settings → Gateway) or any stock client at the URL + token. Everything stays client-side; the relay only pipes frames.'
      p.style.cssText = 'margin:0 0 10px;color:#bbb;font-size:12px;line-height:1.5'
      var btn = document.createElement('button')
      btn.textContent = 'Start sharing'
      btn.style.cssText = 'padding:6px 14px;background:#4caf50;color:#fff;border:0;border-radius:4px;cursor:pointer'
      btn.onclick = function () {
        btn.disabled = true; btn.textContent = 'Starting…'
        startShare().catch(function (e) {
          btn.disabled = false; btn.textContent = 'Start sharing'
          var err = document.createElement('div')
          err.style.cssText = 'color:#f66;font-size:12px;margin-top:8px'
          err.textContent = String(e)
          shareBody.appendChild(err)
        }).then(function () { updateShareUI() })
      }
      shareBody.appendChild(p); shareBody.appendChild(btn)
      return
    }
    var rows = [
      ['Status', share.state],
      ['baseUrl', share.meta.baseUrl],
      ['token', share.meta.token],
    ]
    shareBody.innerHTML = ''
    var hint = document.createElement('p')
    hint.textContent = 'In Hermes Desktop: Settings → Gateway → remote → paste baseUrl + token.'
    hint.style.cssText = 'margin:0 0 8px;color:#bbb;font-size:12px'
    shareBody.appendChild(hint)
    rows.forEach(function (r) {
      var div = document.createElement('div')
      div.style.cssText = 'font-size:12px;margin:4px 0;word-break:break-all'
      var b = document.createElement('b'); b.textContent = r[0] + ': '
      var span = document.createElement('span'); span.textContent = r[1]
      span.style.cssText = 'font-family:monospace;color:#9fd'
      div.appendChild(b); div.appendChild(span); shareBody.appendChild(div)
    })
    var stop = document.createElement('button')
    stop.textContent = 'Stop sharing'
    stop.style.cssText = 'margin-top:8px;padding:6px 14px;background:#a33;color:#fff;border:0;border-radius:4px;cursor:pointer'
    stop.onclick = function () { stopShare('stopped'); updateShareUI() }
    shareBody.appendChild(stop)
  }
  function injectShareUI() {
    if (shareChip || !document.body) return
    shareChip = document.createElement('button')
    shareChip.textContent = 'Share gateway'
    shareChip.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:99999;padding:6px 12px;' +
      'background:#222;color:#ddd;border:1px solid #555;border-radius:14px;font-size:12px;cursor:pointer;opacity:.85'
    sharePanel = document.createElement('div')
    sharePanel.style.cssText = 'display:none;position:fixed;right:14px;bottom:52px;z-index:99999;width:340px;' +
      'background:#181818;color:#eee;border:1px solid #444;border-radius:8px;padding:14px;box-shadow:0 4px 24px #000a'
    shareBody = document.createElement('div')
    sharePanel.appendChild(shareBody)
    shareChip.onclick = function () {
      sharePanel.style.display = sharePanel.style.display === 'none' ? 'block' : 'none'
      renderSharePanel()
    }
    document.body.appendChild(shareChip)
    document.body.appendChild(sharePanel)

    // Grants panel — per-capability revoke over vault handles and broker
    // grants. Revoking a grant tombstones it in the worker; every future
    // resolve under it fails fast (instant lockout for remote sessions).
    var gChip = document.createElement('button')
    gChip.textContent = 'Grants'
    gChip.style.cssText = 'position:fixed;right:124px;bottom:14px;z-index:99999;padding:6px 12px;' +
      'background:#222;color:#ddd;border:1px solid #555;border-radius:14px;font-size:12px;cursor:pointer;opacity:.85'
    var gPanel = document.createElement('div')
    gPanel.style.cssText = 'display:none;position:fixed;right:124px;bottom:52px;z-index:99999;width:380px;max-height:60vh;overflow:auto;' +
      'background:#181818;color:#eee;border:1px solid #444;border-radius:8px;padding:14px;box-shadow:0 4px 24px #000a'

    function gRow(text, onRevoke) {
      var d = document.createElement('div')
      d.style.cssText = 'display:flex;justify-content:space-between;align-items:center;' +
        'padding:5px 0;border-bottom:1px solid #2a2a2a;font-size:12px'
      var s = document.createElement('span')
      s.textContent = text
      s.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:270px'
      d.appendChild(s)
      var b = document.createElement('button')
      b.textContent = 'Revoke'
      b.style.cssText = 'padding:2px 8px;background:#5a2020;color:#fbb;border:1px solid #833;border-radius:4px;cursor:pointer;font-size:11px'
      b.onclick = function () { onRevoke().then(renderGrants) }
      d.appendChild(b)
      return d
    }

    function renderGrants() {
      gPanel.innerHTML = ''
      var h = document.createElement('div')
      h.textContent = 'Vault secrets & grants'
      h.style.cssText = 'font-weight:600;margin-bottom:8px;font-size:13px'
      gPanel.appendChild(h)
      vaultCall('list').then(function (r) {
        var hs = (r && r.handles) || []
        if (!hs.length) {
          var e = document.createElement('div')
          e.textContent = 'No secrets in vault.'
          e.style.cssText = 'color:#999;font-size:12px'
          gPanel.appendChild(e)
        }
        hs.forEach(function (x) {
          gPanel.appendChild(gRow(
            (x.revoked ? '[revoked] ' : '') + (x.label || x.handle),
            function () { return vaultCall('revoke', { handle: x.handle }) }))
        })
      })
      vaultCall('listGrants').then(function (r) {
        var gs = (r && r.grants) || []
        if (gs.length) {
          var h2 = document.createElement('div')
          h2.textContent = 'Session & remote grants'
          h2.style.cssText = 'font-weight:600;margin:12px 0 6px;font-size:13px'
          gPanel.appendChild(h2)
        }
        gs.forEach(function (g) {
          var scope = g.handles === '*' ? '*' : (g.handles || []).length + ' handles'
          gPanel.appendChild(gRow(
            (g.revoked ? '[revoked] ' : '') + g.kind + ' ' + (g.session_id || '') + ' (' + scope + ')',
            function () { return vaultCall('revokeGrant', { grant: g.grant }) }))
        })
      })
    }

    gChip.onclick = function () {
      gPanel.style.display = gPanel.style.display === 'none' ? 'block' : 'none'
      if (gPanel.style.display === 'block') renderGrants()
    }
    document.body.appendChild(gChip)
    document.body.appendChild(gPanel)
    updateShareUI()
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectShareUI)
  } else {
    injectShareUI()
  }

  // --- 8. Boot ------------------------------------------------------------
  var interruptSab = new SharedArrayBuffer(8)
  window.__HERMES_INTERRUPT__ = new Int32Array(interruptSab)
  worker.postMessage({
    type: 'boot',
    sab: sab,
    interruptSab: interruptSab,
    pyodideUrl: './pyodide/',
    pyZipUrl: './hermes-py.zip',
    envZipUrl: './hermes-env.zip',
    overlayManifestUrl: './overlay/manifest.json',
    persistHome: true,
    sessionToken: sessionToken,
    publicHost: window.location.hostname,

  })

  window.__HERMES_BOOTSTRAP__ = { sessionToken: sessionToken, intercepted: true }
  console.log('[hermes-web] bootstrap installed; api log at window.__HERMES_API_LOG__')
})()
