import { chromium } from 'playwright'
// Full end-to-end agent turn on the live domain: boot pyodide backend,
// drive a real agent turn over wss through local-llm (patched wllama),
// reload, verify the second turn hits the persisted KV snapshot.
const SITE = 'https://near-hermes-browser.pages.dev/'
const browser = await chromium.launch({ args: ['--no-sandbox','--disable-dev-shm-usage'] })
const ctx = await browser.newContext()

const log = (tag, t) => console.log(`[${tag}]`, String(t).slice(0, 200))

async function agentTurn(tag, timeoutMs) {
  const page = await ctx.newPage()
  page.on('console', m => { const t = m.text(); if (/local-llm|wllama|KV|prim|model ready|error/i.test(t)) log(tag, t) })
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 90000 })
  // wait for backend boot token
  await page.waitForFunction(() => window.__HERMES_BOOTSTRAP__ && window.__HERMES_BOOTSTRAP__.sessionToken, { timeout: 300000 })
  log(tag, 'backend booted')
  return await page.evaluate(async ({ timeoutMs }) => {
    const ev = []
    return await new Promise((resolve) => {
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/ws?token=' + window.__HERMES_BOOTSTRAP__.sessionToken)
      let sid = null
      const t0 = Date.now()
      const t = setTimeout(() => resolve({ timeout: true, ms: Date.now() - t0, ev }), timeoutMs)
      ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session.create', params: {} }))
      ws.onmessage = (e) => {
        const s = String(e.data)
        let m; try { m = JSON.parse(s) } catch { return }
        if (m.id === 1 && m.result) {
          sid = m.result.session_id
          ev.push('session ' + sid)
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'prompt.submit', params: { session_id: sid, text: 'Reply with exactly the word READY and nothing else.' } }))
        }
        if (m.method === 'event' && m.params && /complete|error/i.test(m.params.type || '')) {
          ev.push(m.params.type + ' ' + s.slice(0, 300))
          if (/complete/i.test(m.params.type)) { clearTimeout(t); resolve({ done: true, ms: Date.now() - t0, sid, ev, last: s.slice(0, 600) }) }
        }
      }
      ws.onerror = () => resolve({ error: 'ws error', ms: Date.now() - t0, ev })
    })
  }, { timeoutMs })
}

console.log('=== TURN 1 (cold: model download + 50K prefill) ===')
const t1 = await agentTurn('pg1', 1500000)
console.log('TURN1 =>', JSON.stringify({ ms: t1.ms, done: t1.done, ev: (t1.ev||[]).slice(-3) }))

console.log('=== RELOAD: TURN 2 (restored KV should make it fast) ===')
const t2 = await agentTurn('pg2', 600000)
console.log('TURN2 =>', JSON.stringify({ ms: t2.ms, done: t2.done, ev: (t2.ev||[]).slice(-3) }))
await browser.close()
