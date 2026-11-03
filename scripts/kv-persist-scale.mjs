import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
const server = spawn('node', ['scripts/serve.mjs', 'dist', '8474'], { cwd: '/home/terex/Documents/hermes-browser', stdio: ['ignore','pipe','inherit'] })
process.on('exit', () => server.kill())
await new Promise(r => setTimeout(r, 700))
const browser = await chromium.launch({ args: ['--no-sandbox','--disable-dev-shm-usage'] })
const ctx = await browser.newContext()
const PREFIX = 'You are Hermes. ' + 'Policy rule '.repeat(5000) + ' Answer briefly. '
const call = async (page, content, sys) => page.evaluate(async ({ content, sys }) => {
  const m = await import('/local-llm.js')
  const t = Date.now()
  const resp = await m.handleRequest('/v1/chat/completions', 'POST', JSON.stringify({
    messages: [{ role: 'system', content: sys }, { role: 'user', content }],
    max_tokens: 4, temperature: 0,
  }))
  const j = JSON.parse(String(resp.body))
  return { ms: Date.now() - t, prompt_ms: j.timings?.prompt_ms, prompt_n: j.timings?.prompt_n, cache_n: j.timings?.cache_n, text: j.choices?.[0]?.message?.content?.slice(0,40) }
}, { content, sys })

const pg = (n) => {
  const p = ctx.newPage()
  p.then(page => page.on('console', m => { const t = m.text(); if (/KV|prim|ready|error/i.test(t)) console.log(`[pg${n}]`, t.slice(0,160)) }))
  return p
}

// page 1: cold prefill with ~10K-token system prefix, then snapshot saves
const p1 = await pg(1)
await p1.goto('http://localhost:8474/test-fixture.html', { waitUntil: 'domcontentloaded' })
console.log('COLD =>', JSON.stringify(await call(p1, 'say READY', PREFIX)))
await new Promise(r => setTimeout(r, 20000))

// page 2: reload — restored snapshot should make turn 1 warm
const p2 = await pg(2)
await p2.goto('http://localhost:8474/test-fixture.html', { waitUntil: 'domcontentloaded' })
await new Promise(r => setTimeout(r, 2500))
console.log('RELOAD =>', JSON.stringify(await call(p2, 'say GO', PREFIX)))

// page 3: reload — different prompt must NOT corrupt output; partial/zero reuse ok
const p3 = await pg(3)
await p3.goto('http://localhost:8474/test-fixture.html', { waitUntil: 'domcontentloaded' })
await new Promise(r => setTimeout(r, 2500))
const OTHER = 'Totally different system context. ' + 'Other '.repeat(600)
console.log('MISMATCH =>', JSON.stringify(await call(p3, 'say OK', OTHER)))
await browser.close(); server.kill()
