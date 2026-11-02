import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://localhost:9223')
const ctx = browser.contexts()[0]
const page = ctx.pages()[0] || await ctx.newPage()
const r = await page.evaluate(async () => {
  const src = `onmessage = async () => {
    try { const a = await self.navigator.gpu.requestAdapter(); postMessage({ok: !!a}) }
    catch(e) { postMessage({err: e.name + ': ' + e.message, name: e.name}) }
  }`
  return await new Promise(res => {
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })))
    w.onmessage = e => res(e.data)
    w.onerror = e => res({ workerErr: String(e.message) })
    w.postMessage(0)
    setTimeout(() => res({ timeout: true }), 30000)
  })
})
console.log(JSON.stringify(r))
await browser.close()
