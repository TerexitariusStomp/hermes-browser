import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--no-sandbox','--disable-dev-shm-usage'] })
const page = await browser.newPage()
const errs = []
page.on('pageerror', e => errs.push(e.message))
await page.goto('https://near-hermes-browser.pages.dev/', { waitUntil: 'domcontentloaded', timeout: 60000 })
let ready = false
for (let i = 0; i < 120 && !ready; i++) {
  ready = await page.evaluate(() => !!window.__HERMES_BACKEND_READY__).catch(() => false)
  if (!ready) await new Promise(r => setTimeout(r, 2500))
}
const probe = await page.evaluate(async () => {
  const out = {}
  out.coi = window.crossOriginIsolated
  try {
    const r = await fetch('/api/status', { headers: { 'X-Hermes-Session-Token': window.__HERMES_BOOTSTRAP__.sessionToken } })
    out.status = r.status
    out.model = (await r.json()).model || null
  } catch (e) { out.status = 'ERR ' + e.message }
  try {
    // proxied call through the live _worker.js /proxy/ route
    const r = await fetch('/proxy/welcome-api.nousresearch.com/')
    out.proxyStatus = r.status
    out.proxyMarker = r.headers.get('x-hermes-proxy')
  } catch (e) { out.proxyStatus = 'ERR ' + e.message }
  return out
})
console.log(JSON.stringify({ ready, ...probe, pageerrors: errs.length }))
await browser.close()
