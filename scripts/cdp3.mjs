import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://localhost:9223')
const ctx = browser.contexts()[0]
const page = ctx.pages()[0] || await ctx.newPage()
const r = await page.evaluate(async () => {
  const out = { hasGpu: !!navigator.gpu }
  if (navigator.gpu) {
    const a = await navigator.gpu.requestAdapter().catch(e => ({err:String(e).slice(0,200)}))
    out.adapter = a && !a.err ? (a.info ? {vendor:a.info.vendor, arch:a.info.architecture, desc:a.info.description, fallback: a.isFallbackAdapter} : 'present') : a
  }
  return out
})
console.log(JSON.stringify(r))
await browser.close()
