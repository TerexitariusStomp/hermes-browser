import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
const ctx = browser.contexts()[0]
const page = ctx.pages()[0] || await ctx.newPage()
const r = await page.evaluate(async () => {
  const src = `onmessage = async () => {
    const res = []
    for (let i = 0; i < 8; i++) {
      try { const a = await self.navigator.gpu.requestAdapter(); res.push(a ? 'GPU' : 'null') }
      catch(e) { res.push('ERR') }
    }
    postMessage(res)
  }`
  return await new Promise(res => {
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })))
    w.onmessage = e => res(e.data)
    w.onerror = e => res({ err: String(e.message) })
    w.postMessage(0)
    setTimeout(() => res({ timeout: true }), 60000)
  })
})
console.log(JSON.stringify(r))
await browser.close()
