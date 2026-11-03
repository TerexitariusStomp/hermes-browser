// Dump WebGPU adapter info + feature set at page and worker level.
// Usage: node scripts/adapter-features-127.mjs [url]
import { chromium } from 'playwright-core'
const browser = await chromium.connectOverCDP('http://127.0.0.1:'+(process.env.CDP_PORT||'9223'))
const ctx = browser.contexts()[0]
const page = ctx.pages()[0] || await ctx.newPage()
const url = process.argv[2] || 'http://localhost:8471/'
if (!page.url().includes('localhost')) await page.goto(url).catch(()=>{})
page.on('console', m => console.log('[pg]', m.text().slice(0,200)))
const r = await page.evaluate(async () => {
  const out = {}
  const dump = (a) => a ? {
    vendor: a.info?.vendor, arch: a.info?.architecture,
    desc: a.info?.description, device: a.info?.device,
    features: [...a.features].sort(),
    limits: { workgroupStorage: a.limits?.maxComputeWorkgroupStorageSize, invocations: a.limits?.maxComputeInvocationsPerWorkgroup },
  } : null
  out.page = dump(await navigator.gpu?.requestAdapter())
  // same adapter request inside a dedicated worker, repeated for flake rate
  const src = `onmessage=async()=>{try{const a=await self.navigator.gpu?.requestAdapter();postMessage({ok:!!a,f:a?[...a.features].includes('shader-f16'):null,v:a?.info?.vendor||null})}catch(e){postMessage({err:String(e)})}}`
  out.worker = []
  for (let i=0;i<10;i++) out.worker.push(await new Promise(res=>{const w=new Worker(URL.createObjectURL(new Blob([src])));w.onmessage=e=>res(e.data);w.postMessage(0);setTimeout(()=>res({timeout:true}),8000)}))

  return out
})
console.log(JSON.stringify(r, null, 1))
await browser.close()
