import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://localhost:9223')
const ctx = browser.contexts()[0]
const page = ctx.pages()[0] || await ctx.newPage()
const r = await page.evaluate(async () => {
  const out = {}
  try {
    const a = await navigator.gpu.requestAdapter()
    out.adapter = a.info ? { vendor: a.info.vendor, arch: a.info.architecture } : 'present'
    out.features = [...a.features]
    out.limits = {
      maxStorage: a.limits.maxStorageBufferBindingSize,
      maxBuf: a.limits.maxBufferSize,
      maxWorkgroupStorage: a.limits.maxComputeWorkgroupStorageSize,
      maxInvocations: a.limits.maxComputeInvocationsPerWorkgroup,
    }
    const dev = await a.requestDevice().catch(e => ({ err: String(e).slice(0, 200) }))
    out.device = dev && !dev.err ? 'GOT DEVICE' : dev
  } catch (e) { out.err = String(e).slice(0, 200) }
  return out
})
console.log(JSON.stringify(r, null, 1))
await browser.close()
