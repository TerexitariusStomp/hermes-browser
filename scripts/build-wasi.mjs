#!/usr/bin/env node
// Build the in-browser WASI userspace assets into dist/wasi/:
//   wasi-runner.js        — src/wasi-runner.mjs, served verbatim (pure ESM)
//   wasmer/               — @wasmer/sdk browser dist (index.js spawns
//                           ./browser-worker.js + ../pkg/wasmer_sdk_js.js via
//                           import.meta.url, so relative layout is preserved)
//   pkg/                  — @wasmer/sdk wasm-bindgen core (JS + .wasm)
//   webc/*.webc           — vendored WASIX packages (bash, coreutils, ...)
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'dist', 'wasi')
const require = createRequire(import.meta.url)

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

// Runner — plain ESM, no bundling (keeps import.meta.url resolution intact).
cpSync(join(root, 'src', 'wasi-runner.mjs'), join(outDir, 'wasi-runner.js'))

// Wasmer SDK — copy dist/ and pkg/ preserving the ../pkg relationship the
// browser entry resolves at runtime.
const sdkRoot = dirname(dirname(require.resolve('@wasmer/sdk')))
cpSync(join(sdkRoot, 'dist'), join(outDir, 'wasmer'), { recursive: true })
cpSync(join(sdkRoot, 'pkg'), join(outDir, 'pkg'), { recursive: true })

// Vendored WASIX packages.
const webcDir = join(root, 'vendor', 'wasi')
if (!existsSync(webcDir)) throw new Error(`missing vendored webc dir: ${webcDir}`)
const webcs = readdirSync(webcDir).filter((f) => f.endsWith('.webc'))
if (!webcs.length) throw new Error('no .webc packages in vendor/wasi')
for (const f of webcs) cpSync(join(webcDir, f), join(outDir, 'webc', f))

console.log(`wasi build complete -> ${outDir} (${webcs.length} webc packages)`)
