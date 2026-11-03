// transformers.js WebGPU speed test on NVIDIA: Llama-3.2-1B q4 (fp32 compute)
import { chromium } from 'playwright-core'
const browser = await chromium.connectOverCDP('http://127.0.0.1:'+(process.env.CDP_PORT||'9223'), { timeout: 120000 })
const ctx = browser.contexts()[0]
const page = await ctx.newPage()
await page.goto('http://localhost:8471/', { timeout: 120000 })
page.on('console', m => { const t = m.text(); if (/tps|error|warn|dtype|webgpu|Assigned|progress/i.test(t)) console.log('[pg]', t.slice(0, 180)) })
const r = await page.evaluate(async () => {
  const out = { imported: false }
  try {
    const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1')
    out.imported = true
    const gen = await pipeline('text-generation', 'onnx-community/Qwen2.5-0.5B-Instruct',
      { device: 'webgpu', dtype: 'q4' })
    out.ready = true
    // warmup
    await gen('Hi', { max_new_tokens: 3, do_sample: false })
    const prompt = 'Explain the theory of relativity in simple terms.'
    const t0 = performance.now()
    const res = await gen(prompt, { max_new_tokens: 60, do_sample: false })
    const dt = (performance.now() - t0) / 1000
    out.genSec = +dt.toFixed(2)
    out.text = res?.[0]?.generated_text?.slice(0, 220)
    // count generated tokens
    const t1 = performance.now()
    const res2 = await gen(prompt, { max_new_tokens: 120, do_sample: false })
    const dt2 = (performance.now() - t1) / 1000
    out.genSec2 = +dt2.toFixed(2)
    out.toksPerSec2 = +(120 / dt2).toFixed(1)
    out.text2 = res2?.[0]?.generated_text?.slice(0, 220)
  } catch (e) { out.err = String(e?.message || e).slice(0, 300) }
  return out
})
console.log(JSON.stringify(r, null, 1))
await browser.close()
