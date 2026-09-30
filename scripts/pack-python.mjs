#!/usr/bin/env node
// Pack the vendored upstream Python tree into a zip Pyodide can unpack onto
// its FS. Ships importable roots only — no tests/apps/website/ui-tui.
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(root, 'vendor/hermes-agent')
const outDir = resolve(root, 'vendor/dist')
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'hermes-py.zip')

const PY_ROOTS = [
  'agent', 'tools', 'tui_gateway', 'hermes_cli', 'gateway', 'cron',
  'plugins', 'providers', 'acp_adapter', 'hermes_platform', 'pm', 'skills',
]

const missing = PY_ROOTS.filter((r) => !existsSync(join(src, r)))
if (missing.length) { console.error(`missing roots in vendored tree: ${missing}`); process.exit(1) }

// Root-level importable .py modules (run_agent.py, model_tools.py, ...).
const rootPy = readdirSync(src).filter((f) => f.endsWith('.py') && statSync(join(src, f)).isFile())

const args = ['-qr', out]
for (const dir of PY_ROOTS) args.push(dir)
for (const f of rootPy) args.push(f)

// zip from the vendor root so archive paths are import-relative.
try {
  execFileSync('zip', args, { cwd: src, stdio: 'inherit' })
} catch {
  // Fallback: python zipfile (always available).
  const { execFileSync: run } = await import('node:child_process')
  run('python3', ['-c', `
import os, zipfile, sys
out, src, roots, rootpy = sys.argv[1], sys.argv[2], sys.argv[3].split(','), sys.argv[4].split(',')
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for r in roots:
        for dp, dns, fns in os.walk(os.path.join(src, r)):
            dns[:] = [d for d in dns if d != '__pycache__' and not d.startswith('.')]
            for fn in fns:
                if fn.endswith(('.py', '.json', '.yaml', '.yml', '.txt', '.md', '.j2', '.jinja', '.jinja2')):
                    fp = os.path.join(dp, fn)
                    z.write(fp, os.path.relpath(fp, src))
    for fn in rootpy:
        z.write(os.path.join(src, fn), fn)
`, out, src, PY_ROOTS.join(','), rootPy.join(',')], { stdio: 'inherit' })
}
const size = statSync(out).size
console.log(`packed ${out} (${(size / 1e6).toFixed(1)} MB)`)
