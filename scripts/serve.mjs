#!/usr/bin/env node
// Dev server for dist/ with the COOP/COEP headers production sends.
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'

const ROOT = process.argv[2] || 'dist'
const PORT = Number(process.argv[3] || 8471)

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.zip': 'application/zip', '.wasm': 'application/wasm',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css', '.ico': 'image/x-icon',
  '.py': 'text/x-python', '.webmanifest': 'application/manifest+json',
}

// /mock-llm — OpenAI-compatible dev endpoint for smoke tests. Records the
// Authorization header (vault-resolution proof) and returns a canned
// completion echoing the last user message.
let lastAuth = ''
function mockLlm(req, res) {
  // The provider's endpoint-discovery sweep hits several API shapes
  // (OpenAI /v1/* and Ollama /api/*) — answer the ones it probes and
  // allow cross-origin since localhost is normalized to 127.0.0.1.
  if (req.url.startsWith('/mock-llm/')) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-stainless-*')
    if (req.method === 'OPTIONS') { res.end(); return true }
  }
  if (req.url === '/mock-llm/last-auth') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ authorization: lastAuth }))
    return true
  }
  const openaiModels = () => JSON.stringify({
    object: 'list', data: [{ id: 'mock-1', object: 'model', created: 0, owned_by: 'mock' }],
  })
  const path = req.url.split('?')[0]
  if (req.method === 'GET' && /\/models(\/[\w.-]+)?$/.test(path)) {
    res.setHeader('Content-Type', 'application/json')
    res.end(path.endsWith('/mock-1')
      ? JSON.stringify({ id: 'mock-1', object: 'model', created: 0, owned_by: 'mock' })
      : openaiModels())
    return true
  }
  // Ollama-flavored probes.
  if (req.method === 'GET' && path.endsWith('/api/tags')) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ models: [{ name: 'mock-1', model: 'mock-1' }] }))
    return true
  }
  if ((req.method === 'POST' && path.endsWith('/api/show')) ||
      (req.method === 'GET' && (path.endsWith('/version') || path.endsWith('/props')))) {
    res.setHeader('Content-Type', 'application/json')
    res.end(path.endsWith('/show')
      ? JSON.stringify({ model_info: { 'llama.context_length': 8192 } })
      : JSON.stringify({ version: 'mock' }))
    return true
  }
  if (req.url === '/mock-llm/v1/chat/completions' && req.method === 'POST') {
    lastAuth = String(req.headers.authorization || '')
    let body = ''
    req.on('data', (c) => body += c)
    req.on('end', () => {
      let echo = '', stream = false, model = 'mock-1'
      try {
        const parsed = JSON.parse(body)
        const msgs = parsed.messages || []
        echo = (msgs[msgs.length - 1] && msgs[msgs.length - 1].content) || ''
        if (typeof echo !== 'string') echo = JSON.stringify(echo)
        stream = !!parsed.stream
        model = parsed.model || 'mock-1'
      } catch (e) { /* ignore */ }
      const reply = 'MOCK-LLM-REPLY: ' + echo.slice(0, 200)
      if (stream) {
        // Agents call with stream:true — a JSON body reads as an empty SSE
        // stream and trips upstream's EmptyStreamError.
        res.setHeader('Content-Type', 'text/event-stream')
        const chunk = (delta, finish) => 'data: ' + JSON.stringify({
          id: 'chatcmpl-mock', object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        }) + '\n\n'
        res.end(
          chunk({ role: 'assistant', content: reply }, null) +
          chunk({}, 'stop') + 'data: [DONE]\n\n')
        return
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }))
    })
    return true
  }
  return false
}

// /proxy/<host>/<rest> — dev parity with dist/_worker.js: forwards to
// allowlisted CORS-deaf hosts (Nous Portal auth, inference API) so the
// page can hit them from localhost. Allowlist only — not an open proxy.
const PROXY_HOSTS = new Set([
  'portal.nousresearch.com', 'inference-api.nousresearch.com', 'welcome-api.nousresearch.com',
])
function corsHeaders(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin || '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('x-hermes-proxy', '1')
}
function proxyRoute(req, res) {
  const segs = req.url.split('?')[0].split('/').filter(Boolean)
  if (segs[0] !== 'proxy') return false
  corsHeaders(res, req.headers.origin)
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return true }
  if (!PROXY_HOSTS.has(segs[1])) { res.statusCode = 403; res.end('host not allowed'); return true }
  const qi = req.url.indexOf('?')
  const upstream = `https://${segs[1]}/${segs.slice(2).join('/')}${qi >= 0 ? req.url.slice(qi) : ''}`
  const headers = { ...req.headers }
  for (const h of ['host', 'origin', 'referer', 'connection', 'keep-alive',
    'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
    'transfer-encoding', 'upgrade', 'x-forwarded-for', 'x-forwarded-proto',
    'x-real-ip', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
    'cdn-loop']) delete headers[h]
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    try {
      const resp = await fetch(upstream, {
        method: req.method, headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
        redirect: 'manual',
      })
      res.statusCode = resp.status
      resp.headers.forEach((v, k) => {
        if (!['connection', 'keep-alive', 'transfer-encoding', 'content-encoding',
          'content-length'].includes(k.toLowerCase())) res.setHeader(k, v)
      })
      corsHeaders(res, req.headers.origin)
      res.end(Buffer.from(await resp.arrayBuffer()))
    } catch (e) {
      res.statusCode = 502
      res.end('proxy error: ' + String(e).slice(0, 200))
    }
  })
  return true
}

createServer((req, res) => {
  if (mockLlm(req, res)) return
  if (proxyRoute(req, res)) return
  let p = join(ROOT, decodeURIComponent(req.url.split('?')[0]))
  if (p.endsWith('/')) p += 'index.html'
  if (!existsSync(p) || statSync(p).isDirectory()) p = join(ROOT, 'index.html')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
  // Embed parity with dist/_headers: the app is frameable by other origins,
  // and cross-origin module imports (vendor/penpal.mjs) fetch in CORS mode.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Content-Type', MIME[extname(p)] || 'application/octet-stream')
  createReadStream(p).pipe(res)
}).listen(PORT, () => console.log(`serving ${ROOT} on :${PORT}`))
