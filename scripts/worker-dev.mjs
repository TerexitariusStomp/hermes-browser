import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://localhost:9223')
const ctx = browser.contexts()[0]
const page = ctx.pages()[0] || await ctx.newPage()
const r = await page.evaluate(async () => {
  const src = `onmessage = async () => {
    const out = {}
    try {
      const a = await self.navigator.gpu.requestAdapter()
      out.adapter = a ? (a.info ? { vendor: a.info.vendor, arch: a.info.architecture } : 'present') : null
      if (a) {
        const t0 = Date.now()
        const d = await Promise.race([
          a.requestDevice().then(x => 'GOT ' + Date.now() - t0 + 'ms'),
          new Promise(res => setTimeout(() => res('TIMEOUT 30s'), 30000)),
        ])
        out.device = d
      }
    } catch (e) { out.err = String(e).slice(0, 200) }
    postMessage(out)
  }`
  return await new Promise(res => {
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })))
    w.onmessage = e => res(e.data)
    w.onerror = e => res({ workerErr: String(e.message) })
    w.postMessage(0)
    setTimeout(() => res({ timeout: true }), 40000)
  })
})
console.log(JSON.stringify(r))
await browser.close()
