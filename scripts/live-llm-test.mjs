import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--no-sandbox','--disable-dev-shm-usage'] })
const page = await browser.newPage()
page.on('console', m => { const t = m.text(); if (/local-llm|wllama|KV|prim|error/i.test(t)) console.log('[pg]', t.slice(0,160)) })
await page.goto('https://near-hermes-browser.pages.dev/test-fixture.html', { waitUntil: 'domcontentloaded', timeout: 60000 })
const r = await page.evaluate(async () => {
  const m = await import('/local-llm.js')
  const models = await m.handleRequest('/v1/models', 'GET')
  return { status: models.status, body: String(models.body).slice(0, 300) }
})
console.log('LIVE /v1/models =>', JSON.stringify(r))
await browser.close()
