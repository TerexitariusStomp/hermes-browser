// battle.mjs — deeper end-to-end battle test beyond smoke.mjs:
//   1. page boot + backend ready + renderer actually mounted
//   2. near toolset present & enabled in tools.list
//   3. page-side near-bridge ops (status, genKey custody, policy gate)
//   4. a REAL agent turn: prompt.submit -> local-llm (wllama) -> message.complete
//   5. WASI terminal via complete.path already proven in smoke; here: tools.list
//      terminal toolset enabled
//   6. full console/pageerror dump + screenshot
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { writeFileSync, appendFileSync } from 'node:fs'

const PORT = Number(process.env.BATTLE_PORT || 8472)
// BATTLE_MOCK_LLM=1 swaps the default provider for the dev server's
// /mock-llm endpoint — exercises the full turn loop without the ~800MB
// model download. Unset runs the real local-llm wllama path.
const MOCK = !!process.env.BATTLE_MOCK_LLM
// BATTLE_TUI_TOOLSETS=near pins the session tool surface (HERMES_TUI_TOOLSETS)
// — shrinks the system prompt so a real local-llm turn finishes in seconds
// instead of prefilling ~50K tokens of tool schemas on wasm.
const TOOLSETS = process.env.BATTLE_TUI_TOOLSETS || ''
const server = spawn(process.execPath, ['scripts/serve.mjs', 'dist', String(PORT)],
  { stdio: ['ignore', 'pipe', 'inherit'] })
process.on('exit', () => server.kill())
await new Promise((r) => setTimeout(r, 800))

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
if (MOCK) {
  await page.addInitScript((port) => {
    localStorage.setItem('hermes.extraConfigJson', JSON.stringify({
      model: { provider: 'mock', default: 'mock-1' },
      providers: {
        mock: {
          name: 'Mock LLM',
          api: 'http://localhost:' + port + '/mock-llm/v1',
          default_model: 'mock-1',
          models: { 'mock-1': { context_length: 65536 } },
        },
      },
    }))
  }, PORT)
}
if (TOOLSETS) {
  await page.addInitScript((ts) => {
    const env = JSON.parse(localStorage.getItem('hermes.env') || '{}')
    env.HERMES_TUI_TOOLSETS = ts
    localStorage.setItem('hermes.env', JSON.stringify(env))
  }, TOOLSETS)
}
const logs = []
const errors = []
writeFileSync('/tmp/battle-console.log', '')
page.on('console', (m) => {
  logs.push(m.text())
  try { appendFileSync('/tmp/battle-console.log', m.text() + '\n') } catch {}
})
page.on('pageerror', (e) => { errors.push(e.message); logs.push('[pageerror] ' + e.message) })
page.on('crash', () => console.log('!! page crashed'))

const t0 = Date.now()
const el = (() => { const s = () => ((Date.now() - t0) / 1000).toFixed(0) + 's'; return s })()

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
console.log('== page loaded; waiting for backend boot ==')
let ready = false
const deadline = Date.now() + 300000
while (Date.now() < deadline) {
  ready = await page.evaluate(() => !!window.__HERMES_BACKEND_READY__).catch(() => false)
  if (ready) break
  await new Promise((r) => setTimeout(r, 3000))
}
console.log('backend ready:', ready, '@' + el())
if (!ready) { logs.slice(-30).forEach((l) => console.log('  ', l.slice(0, 240))); await browser.close(); server.kill(); process.exit(1) }

// --- 1. renderer mounted? ---
const ui = await page.evaluate(() => ({
  title: document.title,
  bodyText: document.body.innerText.slice(0, 200).replace(/\n+/g, ' | '),
  frames: document.querySelectorAll('iframe').length,
  crossOriginIsolated: window.crossOriginIsolated,
}))
console.log('--- ui ---')
console.log('  title:', ui.title)
console.log('  crossOriginIsolated:', ui.crossOriginIsolated)
console.log('  frames:', ui.frames)
console.log('  body:', ui.bodyText)
await page.screenshot({ path: '/tmp/battle-ui.png' })

// --- 2. toolsets: near enabled? terminal present? ---
const toolInfo = await page.evaluate(() => new Promise((resolve) => {
  const ws = new WebSocket('ws://' + location.host + '/api/ws?token=' + window.__HERMES_BOOTSTRAP__.sessionToken)
  const t = setTimeout(() => resolve({ timeout: true }), 60000)
  ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools.list', params: {} }))
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(String(ev.data))
      if (m.id === 1) { clearTimeout(t); resolve(m.result || m.error) }
    } catch {}
  }
  ws.onerror = () => resolve({ error: 'ws error' })
}))
const toolsets = (toolInfo && toolInfo.toolsets) || []
const nearSet = toolsets.find((x) => x.name === 'near')
const termSet = toolsets.find((x) => x.name === 'terminal')
console.log('--- toolsets ---')
console.log('  count:', toolsets.length, '| near:', nearSet ? `${nearSet.tool_count} tools enabled=${nearSet.enabled}` : 'MISSING',
  '| terminal:', termSet ? `${termSet.tool_count} tools enabled=${termSet.enabled}` : 'MISSING')
if (nearSet) console.log('  near tools:', nearSet.tools.join(', '))

// --- 3. page-side near-bridge ops ---
const nearOps = await page.evaluate(async () => {
  const out = {}
  try {
    const m = await import('/near-bridge.js')
    const ctx = {
      vaultCall: window.__HERMES_VAULT__.call,
      confirm: () => Promise.resolve(true),
      resolveHeaders: (h) => Promise.resolve(h),
    }
    const grantR = await window.__HERMES_VAULT__.call('createGrant', { kind: 'session', session_id: 'battle' })
    const grant = grantR.grant
    for (const [name, op, args] of [
      ['status', 'status', {}],
      ['genKey', 'genKey', { label: 'battle', accountId: 'battle.testnet' }],
      ['list', 'list', {}],
      ['policyGet', 'policyGet', {}],
      ['deniedSend', 'send', { to: 'x.testnet', amount: '1' }],
    ]) {
      try {
        const r = await m.handle(op, args || {}, grant, ctx)
        out[name] = typeof r === 'object' ? JSON.stringify(r).slice(0, 400) : String(r)
      } catch (e) { out[name] = 'THREW ' + String(e).slice(0, 200) }
    }
  } catch (e) { out.error = String(e) }
  return out
})
console.log('--- near-bridge ops (page-side) ---')
for (const k in nearOps) console.log(' ', k, '=>', nearOps[k])

// --- 4. REAL agent turn over local-llm ---
console.log('--- agent turn (local-llm wllama; first run downloads ~400MB) ---')
const turn = await page.evaluate(() => new Promise((resolve) => {
  const log = []
  const ws = new WebSocket('ws://' + location.host + '/api/ws?token=' + window.__HERMES_BOOTSTRAP__.sessionToken)
  let sid = null
  const t = setTimeout(() => resolve({ timeout: true, log }), 480000)
  ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session.create', params: {} }))
  ws.onmessage = (ev) => {
    const s = String(ev.data)
    let m
    try { m = JSON.parse(s) } catch { return }
    if (m.id === 1 && m.result) {
      sid = m.result.session_id
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'prompt.submit',
        params: { session_id: sid, text: 'Reply with exactly the word READY and nothing else.' } }))
      log.push('submitted sid=' + sid)
    }
    if (m.id === 2) log.push('submit ack: ' + s.slice(0, 200))
    if (m.method === 'event' && m.params && m.params.type === 'message.delta') {
      const d = m.params.payload && (m.params.payload.delta || m.params.payload.text)
      if (d) log.push('delta: ' + String(d).slice(0, 100))
    }
    if (m.method === 'event' && m.params && (m.params.type === 'message.complete' || m.params.type === 'turn.complete')) {
      log.push('COMPLETE: ' + s.slice(0, 500))
      clearTimeout(t); resolve({ done: true, sid, log, last: s.slice(0, 800) })
    }
    if (m.method === 'event' && m.params && m.params.type === 'error') {
      log.push('ERR-EVT: ' + s.slice(0, 300))
    }
  }
  ws.onerror = () => resolve({ error: 'ws error', log })
  ws.onclose = (e) => resolve({ closed: e.code, log })
}))
console.log('  turn:', JSON.stringify(turn && { done: turn.done, timeout: turn.timeout, error: turn.error, closed: turn.closed, last: (turn.last || '').slice(0, 400) }, null, 1))
;(turn.log || []).slice(-12).forEach((l) => console.log('   ', l.slice(0, 220)))

// --- 5. errors summary ---
console.log('--- errors ---')
console.log('  pageerrors:', errors.length)
errors.slice(0, 10).forEach((e) => console.log('   ', e.slice(0, 240)))
const errLogs = logs.filter((l) => /error|ERR|fail/i.test(l)).slice(-15)
console.log('  console error-ish lines:', errLogs.length)
errLogs.forEach((l) => console.log('   ', l.slice(0, 240)))

await page.screenshot({ path: '/tmp/battle-final.png' })
await browser.close()
server.kill()
