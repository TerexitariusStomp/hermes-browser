import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
const server = spawn('node', ['scripts/serve.mjs', 'dist', '8474'], { cwd: '/home/terex/Documents/hermes-browser', stdio: ['ignore','pipe','inherit'] })
process.on('exit', () => server.kill())
await new Promise(r => setTimeout(r, 700))
const browser = await chromium.launch({ args: ['--no-sandbox','--disable-dev-shm-usage'] })
const page = await browser.newPage()
page.on('console', m => { const t = m.text(); if (/ready|error|wllama|llama/i.test(t)) console.log('[pg]', t.slice(0,160)) })
await page.goto('http://localhost:8474/test-fixture.html', { waitUntil: 'domcontentloaded' })
const r = await page.evaluate(async () => {
  const m = await import('/local-llm.js')
  const prefix = 'You are Hermes. ' + 'Context rule '.repeat(1200) + ' Answer briefly. '
  const call = async (content) => {
    const t = Date.now()
    const resp = await m.handleRequest('/v1/chat/completions', 'POST', JSON.stringify({
      messages: [{ role: 'system', content: prefix }, { role: 'user', content }],
      max_tokens: 4, temperature: 0,
    }))
    const j = JSON.parse(String(resp.body))
    return { ms: Date.now() - t, prompt_ms: j.timings?.prompt_ms, prompt_n: j.timings?.prompt_n, cache_n: j.timings?.cache_n, text: j.choices?.[0]?.message?.content?.slice(0,40) }
  }
  const out = {}
  out.t1 = await call('say READY')   // full prefix prefill
  out.t2_same = await call('say GO') // same prefix -> should reuse KV
  out.t3_diff = await call('say STOP') // same prefix again
  return out
})
console.log(JSON.stringify(r, null, 1))
await browser.close(); server.kill()
