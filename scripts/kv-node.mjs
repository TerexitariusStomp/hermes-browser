globalThis.caches = { _m: new Map(),
  open: async n => { let c = globalThis.caches._m.get(n); if (!c) { c = { put: async()=>{}, match: async()=>undefined, delete: async()=>true }; globalThis.caches._m.set(n, c) } return c },
  delete: async n => globalThis.caches._m.delete(n), keys: async () => [...globalThis.caches._m.keys()] }
import { Wllama } from '../node_modules/@wllama/wllama/esm/index.js'
import { readFileSync } from 'fs'
const w = new Wllama({ default: 'node_modules/@wllama/wllama/esm/wasm/wllama.wasm' }, { suppressNativeLog: true })
const data = readFileSync('dist/_test-model.gguf')
await w.loadModel([new Blob([data])], { n_ctx: 8192, n_batch: 64, cache_type_k: 'q8_0', cache_type_v: 'q8_0', n_gpu_layers: 0 })
const prefix = 'The following is a detailed technical specification. ' + 'Section '.repeat(1500) + ' Now answer: '
const t = async (p) => { const t0 = Date.now(); await w.createCompletion(p, { nPredict: 1, temperature: 0 }); return Date.now() - t0 }
const r = {}
r.turn1_ms = await t(prefix + 'what is 2+2?')
r.turn2_samePrefix_ms = await t(prefix + 'what is 3+3?')
r.turn3_newPrefix_ms = await t('Completely unrelated short prompt. What is 5+5?')
console.log(JSON.stringify(r))
await w.exit()
