// In-browser local model endpoint — wllama (llama.cpp WASM) serving an
// OpenAI-compatible surface on the synthetic host `local-llm.hermes`.
// The net bridge routes that host here instead of the network; weights
// download lazily on first chat request and persist in the browser cache
// (wllama CacheManager).
//
// Model weights carry their own license: the default is Llama 3.2 1B
// (Llama 3.2 Community License — weights fetched from Hugging Face at
// first use, never vendored). Inference never leaves the device — no key
// is needed and the vault worker is not involved.

import { Wllama } from './vendor-wllama.js'

// Commit-pinned AND sha256-verified: a re-tagged HF file cannot silently
// swap the model — the downloaded bytes are hashed before first load and
// a mismatched cache entry is deleted rather than served.
const MODEL_COMMIT = '067b946cf014b7c697f3654f621d577a3e3afd1c'
const DEFAULT_MODEL = {
  id: 'llama-3.2-1b-instruct-q4_k_m',
  url: `https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/${MODEL_COMMIT}/Llama-3.2-1B-Instruct-Q4_K_M.gguf`,
  sha256: '6f85a640a97cf2bf5b8e764087b1e83da0fdb51d7c9fab7d0fece9385611df83',
  // Native window is 128K; the KV cache is sized at 64K — Hermes' minimum
  // context floor — so allocated == declared and WASM RAM stays bounded.
  context_length: 65536,
}

const MODELS = [DEFAULT_MODEL]

let wllama = null
let loadPromise = null
let loadState = 'idle' // idle | loading | ready | error
let loadProgress = null // { loaded, total } during download
let loadError = null
let webgpu = false

function json(status, obj, extraHeaders) {
  return {
    status: status,
    headers: Object.assign({ 'content-type': 'application/json' }, extraHeaders || {}),
    body: JSON.stringify(obj),
  }
}

function modelEntry(m) {
  return { id: m.id, object: 'model', created: 0, owned_by: 'wllama-local' }
}

// Incremental SHA-256 — subtle.digest can't stream, and buffering ~800MB
// to one-shot it doubles peak memory. ~64 lines, no deps.
function sha256Stream() {
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]
  var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  var pending = new Uint8Array(64)
  var pendingLen = 0
  var total = 0
  var w = new Uint32Array(64)
  function rr(x, n) { return (x >>> n) | (x << (32 - n)) }
  function block(b) {
    for (var i = 0; i < 16; i++)
      w[i] = (b[i * 4] << 24) | (b[i * 4 + 1] << 16) | (b[i * 4 + 2] << 8) | b[i * 4 + 3]
    for (var i = 16; i < 64; i++) {
      var s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      var s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }
    var a = H[0], b1 = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
    for (var i = 0; i < 64; i++) {
      var S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25), ch = (e & f) ^ (~e & g)
      var t1 = (h + S1 + ch + K[i] + w[i]) | 0
      var S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22), maj = (a & b1) ^ (a & c) ^ (b1 & c)
      var t2 = (S0 + maj) | 0
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b1; b1 = a; a = (t1 + t2) | 0
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b1) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0
  }
  return {
    update: function (bytes) {
      total += bytes.length
      var off = 0
      if (pendingLen) {
        var n = Math.min(64 - pendingLen, bytes.length)
        pending.set(bytes.subarray(0, n), pendingLen)
        pendingLen += n; off = n
        if (pendingLen === 64) { block(pending); pendingLen = 0 }
      }
      while (off + 64 <= bytes.length) { block(bytes.subarray(off, off + 64)); off += 64 }
      if (off < bytes.length) { pending.set(bytes.subarray(off)); pendingLen = bytes.length - off }
    },
    final: function () {
      var bitLen = total * 8
      var pad = [0x80]
      while ((pendingLen + pad.length) % 64 !== 56) pad.push(0)
      this.update(new Uint8Array(pad))
      var lenBytes = new Uint8Array(8)
      var dv = new DataView(lenBytes.buffer)
      dv.setUint32(0, Math.floor(bitLen / 0x100000000))
      dv.setUint32(4, bitLen >>> 0)
      this.update(lenBytes)
      var hex = ''
      for (var i = 0; i < 8; i++) hex += ('0000000' + (H[i] >>> 0).toString(16)).slice(-8)
      return hex
    },
  }
}

async function sha256Blobs(blobs) {
  var h = sha256Stream()
  for (const blob of blobs) {
    const reader = blob.stream().getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      h.update(value)
    }
  }
  return h.final()
}

async function ensureModel(modelId) {
  const spec = MODELS.find(function (m) { return m.id === modelId }) || DEFAULT_MODEL
  if (wllama && loadState === 'ready') return spec
  if (!loadPromise) {
    loadState = 'loading'
    loadPromise = (async function () {
      const inst = new Wllama({ default: './wllama/wllama.wasm' }, {
        suppressNativeLog: true,
      })
      // Download (or reuse the cache), then verify bytes against the pin
      // before the model ever reaches the wasm heap.
      const model = await inst.modelManager.getModelOrDownload({ url: spec.url }, {
        allowOffline: true,
        progressCallback: function (p) { loadProgress = p },
      })
      const blobs = await model.open()
      const got = await sha256Blobs(blobs)
      if (got !== spec.sha256) {
        await model.remove()
        throw new Error('model sha256 mismatch: expected ' + spec.sha256.slice(0, 16) +
          '…, got ' + got.slice(0, 16) + '… (cache entry deleted)')
      }
      // Evict superseded defaults (older releases pinned a different
      // model — its multi-hundred-MB blob would linger in OPFS forever).
      try {
        for (const m of await inst.modelManager.getModels()) {
          if (m.url !== spec.url) await m.remove()
        }
      } catch (e) {}
      await inst.loadModel(blobs, {
        n_ctx: spec.context_length,
        // KV cache at 64K is the RAM hog — q8 halves it vs f16 with no
        // perceptible quality cost for this use.
        cache_type_k: 'q8_0',
        cache_type_v: 'q8_0',
      })
      wllama = inst
      currentSpec = spec
      loadState = 'ready'
      loadProgress = null
      // wllama passes n_gpu_layers=99999 by default: on WebGPU-capable
      // browsers (Chrome/Edge/SAFARI TP) the ggml webgpu backend takes the
      // layers; elsewhere they stay on multithreaded wasm. Surface which
      // path is live so "is it using my GPU" is answerable — adapter
      // presence is the honest signal (the API exists without one).
      webgpu = false
      try {
        webgpu = !!(globalThis.navigator && navigator.gpu &&
          (await navigator.gpu.requestAdapter()))
      } catch (e) {}
      console.log('[local-llm] model ready: ' + spec.id + ' n_ctx=' + spec.context_length +
        ' threads=' + (inst.getNumThreads ? inst.getNumThreads() : '?') +
        ' webgpu=' + webgpu)
      // Restored snapshot makes turn 1 warm immediately; otherwise replay
      // the saved prompt (still hides the prefill behind boot).
      if (!(await restoreKvState())) prime()
    })()
  }
  try {
    await loadPromise
  } catch (e) {
    loadState = 'error'
    loadError = String(e && e.message || e).slice(0, 300)
    loadPromise = null
    throw e
  }
  return spec
}

// KV prime: after the first real request carries the deterministic
// system prompt through the model, llama.cpp's in-context KV reuse makes
// turns 2+ instant (measured: ~230ms vs ~93s cold on a 2.4K prefix). We
// persist that prompt and replay it at next load so the first *user*
// turn lands on a warm KV instead of paying the ~15min 50K-token
// prefill up front.
var PRIME_KEY = 'hermes.localLlm.prime'

// KV snapshot persistence. The patched wllama wasm exposes
// llama_state_seq_get_data/set_data via save_state/load_state actions;
// the snapshot is a pure cache - llama.cpp verifies token prefixes at
// decode time, so a stale snapshot still yields correct output (it only
// re-decodes the divergent tail). Unpatched wasm throws "unknown action"
// and the paths below degrade to the plain prime() replay.
var KV_DB = 'hermes-local-llm'
var KV_STORE = 'kv'
var kvSaving = null
var kvLastSave = 0
var currentSpec = null

function kvKey(spec) { return 'kv:' + spec.id + ':' + spec.sha256.slice(0, 16) }

// At-rest encryption for prompt-bearing state. The KV snapshot and the
// primed system prompt both encode the conversation prefix — a copied
// profile or a casual IndexedDB/localStorage inspection must not read them.
// Key: one AES-GCM-256 CryptoKey generated extractable:false and stored in
// the same DB. Structured clone moves only the handle — the raw key bytes
// never exist outside the browser's crypto module, so an exfiltrated
// profile directory is ciphertext plus an unusable key reference.
var KV_CRYPTO_KEY = 'key:v1'
var kvCryptoKeyPromise = null

function kvCryptoKey() {
  if (!kvCryptoKeyPromise) {
    kvCryptoKeyPromise = idbGet(KV_CRYPTO_KEY).then(function (k) {
      if (k) return k
      return crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      ).then(function (k2) {
        return idbPut(KV_CRYPTO_KEY, k2).then(function () { return k2 })
      })
    }).catch(function () { kvCryptoKeyPromise = null; return null })
  }
  return kvCryptoKeyPromise
}

async function encBytes(buf) {
  var key = await kvCryptoKey()
  if (!key) return null
  var iv = crypto.getRandomValues(new Uint8Array(12))
  var ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, buf))
  var out = new Uint8Array(12 + ct.byteLength)
  out.set(iv)
  out.set(ct, 12)
  return out
}

async function decBytes(buf) {
  var key = await kvCryptoKey()
  if (!key) return null
  var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  if (u8.byteLength <= 12) return null
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: u8.subarray(0, 12) }, key, u8.subarray(12)))
  } catch (e) { return null }
}

function idbOpen() {
  return new Promise(function (resolve, reject) {
    var rq = indexedDB.open(KV_DB, 1)
    rq.onupgradeneeded = function () { rq.result.createObjectStore(KV_STORE) }
    rq.onsuccess = function () { resolve(rq.result) }
    rq.onerror = function () { reject(rq.error) }
  })
}

async function idbPut(k, v) {
  var db = await idbOpen()
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(KV_STORE, 'readwrite')
    tx.objectStore(KV_STORE).put(v, k)
    tx.oncomplete = function () { resolve() }
    tx.onerror = function () { reject(tx.error) }
  })
}

async function idbGet(k) {
  var db = await idbOpen()
  return new Promise(function (resolve, reject) {
    var rq = db.transaction(KV_STORE).objectStore(KV_STORE).get(k)
    rq.onsuccess = function () { resolve(rq.result) }
    rq.onerror = function () { reject(rq.error) }
  })
}

async function saveKvState() {
  if (!wllama || !wllama.proxy || !currentSpec) return
  if (kvSaving) return kvSaving
  if (Date.now() - kvLastSave < 60000) return
  kvSaving = (async function () {
    try {
      // seq_id -1 stashes every occupied slot in one pass; the server picks
      // the largest prompt_cache state
      var res = await wllama.proxy.wllamaAction('save_state', { _name: 'svst_req', seq_id: -1 })
      if (res && res.success && res.data && res.data.byteLength > 0) {
        var enc = await encBytes(res.data)
        if (!enc) {
          // Fail closed: never write a plaintext snapshot.
          console.log('[local-llm] KV save skipped: crypto unavailable')
          return
        }
        await idbPut(kvKey(currentSpec), enc)
        kvLastSave = Date.now()
        console.log('[local-llm] KV snapshot saved (encrypted): ' +
          (enc.byteLength / 1048576).toFixed(0) + 'MB')
      }
    } catch (e) {
      console.log('[local-llm] KV save failed: ' + String(e && e.message || e).slice(0, 120))
    }
    kvSaving = null
  })()
  return kvSaving
}

async function restoreKvState() {
  if (!wllama || !wllama.proxy || !currentSpec) {
    console.log('[local-llm] KV restore skipped: wllama=' + !!wllama +
      ' proxy=' + !!(wllama && wllama.proxy) + ' spec=' + !!currentSpec)
    return false
  }
  try {
    var data = await idbGet(kvKey(currentSpec))
    if (!data || !data.byteLength) {
      console.log('[local-llm] KV restore: no snapshot in IDB (key=' + kvKey(currentSpec) + ')')
      return false
    }
    var plain = await decBytes(data)
    if (!plain) {
      // Pre-encryption snapshots stored the raw state buffer — honor it
      // once, then the next save rewrites it encrypted.
      if (data.byteLength > 12) plain = data instanceof Uint8Array ? data : new Uint8Array(data)
      else return false
    }
    var res = await wllama.proxy.wllamaAction('load_state', { _name: 'ldst_req', seq_id: 0, data: plain })
    var ok = !!(res && res.success)
    console.log('[local-llm] KV snapshot ' + (ok ? 'restored' : 'rejected') +
      ': ' + (plain.byteLength / 1048576).toFixed(0) + 'MB')
    return ok
  } catch (e) {
    console.log('[local-llm] KV restore failed: ' + String(e && e.message || e).slice(0, 120))
    return false
  }
}

function savePrime(messages) {
  try {
    var sys = (messages || []).find(function (m) { return m.role === 'system' })
    if (sys && sys.content && sys.content.length > 1000) {
      encBytes(new TextEncoder().encode(sys.content)).then(function (enc) {
        if (enc) {
          var s = ''
          for (var i = 0; i < enc.length; i++) s += String.fromCharCode(enc[i])
          localStorage.setItem(PRIME_KEY, 'enc:' + btoa(s))
        }
      }).catch(function () {})
    }
  } catch (e) {}
}

async function prime() {
  var raw = null
  try { raw = localStorage.getItem(PRIME_KEY) } catch (e) {}
  var sys = null
  if (raw && raw.indexOf('enc:') === 0) {
    try {
      var bin = atob(raw.slice(4))
      var enc = new Uint8Array(bin.length)
      for (var i = 0; i < bin.length; i++) enc[i] = bin.charCodeAt(i)
      var plain = await decBytes(enc)
      if (plain) sys = new TextDecoder().decode(plain)
    } catch (e) {}
  } else {
    // Legacy plaintext entry — keep it working, then the next savePrime
    // rewrites it encrypted.
    sys = raw
  }
  if (!sys) return
  console.log('[local-llm] priming KV from saved system prompt (' + sys.length + ' chars)')
  var t0 = Date.now()
  try {
    await wllama.createChatCompletion({
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: 'ok' },
      ],
      max_tokens: 1, temperature: 0,
    })
    console.log('[local-llm] KV primed in ' + ((Date.now() - t0) / 1000).toFixed(0) + 's')
  } catch (e) {
    console.log('[local-llm] prime failed: ' + String(e && e.message || e).slice(0, 120))
  }
}

// POST /v1/chat/completions — OpenAI-shaped request in, response out.
// stream:true returns the full SSE body buffered (the bridge is
// single-shot; incremental delivery isn't supported).
async function chatCompletions(bodyText) {
  var req
  try {
    req = JSON.parse(bodyText || '{}')
  } catch (e) {
    return json(400, { error: { message: 'invalid JSON body', type: 'invalid_request_error' } })
  }
  try {
    await ensureModel(req.model)
  } catch (e) {
    return json(503, { error: { message: 'local model load failed: ' + loadError, type: 'server_error' } })
  }
  var params = {
    messages: (req.messages || []).map(function (m) {
      var out = { role: m.role, content: m.content }
      if (m.name) out.name = m.name
      if (m.tool_calls) out.tool_calls = m.tool_calls
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id
      return out
    }),
    temperature: req.temperature,
    top_p: req.top_p,
    max_tokens: req.max_tokens,
    cache_prompt: true,
  }
  if (req.tools) params.tools = req.tools
  if (req.tool_choice) params.tool_choice = req.tool_choice
  if (req.stop) params.stop = req.stop
  if (req.response_format) params.response_format = req.response_format

  savePrime(params.messages)

  if (req.stream) {
    var sse = ''
    var it
    try {
      it = await wllama.createChatCompletion(Object.assign({}, params, { stream: true }))
    } catch (e) {
      console.log('[local-llm] stream init err (' + bodyText.length + 'B req): ' + String(e && e.message || e).slice(0, 160))
      throw e
    }
    for await (var chunk of it) {
      if (!chunk.model) chunk.model = req.model || DEFAULT_MODEL.id
      sse += 'data: ' + JSON.stringify(chunk) + '\n\n'
    }
    sse += 'data: [DONE]\n\n'
    await saveKvState()
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse }
  }

  var resp
  try {
    resp = await wllama.createChatCompletion(params)
  } catch (e) {
    var msg = String(e && e.message || e)
    // upstream JSPI flake: a wllama_action response buffer occasionally
    // comes back without the GLUE header; the retry lands on the same
    // worker+context and succeeds (matches the agent's own retry).
    if (/Invalid magic number|typed array length|GLUE/i.test(msg)) {
      console.log('[local-llm] transient glue err, retrying once: ' + msg.slice(0, 100))
      resp = await wllama.createChatCompletion(params)
    } else {
      console.log('[local-llm] completion err (' + bodyText.length + 'B req): ' + msg.slice(0, 160))
      throw e
    }
  }
  resp.model = req.model || DEFAULT_MODEL.id
  await saveKvState()
  return json(200, resp)
}

export async function handleRequest(pathname, method, bodyText) {
  if (method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
    return json(200, { object: 'list', data: MODELS.map(modelEntry) })
  }
  if (method === 'GET' && pathname === '/v1/status') {
    return json(200, {
      state: loadState,
      progress: loadProgress,
      error: loadError,
      model: wllama ? DEFAULT_MODEL.id : null,
      webgpu,
    })
  }
  if (method === 'POST' && pathname === '/v1/chat/completions') {
    return chatCompletions(bodyText)
  }
  return json(404, { error: { message: 'unknown endpoint: ' + method + ' ' + pathname, type: 'invalid_request_error' } })
}
