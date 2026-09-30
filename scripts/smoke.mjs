// smoke.mjs — Playwright smoke for the real in-browser Hermes backend:
// page boot, backend-ready, ws JSON-RPC round-trips, REST through the real
// ASGI app. Usage: node scripts/smoke.mjs
import { chromium } from 'playwright-core'

const EXEC = process.env.CHROME_PATH ||
  '/home/terex/Documents/Rooted/apps/hermes-web/.browser-cache/chromium-1234/chrome-linux64/chrome'

const browser = await chromium.launch({
  executablePath: EXEC,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-logging=stderr', '--v=0'],
})
browser.on('disconnected', () => console.log('!! browser disconnected'))
const { writeFileSync, appendFileSync } = await import('node:fs')
writeFileSync('/tmp/smoke-console.log', '')
const page = await browser.newPage()
if (process.env.HERMES_PY_ENV) {
  const env = Object.fromEntries(process.env.HERMES_PY_ENV.split(',').map((kv) => kv.split('=')))
  await page.addInitScript((e) => { window.__HERMES_PY_ENV__ = e }, env)
}
if (process.env.HERMES_PY_ENV_JSON) {
  // JSON env dict — for values containing commas (e.g. HERMES_EXTRA_CONFIG_JSON).
  await page.addInitScript((e) => {
    window.__HERMES_PY_ENV__ = Object.assign(window.__HERMES_PY_ENV__ || {}, e)
  }, JSON.parse(process.env.HERMES_PY_ENV_JSON))
}
const logs = []
page.on('console', (m) => {
  logs.push(m.text())
  try { appendFileSync('/tmp/smoke-console.log', m.text() + '\n') } catch {}
})
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message))
page.on('crash', () => console.log('!! page crashed'))

await page.goto('http://localhost:8471/', { waitUntil: 'domcontentloaded', timeout: 30000 })
console.log('== page loaded; waiting for backend boot ==')

const deadline = Date.now() + 300000
const interruptAt = process.env.SMOKE_INTERRUPT_AT_S
  ? Date.now() + Number(process.env.SMOKE_INTERRUPT_AT_S) * 1000
  : 0
let interrupted = false
let ready = false
while (Date.now() < deadline) {
  ready = await page.evaluate(() => !!window.__HERMES_BACKEND_READY__).catch(() => false)
  if (ready) break
  if (!interrupted && interruptAt && Date.now() > interruptAt) {
    interrupted = true
    await page.evaluate(() => { window.__HERMES_INTERRUPT__[0] = 2 }).catch(() => {})
    console.log('!! sent SIGINT to backend worker')
  }
  await new Promise((r) => setTimeout(r, 3000))
}
console.log('backend ready:', ready)
console.log('--- console tail ---')
logs.forEach((l) => console.log('  ', l.slice(0, 260)))

if (ready) {
  const probes = await page.evaluate(async () => {
    const out = {}
    for (const p of ['/api/status', '/api/profiles', '/api/config?include_defaults=false']) {
      try {
        const r = await fetch(p, { headers: { 'X-Hermes-Session-Token': window.__HERMES_BOOTSTRAP__.sessionToken } })
        const t = await r.text()
        out[p] = r.status + ' ' + t.slice(0, 300)
      } catch (e) { out[p] = 'ERR ' + e.message }
    }
    return out
  })
  console.log('--- REST probes ---')
  for (const k in probes) console.log(' ', k, '=>', probes[k].replace(/\n/g, ' ').slice(0, 300))

  const rpc = await page.evaluate(() => new Promise((resolve) => {
    const log = []
    const results = {}
    const ws = new WebSocket('ws://' + location.host + '/api/ws?token=' + window.__HERMES_BOOTSTRAP__.sessionToken)
    const methods = [
      'session.list', 'gateway.ping', 'setup.status', 'model.options',
      'tools.list', 'toolsets.list', 'session.create',
    ]
    const t = setTimeout(() => resolve({ timeout: true, log, results }), 120000)
    ws.onmessage = (ev) => {
      const s = String(ev.data)
      log.push(s.slice(0, 200))
      try {
        const m = JSON.parse(s)
        if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
          results[m.id] = m.error ? { error: m.error } : { result: m.result }
          // complete.path exercises the session's terminal backend end-to-end:
          // RPC -> terminal_tool -> wasi env -> wasi_call -> page runner -> bash.
          const sid = results[106] && results[106].result && results[106].result.session_id
          if (sid && results[107] === undefined) {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: 107, method: 'complete.path',
              params: { word: '/usr/bin/g', session_id: sid, cwd: '/' } }))
            // BYOK vault path: the raw key must be intercepted page-side;
            // .env receives only a vault:<handle> placeholder.
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: 108, method: 'model.save_key',
              params: { slug: 'openai-api', api_key: 'sk-test-VAULT-AAA' } }))
          }
          if (sid && results[108] && results[109] === undefined) {
            // Real inference turn against the mock OpenAI-compatible provider.
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: 109, method: 'prompt.submit',
              params: { session_id: sid, text: 'ping' } }))
          }
          // message.complete marks the end of the assistant turn.
          if (m.method === 'event' && m.params && m.params.type === 'message.complete') {
            results[110] = { result: { completed: true, message: (m.params.payload && m.params.payload.message) || m.params.payload } }
          }
        }
      } catch (e) {}
      if (Object.keys(results).length >= methods.length + 4) {
        clearTimeout(t); resolve({ log, results })
      }
    }
    ws.onopen = () => {
      methods.forEach((m, i) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 100 + i, method: m, params: {} })))
      setTimeout(() => { clearTimeout(t); resolve({ log, results }) }, 90000)
    }
    ws.onerror = () => resolve({ error: 'ws error', log, results })
    ws.onclose = (ev) => resolve({ closed: ev.code, log, results })
  }))
  console.log('--- ws probe ---')
  const methodNames = ['session.list', 'gateway.ping', 'setup.status', 'model.options', 'tools.list', 'toolsets.list', 'session.create', 'complete.path(wasi)', 'model.save_key', 'prompt.submit', 'message.complete']
  for (let i = 0; i < methodNames.length; i++) {
    const r = (rpc.results || {})[100 + i]
    const out = r === undefined ? 'NO-REPLY'
      : r.error ? 'ERR ' + JSON.stringify(r.error).slice(0, 200)
      : JSON.stringify(r.result).slice(0, 400)
    console.log(' ', methodNames[i], '=>', out)
  }
  // Vault proof: the mock LLM must have received the RESOLVED key
  // (sk-test-VAULT-AAA), not the vault: handle — resolution happens
  // page-side, outside the Pyodide heap.
  const vault = await page.evaluate(async () => {
    const out = {}
    try {
      const r = await fetch('/mock-llm/last-auth')
      out.lastAuth = (await r.json()).authorization || ''
    } catch (e) { out.lastAuth = 'ERR ' + e.message }
    try {
      out.envLeak = 'vault list n/a'
    } catch (e) {}
    return out
  })
  console.log('--- vault ---')
  console.log('  mock Authorization received =>', vault.lastAuth)
  console.log('  vault resolved key =>', vault.lastAuth === 'Bearer sk-test-VAULT-AAA' ? 'PASS' : 'CHECK-ABOVE')
  console.log('--- events ---')
  ;(rpc.log || []).slice(0, 8).forEach((l) => console.log('  ', l.slice(0, 200)))
}
await browser.close()
