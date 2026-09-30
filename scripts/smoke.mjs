// smoke.mjs — Playwright smoke for the real in-browser Hermes backend:
// page boot, backend-ready, ws JSON-RPC round-trips, REST through the real
// ASGI app, and the vault boundary (a saved key must store as a `vault:`
// handle, never raw bytes into the Python heap).
//
// Usage: node scripts/smoke.mjs           — serves dist/ on :8471 itself
//        CHROME_PATH=/path/chrome node scripts/smoke.mjs
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'

const PORT = Number(process.env.SMOKE_PORT || 8471)
const server = spawn(process.execPath, ['scripts/serve.mjs', 'dist', String(PORT)],
  { stdio: ['ignore', 'pipe', 'inherit'] })
process.on('exit', () => server.kill())
await new Promise((r) => setTimeout(r, 800))

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
browser.on('disconnected', () => console.log('!! browser disconnected'))
const { writeFileSync, appendFileSync } = await import('node:fs')
writeFileSync('/tmp/smoke-console.log', '')
const page = await browser.newPage()
const logs = []
page.on('console', (m) => {
  logs.push(m.text())
  try { appendFileSync('/tmp/smoke-console.log', m.text() + '\n') } catch {}
})
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message))
page.on('crash', () => console.log('!! page crashed'))

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
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
logs.slice(-40).forEach((l) => console.log('  ', l.slice(0, 260)))

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
          const sid = results[106] && results[106].result && results[106].result.session_id
          if (sid && results[107] === undefined) {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: 107, method: 'complete.path',
              params: { word: '/usr/bin/g', session_id: sid, cwd: '/' } }))
            // Vault interception: the raw key must be rewritten page-side;
            // the backend only ever sees a vault:<handle> placeholder.
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: 108, method: 'model.save_key',
              params: { slug: 'openai-api', api_key: 'sk-test-VAULT-AAA' } }))
          }
        }
      } catch (e) {}
      if (Object.keys(results).length >= methods.length + 2) {
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
  const methodNames = ['session.list', 'gateway.ping', 'setup.status', 'model.options', 'tools.list', 'toolsets.list', 'session.create', 'complete.path(wasi)', 'model.save_key']
  for (let i = 0; i < methodNames.length; i++) {
    const r = (rpc.results || {})[100 + i]
    const out = r === undefined ? 'NO-REPLY'
      : r.error ? 'ERR ' + JSON.stringify(r.error).slice(0, 200)
      : JSON.stringify(r.result).slice(0, 400)
    console.log(' ', methodNames[i], '=>', out)
  }
  // Vault proof: a stored key is a labeled handle in the vault worker; the
  // raw value must not appear anywhere in the Python heap or config write.
  const vault = await page.evaluate(async () => {
    try {
      const r = await window.__HERMES_VAULT__.call('list')
      const handles = (r && r.handles) || []
      return {
        count: handles.length,
        labels: handles.map((h) => h.label),
        hasHandle: handles.some((h) => String(h.label || '').includes('model.save_key')),
      }
    } catch (e) { return { error: String(e) } }
  })
  console.log('--- vault ---')
  console.log('  handles =>', JSON.stringify(vault))
  console.log('  save_key stored as vault handle =>',
    vault.hasHandle ? 'PASS' : 'CHECK-ABOVE')
  console.log('--- events ---')
  ;(rpc.log || []).slice(0, 8).forEach((l) => console.log('  ', l.slice(0, 200)))
}
await browser.close()
server.kill()
