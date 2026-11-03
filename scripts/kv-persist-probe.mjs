import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
const server = spawn('node', ['scripts/serve.mjs', 'dist', '8474'], { cwd: '/home/terex/Documents/hermes-browser', stdio: ['ignore','pipe','inherit'] })
process.on('exit', () => server.kill())
await new Promise(r => setTimeout(r, 700))
const browser = await chromium.launch({ args: ['--no-sandbox','--disable-dev-shm-usage'] })
const ctx = await browser.newContext()
const page = await ctx.newPage()
page.on('console', m => { const t = m.text(); if (true) console.log('[pg]', t.slice(0,160)) })
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
  out.t1 = await call('say READY')   // cold: full prefill, then saveKvState fires
  await new Promise(r => setTimeout(r, 2000)) // let save settle
  // direct action check
  try {
    const w = m._wllama ? m._wllama() : null
  } catch (e) {}
  return out
})
console.log(JSON.stringify(r, null, 1))
// second page load = simulated reload: restore should kick in
const page2 = await ctx.newPage()
page2.on('console', m => { const t = m.text(); if (true) console.log('[pg2]', t.slice(0,160)) })
await page2.goto('http://localhost:8474/test-fixture.html', { waitUntil: 'domcontentloaded' })
const r2 = await page2.evaluate(async () => {
  const m = await import('/local-llm.js')
  const prefix = 'You are Hermes. ' + 'Context rule '.repeat(1200) + ' Answer briefly. '
  const t = Date.now()
  const resp = await m.handleRequest('/v1/chat/completions', 'POST', JSON.stringify({
    messages: [{ role: 'system', content: prefix }, { role: 'user', content: 'say GO' }],
    max_tokens: 4, temperature: 0,
  }))
  const j = JSON.parse(String(resp.body))
  return { ms: Date.now() - t, prompt_ms: j.timings?.prompt_ms, prompt_n: j.timings?.prompt_n, cache_n: j.timings?.cache_n, text: j.choices?.[0]?.message?.content?.slice(0,40) }
})
console.log('RELOAD =>', JSON.stringify(r2))
await browser.close(); server.kill()
