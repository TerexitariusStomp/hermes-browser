#!/usr/bin/env node
// Assemble dist/: vendored dist-webapp + our bootstrap/backend injected.
// index.html gets <script src="./bootstrap.js"></script> inserted BEFORE the
// first module script so the shims are installed before any renderer code runs.
//
// Layout:
//   dist/                     <- vendored upstream webapp, unmodified except
//                                the one script-tag insertion above
//   dist/bootstrap.js         <- page glue: globals, fetch/ws shims, ring writer
//   dist/backend-worker.mjs   <- Pyodide host: real tui_gateway dispatch
//   dist/vault-worker.mjs   <- secret vault boundary
//   dist/pyodide/             <- self-hosted Pyodide runtime + lock packages
//   dist/hermes-py.zip        <- vendored upstream python tree
//   dist/hermes-env.zip       <- preinstalled site-packages
//   dist/overlay/*.py         <- our python modules (runtime, bootstrap, gateway)
//   dist/_headers             <- COOP/COEP (required for SAB/Atomics) + CSP
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const webapp = resolve(root, 'vendor/hermes-agent/apps/desktop/dist-webapp')
const out = resolve(root, 'dist')
const assets = resolve(root, 'vendor/assets')
const vendored = resolve(root, 'vendor/dist')

rmSync(out, { recursive: true, force: true })
cpSync(webapp, out, { recursive: true })
mkdirSync(out, { recursive: true })

const html = readFileSync(join(out, 'index.html'), 'utf8')
const injected = html
  .replace(/<\/title>/, '</title>\n    <link rel="manifest" href="./manifest.webmanifest">')
  .replace(
    /<script type="module"/,
    '<script src="./bootstrap.js"></script>\n    <script src="./embed-peer.js"></script>\n    <script type="module"',
  )
if (injected === html) {
  console.error('assemble: could not find module script tag in index.html')
  process.exit(1)
}
writeFileSync(join(out, 'index.html'), injected)

for (const f of ['bootstrap.js', 'backend-worker.mjs', 'vault-worker.mjs', 'local-llm.js', 'pwa-bridge.js', 'host-bridge.js', 'sw.js', 'embed.js', 'embed-peer.js']) {
  cpSync(join(root, 'src', f), join(out, f))
}

// Companion host agent (P6/T3 opt-in substrate) — downloadable from the site.
try {
  cpSync(join(root, 'host-agent', 'host-agent.py'), join(out, 'host-agent.py'))
} catch (e) {
  console.warn(`host-agent copy skipped: ${e.message || e}`)
}

// PWA manifest — installability is the Chromium gate for
// periodic-background-sync registration.
writeFileSync(join(out, 'manifest.webmanifest'), JSON.stringify({
  name: 'Hermes',
  short_name: 'Hermes',
  start_url: './index.html',
  display: 'standalone',
  background_color: '#0d0d0f',
  theme_color: '#0d0d0f',
  icons: [],
}))

// wllama (MIT) — in-browser local-model endpoint. The esm build inlines its
// worker + emscripten glue; only the wasm binary ships separately.
const wllamaPkg = resolve(root, 'node_modules/@wllama/wllama/esm')
try {
  cpSync(join(wllamaPkg, 'index.js'), join(out, 'vendor-wllama.js'))
  mkdirSync(join(out, 'wllama'), { recursive: true })
  cpSync(join(wllamaPkg, 'wasm', 'wllama.wasm'), join(out, 'wllama', 'wllama.wasm'))
} catch (e) {
  console.warn(`wllama vendor copy skipped: ${e.message || e}`)
}

cpSync(resolve(assets, 'pyodide'), join(out, 'pyodide'), { recursive: true })

mkdirSync(join(out, 'overlay'), { recursive: true })
const overlayFiles = ['browser_runtime.py', 'browser_bootstrap.py', 'py_gateway.py']
for (const f of overlayFiles) {
  cpSync(join(root, 'src', f), join(out, 'overlay', f))
}

// Browser-runtime Hermes plugin (discovers at ~/.hermes/plugins post-install).
// Recursive: skills/ holds SKILL.md files registered by the plugin.
function* walk(dir, rel = '') {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (f.isDirectory()) yield* walk(join(dir, f.name), `${rel}${f.name}/`)
    else yield `${rel}${f.name}`
  }
}
for (const f of walk(join(root, 'src', 'plugins', 'hermes_browser'))) {
  const rel = `plugins/hermes_browser/${f}`
  mkdirSync(join(out, 'overlay', 'plugins', 'hermes_browser', f.split('/').slice(0, -1).join('/')), { recursive: true })
  cpSync(join(root, 'src', 'plugins', 'hermes_browser', f), join(out, 'overlay', rel))
  overlayFiles.push(rel)
}

// models.dev seed — upstream serves a disk snapshot instantly and refreshes
// in the background, so seeding one removes the only blocking cold fetch
// (model.save_key / provider inventory). ~525KB gzipped. Build continues
// without it when the registry is unreachable.
try {
  const { gzipSync } = await import('node:zlib')
  const res = await fetch('https://models.dev/api.json')
  if (res.ok) {
    const body = Buffer.from(await res.arrayBuffer())
    writeFileSync(join(out, 'overlay', 'models-dev-seed.json.gz'), gzipSync(body, { level: 9 }))
    const etag = (res.headers.get('etag') || '').replace(/"/g, '').trim()
    if (etag) {
      writeFileSync(join(out, 'overlay', 'models-dev-seed.etag'), etag)
      overlayFiles.push('models-dev-seed.etag')
    }
    overlayFiles.push('models-dev-seed.json.gz')
    console.log(`models.dev seed: ${(body.length / 1e6).toFixed(1)}MB -> ${(gzipSync(body).length / 1e3).toFixed(0)}KB gz`)
  } else {
    console.warn(`models.dev seed fetch failed: HTTP ${res.status}`)
  }
} catch (e) {
  console.warn(`models.dev seed skipped: ${e.message || e}`)
}

cpSync(join(vendored, 'hermes-py.zip'), join(out, 'hermes-py.zip'))
cpSync(join(vendored, 'hermes-env.zip'), join(out, 'hermes-env.zip'))

// Test/dev fixtures (e2e substrate target etc.) — tiny static files.
cpSync(resolve(root, 'public'), out, { recursive: true })

// Embeddable: any https page (and localhost dev) may frame the app — vault
// stays on this origin, and embed-peer.js consent-gates host API calls. CORP
// is cross-origin so the frameable document isn't blocked by COEP-era checks.
writeFileSync(join(out, '_headers'), `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: cross-origin
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self' https: wss:; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors https: http://localhost:* http://127.0.0.1:*
`)
writeFileSync(join(out, 'overlay', 'manifest.json'), JSON.stringify(
  overlayFiles.map((n) => ({ name: n, url: `./overlay/${n}` }))))

console.log(`assembled ${out}`)

// WASI userspace bundle (cowasm kernel + dash/coreutils) — built after dist
// since assemble wipes dist/; skipped quietly when deps aren't installed.
try {
  const { execFileSync } = await import('node:child_process')
  execFileSync(process.execPath, [resolve(root, 'scripts/build-wasi.mjs')], { stdio: 'inherit' })
} catch (e) {
  console.warn(`wasi build skipped: ${e.message || e}`)
}
