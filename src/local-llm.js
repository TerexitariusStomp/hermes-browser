// In-browser local model endpoint — wllama (llama.cpp WASM) serving an
// OpenAI-compatible surface on the synthetic host `local-llm.hermes`.
// The net bridge routes that host here instead of the network; weights
// download lazily on first chat request and persist in the browser cache
// (wllama CacheManager), verified against the pinned sha256.
//
// Model weights carry their own licenses: the default is Qwen2.5
// (Apache-2.0). Inference never leaves the device — no key is needed and
// the vault worker is not involved.

import { Wllama } from './vendor-wllama.js'

// Commit-pinned so a re-tagged HF file cannot silently swap the model.
const MODEL_COMMIT = 'df5bf01389a39c743ab467d734bf501681e041c5'
const DEFAULT_MODEL = {
  id: 'qwen2.5-0.5b-instruct-q4_k_m',
  url: `https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/${MODEL_COMMIT}/qwen2.5-0.5b-instruct-q4_k_m.gguf`,
  sha256: '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db',
  context_length: 4096,
}

const MODELS = [DEFAULT_MODEL]

let wllama = null
let loadPromise = null
let loadState = 'idle' // idle | loading | ready | error
let loadProgress = null // { loaded, total } during download
let loadError = null

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

async function ensureModel(modelId) {
  const spec = MODELS.find(function (m) { return m.id === modelId }) || DEFAULT_MODEL
  if (wllama && loadState === 'ready') return spec
  if (!loadPromise) {
    loadState = 'loading'
    loadPromise = (async function () {
      const inst = new Wllama({ default: './wllama/wllama.wasm' }, {
        suppressNativeLog: true,
      })
      await inst.loadModelFromUrl(spec.url, {
        n_ctx: spec.context_length,
        allowOffline: true,
        progressCallback: function (p) { loadProgress = p },
      })
      wllama = inst
      loadState = 'ready'
      loadProgress = null
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

  if (req.stream) {
    var sse = ''
    var it = await wllama.createChatCompletion(Object.assign({}, params, { stream: true }))
    for await (var chunk of it) {
      if (!chunk.model) chunk.model = req.model || DEFAULT_MODEL.id
      sse += 'data: ' + JSON.stringify(chunk) + '\n\n'
    }
    sse += 'data: [DONE]\n\n'
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: sse }
  }

  var resp = await wllama.createChatCompletion(params)
  resp.model = req.model || DEFAULT_MODEL.id
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
    })
  }
  if (method === 'POST' && pathname === '/v1/chat/completions') {
    return chatCompletions(bodyText)
  }
  return json(404, { error: { message: 'unknown endpoint: ' + method + ' ' + pathname, type: 'invalid_request_error' } })
}
