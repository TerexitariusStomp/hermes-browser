import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--no-sandbox','--disable-dev-shm-usage'] })
const page = await browser.newPage()
page.on('console', m => { const t = m.text(); if (/local-llm|wllama|error|bridge/i.test(t)) console.log('[pg]', t.slice(0,160)) })
await page.goto('https://near-hermes-browser.pages.dev/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 3000))
// hit the local-llm endpoint THROUGH the page's net bridge (same path the
// agent uses) — proves bootstrap -> local-llm.js -> wllama wiring on live site
const r = await page.evaluate(async () => {
  try {
    const resp = await fetch('https://local-llm.hermes/v1/models')
    return { status: resp.status, body: (await resp.text()).slice(0, 300) }
  } catch (e) { return { err: String(e).slice(0, 200) } }
})
console.log('BRIDGE /v1/models =>', JSON.stringify(r))
const s = await page.evaluate(async () => {
  try {
    const resp = await fetch('https://local-llm.hermes/v1/status')
    return { status: resp.status, body: (await resp.text()).slice(0, 300) }
  } catch (e) { return { err: String(e).slice(0, 200) } }
})
console.log('BRIDGE /v1/status =>', JSON.stringify(s))
await browser.close()
