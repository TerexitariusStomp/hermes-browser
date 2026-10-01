import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const ctx = await browser.newContext()
// Pre-seed the consent grant on the agent origin so the first call
// doesn't block on the (real) consent overlay.
await ctx.addInitScript(() => {
  try { localStorage.setItem('hermes.embed.grants', JSON.stringify({ 'http://localhost:8471': 'allow' })) } catch (e) {}
})
const page = await ctx.newPage()
page.on('console', m => { const t = m.text(); if (!/net::ERR|model-catalog|CORS/.test(t)) console.log('[pg]', t.slice(0, 200)) })
page.on('pageerror', e => console.log('[pageerror]', e.message.slice(0, 300)))
await page.goto('http://localhost:8471/embed-test.html')
await page.waitForTimeout(75000)
const res = await Promise.race([page.evaluate(() => window.__TEST__), new Promise(r => setTimeout(() => r('still-pending'), 5000))])
console.log('EMBED:', JSON.stringify(res).slice(0, 400))
await browser.close()
