// transformers.js WebGPU probe: does ORT WebGPU init on the NVIDIA adapter
// (no shader-f16) and generate text? Run against the debug-port Chrome.
import { chromium } from 'playwright-core'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 120000 })
const ctx = browser.contexts()[0]
const page = ctx.pages()[0] || await ctx.newPage()
if (!page.url().includes('localhost')) await page.goto('http://localhost:8471/', { timeout: 120000 })
page.on('console', m => console.log('[pg]', m.text().slice(0, 200)))
const r = await page.evaluate(async () => {
  const out = { imported: false }
  try {
    const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1')
    out.imported = true
    env.allowRemoteModels = true
    const a = await navigator.gpu.requestAdapter()
    out.adapter = { vendor: a?.info?.vendor, f16: a ? [...a.features].includes('shader-f16') : null }
    const gen = await pipeline('text-generation', 'Xenova/distilgpt2', { device: 'webgpu' })
    out.sessionReady = true
    const t0 = performance.now()
    const res = await gen('The capital of France is', { max_new_tokens: 20, do_sample: false })
    out.ms = Math.round(performance.now() - t0)
    out.text = res?.[0]?.generated_text
    out.backend = gen.model?.session?.inputNames ? 'webgpu' : '?'
  } catch (e) { out.err = String(e?.message || e).slice(0, 300) }
  return out
})
console.log(JSON.stringify(r, null, 1))
await browser.close()
