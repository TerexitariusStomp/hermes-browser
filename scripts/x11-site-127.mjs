import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
const ctx = browser.contexts()[0]
const page = await ctx.newPage()
await page.goto('http://localhost:8471/', { waitUntil: 'domcontentloaded', timeout: 30000 })
const r = await page.evaluate(async () => {
  const out = { hasGpu: !!navigator.gpu, coi: crossOriginIsolated }
  if (navigator.gpu) {
    for (const pref of [undefined, 'low-power', 'high-performance']) {
      try {
        const a = await navigator.gpu.requestAdapter(pref ? { powerPreference: pref } : {})
        out['pref_' + (pref || 'default')] = a ? (a.info ? { vendor: a.info.vendor, arch: a.info.architecture, desc: a.info.description, device: a.info.device } : 'present') : null
      } catch (e) { out['pref_' + (pref || 'default')] = 'ERR ' + String(e).slice(0, 150) }
    }
  }
  return out
})
console.log(JSON.stringify(r, null, 1))
await browser.close()
