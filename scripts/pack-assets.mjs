#!/usr/bin/env node
// pack-assets.mjs — vendor Pyodide runtime + pure-Python wheels into
// vendor/assets/ so production serves every byte from our own origin
// (CSP script-src 'self'; no PyPI/CDN at runtime).
import { cpSync, mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assets = resolve(root, 'vendor/assets')
const pyodideSrc = resolve(root, 'node_modules/pyodide')
const wheelsDir = resolve(assets, 'wheels')
mkdirSync(wheelsDir, { recursive: true })

// 1. Pyodide runtime files (the loadPackage-driven packages resolve against
//    pyodide-lock.json from the same dir).
const pyodideDist = resolve(assets, 'pyodide')
mkdirSync(pyodideDist, { recursive: true })
for (const f of readdirSync(pyodideSrc)) {
  if (/\.(mjs|js|wasm|zip|json|whl|data)$/.test(f) || f === 'pyodide.asm.js') {
    cpSync(join(pyodideSrc, f), join(pyodideDist, f))
  }
}
console.log('pyodide assets copied')

// 2. Pure-Python wheels via pip download (py3-none-any / abi3 only).
const PURE_DEPS = [
  'ruamel.yaml', 'openai', 'httpx[socks]', 'python-dotenv', 'tenacity',
  'tomli-w', 'requests', 'jinja2', 'croniter', 'snowballstemmer',
  'websockets', 'rich', 'prompt_toolkit', 'fire', 'truststore',
]
const out = execFileSync('python3', [
  '-m', 'pip', 'download', '--dest', wheelsDir,
  '--only-binary=:all:', '--platform', 'any', '--python-version', '3.13',
  '--implementation', 'py', '--abi', 'none',
  ...PURE_DEPS,
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// 3. Wheel manifest consumed by the worker at boot.
const wheels = readdirSync(wheelsDir).filter((f) => f.endsWith('.whl'))
writeFileSync(join(wheelsDir, 'manifest.json'), JSON.stringify(wheels, null, 2))
console.log(`wheels: ${wheels.length}`)
wheels.forEach((w) => console.log('  ' + w))
