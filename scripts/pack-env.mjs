#!/usr/bin/env node
// pack-env.mjs — build the vendored Python environment for the browser:
// installs Hermes' runtime deps under build-time Pyodide, then packs
// site-packages into vendor/dist/hermes-env.zip which the worker unpacks
// and puts on sys.path. No runtime PyPI/CDN dependency.
import { loadPyodide } from 'pyodide'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, 'vendor/dist')
mkdirSync(out, { recursive: true })

const pyodide = await loadPyodide()
// Only stdlib/binary-adjacent packages via loadPackage — preloading a
// pyodide-built wheel (e.g. pydantic) makes micropip refuse to install a
// version another dependency resolves to. micropip resolves pyodide-tagged
// wheels itself.
await pyodide.loadPackage(['micropip', 'ssl', 'sqlite3'])
const mp = pyodide.pyimport('micropip')

// Upstream pins are python>=3.14-gated (Pyodide runs 3.13): install by name.
// Binary deps resolve to Pyodide-built wheels via loadPackage above / micropip's
// own resolution of pyodide-tagged wheels on PyPI when available.
const DEPS = [
  'ruamel.yaml', 'openai', 'httpx', 'python-dotenv', 'tenacity', 'tomli-w',
  'requests', 'jinja2', 'croniter', 'snowballstemmer', 'websockets', 'rich',
  'prompt_toolkit', 'fire', 'firecrawl-anydoc',
  // web_server ASGI surface (the full dashboard REST app runs in-process).
  // typing-extensions must satisfy fastapi's floor before it resolves.
  'typing-extensions>=4.15.0', 'starlette', 'anyio', 'python-multipart',
  'itsdangerous', 'sse-starlette', 'fastapi',
  // in-process ASGI client for the REST+WS surface (pure python: wsproto/h11)
  'httpx-ws',
  // pyodide-tagged binary wheels micropip can resolve
  'Pillow',
]
const failed = []
for (const pkg of DEPS) {
  // Earlier deps pin typing-extensions<4.15 and import it; fastapi needs
  // >=4.15 — reinstall is the only way past a loaded module.
  try {
    if (pkg.startsWith('typing-extensions')) {
      await mp.install.callKwargs(pkg, { reinstall: true })
    } else {
      await mp.install(pkg)
    }
  } catch (e) {
    console.warn(`[env] ${pkg}: ${String(e.message).split('\n')[0]}`)
    failed.push(pkg)
  }
}

const b64 = await pyodide.runPythonAsync(`
import shutil, base64
shutil.make_archive('/tmp/hermes-env', 'zip', '/lib/python3.13/site-packages')
base64.b64encode(open('/tmp/hermes-env.zip','rb').read()).decode()
`)
writeFileSync(resolve(out, 'hermes-env.zip'), Buffer.from(b64, 'base64'))
console.log(`env packed -> vendor/dist/hermes-env.zip (${Math.round(Buffer.from(b64, 'base64').length / 1024 / 1024)}MB)`)
if (failed.length) console.log('FAILED DEPS:', failed.join(', '))
