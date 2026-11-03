// Does wllama reuse the KV cache across sequential createCompletion calls?
// Probes: same 2K-token prefix, then a second call with the same prefix + new
// suffix. If turn 2 prefill time is ~0 vs turn 1's full prefill, KV reuse works.
import { chromium } from 'playwright-core'
const browser = await chromium.connectOverCDP('http://127.0.0.1:'+(process.env.CDP_PORT||'9223'), { timeout: 120000 })
const ctx = browser.contexts()[0]
const page = ctx.pages()[0] || await ctx.newPage()
if (!page.url().includes('localhost')) await page.goto('http://localhost:8471/')
page.on('console', m => { const t = m.text(); if (/wllama|llama|error|prefill|tok/i.test(t)) console.log('[pg]', t.slice(0,160)) })
const r = await page.evaluate(async () => {
  const out = {}
  const { Wllama } = await import('/vendor-wllama.js')
  const w = new Wllama({ default: '/wllama/wllama.wasm' }, { suppressNativeLog: true })
  const data = await (await fetch('/_test-model.gguf')).arrayBuffer()
  await w.loadModel([new Blob([data])], { n_ctx: 8192, n_batch: 64, cache_type_k: 'q8_0', cache_type_v: 'q8_0', n_gpu_layers: 0 })
  // shared long prefix (~2K tokens of real text)
  const prefix = 'The following is a detailed technical specification. ' + 'Section '.repeat(1500) + ' Now answer: '
  const t = async (prompt) => {
    const t0 = performance.now()
    await w.createCompletion(prompt, { nPredict: 1, temperature: 0 })
    return Math.round(performance.now() - t0)
  }
  out.turn1_ms = await t(prefix + 'what is 2+2?')
  out.turn2_samePrefix_ms = await t(prefix + 'what is 3+3?')   // same prefix, new suffix
  out.turn3_newPrefix_ms = await t('Completely unrelated short prompt. What is 5+5?') // different prefix
  out.ctxInfo = w.getLoadedContextInfo()
  return out
})
console.log(JSON.stringify(r, null, 1))
await browser.close()
