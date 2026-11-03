import { chromium } from 'playwright'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223')
const ctx = browser.contexts()[0]
const page = ctx.pages()[0] || await ctx.newPage()
page.on('request', r => { if (!r.url().includes('models.dev') && !r.url().includes('nousresearch') && !r.url().includes('githubusercontent')) console.log('REQ', r.url().slice(0,110)) })
page.on('response', r => { const ct = r.headers()['content-type'] || ''; if (ct.includes('html') || !r.ok()) console.log('HTML-RESP', r.status(), r.url().slice(0,110)) })
page.on('console', m => console.log('[pg]', m.text().slice(0,160)))
await page.goto('http://localhost:8471/', { waitUntil: 'domcontentloaded' })
const r = await page.evaluate(async () => {
  const out = {}
  for (const k of await caches.keys()) { await caches.delete(k) }
  for (const d of await indexedDB.databases()) { await indexedDB.deleteDatabase(d.name) }
  console.log('caches cleared')
  try {
    const webllm = await import('/_webllm/index.js')
    out.imported = true
    const t0 = Date.now()
    const engine = await webllm.CreateMLCEngine('Llama-3.2-1B-Instruct-q4f32_1-MLC', {
      appConfig: { useIndexedDBCache: true, model_list: [{
        model: location.origin + '/_mlc32/',
        model_id: 'Llama-3.2-1B-Instruct-q4f32_1-MLC',
        model_lib: location.origin + '/_mlc32/model.wasm',
        overrides: { context_window_size: 4096 },
      }] },
      initProgressCallback: p => console.log('progress', p.text?.slice(0,80)),
    })
    out.loadMs = Date.now() - t0
    const t1 = Date.now()
    const resp = await engine.chat.completions.create({
      messages: [{ role: 'user', content: 'Say READY' }],
      max_tokens: 8,
    })
    out.genMs = Date.now() - t1
    out.text = resp.choices?.[0]?.message?.content
    out.usage = resp.usage
  } catch (e) { out.err = String(e).slice(0, 300) }
  return out
})
console.log(JSON.stringify(r, null, 1))
await browser.close()
