import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
const server = spawn('node', ['scripts/serve.mjs', 'dist', '8474'], { cwd: '/home/terex/Documents/hermes-browser', stdio: ['ignore','pipe','inherit'] })
process.on('exit', () => server.kill())
await new Promise(r => setTimeout(r, 700))
const browser = await chromium.launch({ args: ['--no-sandbox','--disable-dev-shm-usage'] })
const page = await browser.newPage()
page.on('console', m => console.log('[pg]', m.text().slice(0,200)))
await page.goto('http://localhost:8474/test-fixture.html', { waitUntil: 'domcontentloaded' })
const t0 = Date.now()
const r = await page.evaluate(async () => {
  const m = await import('/local-llm.js')
  const t = Date.now()
  // tiny prompt — isolates endpoint+model from the giant agent system prompt
  const resp = await m.handleRequest('/v1/chat/completions', 'POST', JSON.stringify({
    messages: [{ role: 'user', content: 'Reply with exactly: READY' }],
    max_tokens: 8, temperature: 0,
  }))
  return { ms: Date.now() - t, status: resp.status, body: String(resp.body).slice(0, 400) }
})
console.log('DIRECT after', ((Date.now()-t0)/1000).toFixed(0)+'s =>', JSON.stringify(r))
await browser.close(); server.kill()
