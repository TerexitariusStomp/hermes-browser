import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://localhost:9223')
const ctx = browser.contexts()[0]
const page = ctx.pages()[0] || await ctx.newPage()
page.on('console', m => console.log('[pg]', m.text().slice(0,160)))
const r = await page.evaluate(async () => {
  const out = {}
  const a = await navigator.gpu.requestAdapter()
  out.adapter = a.info ? { vendor: a.info.vendor, arch: a.info.architecture } : 'present'
  const W = (await import('/vendor-wllama.js')).Wllama
  const blob = await (await fetch('/_test-model.gguf')).blob()
  const w = new W({ default: '/wllama/wllama.wasm' }, { suppressNativeLog: true })
  const t0 = Date.now()
  await w.loadModel([blob], { n_ctx: 65536, cache_type_k: 'q8_0', cache_type_v: 'q8_0' })
  out.loadMs = Date.now() - t0
  out.ctx = w.getLoadedContextInfo().n_ctx ?? null
  const resp = await w.createChatCompletion({ messages: [{ role: 'user', content: 'word '.repeat(2000) + ' — say READY' }], max_tokens: 8 })
  out.timings = resp.timings
  out.text = resp.choices?.[0]?.message?.content
  return out
})
console.log(JSON.stringify(r, null, 1))
await browser.close()
