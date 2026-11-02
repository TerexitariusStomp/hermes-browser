import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://localhost:9223')
const ctx = browser.contexts()[0]
const page = ctx.pages()[0] || await ctx.newPage()
const out = await page.evaluate(async () => {
  const res = []
  for (let i = 0; i < 6; i++) {
    try {
      const a = await navigator.gpu.requestAdapter()
      res.push(a ? (a.info ? a.info.vendor + '/' + a.info.architecture : 'present') : 'null')
    } catch (e) { res.push('ERR ' + String(e).slice(0, 80)) }
    await new Promise(r => setTimeout(r, 3000))
  }
  return res
})
console.log(JSON.stringify(out))
await browser.close()
