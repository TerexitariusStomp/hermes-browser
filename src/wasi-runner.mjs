// wasi-runner.mjs — WASIX userspace runner for the `wasi` terminal backend.
// Served verbatim at dist/wasi/wasi-runner.js; lazy-imported by bootstrap.js.
//
// The Wasmer SDK (dist/wasi/wasmer/) runs WASIX guests in web workers with
// real subprocess/pipe support. Vendored .webc packages (dist/wasi/webc/)
// provide bash + coreutils + grep/sed/findutils/tar; the sandbox filesystem
// persists across execs for the life of the page. Network is disabled.
const SDK_URL = new URL('./wasmer/index.js', import.meta.url).href
const webcUrl = (name) => new URL(`./webc/${name}.webc`, import.meta.url).href

const PACKAGES = ['bash', 'coreutils', 'grep', 'sed', 'findutils', 'tar']
const ENV = {
  TERM: 'xterm-256color',
  HOME: '/root',
  PATH: '/usr/bin:/bin',
}

let sandboxPromise = null
let queue = Promise.resolve()

async function getSandbox() {
  if (!sandboxPromise) {
    sandboxPromise = (async () => {
      const { Wasmer } = await import(SDK_URL)
      const wasmer = await new Wasmer({ cache: 'memory', parallelism: 2 }).ready()
      const sources = await Promise.all(PACKAGES.map(async (n) => {
        const res = await fetch(webcUrl(n))
        if (!res.ok) throw new Error(`webc ${n}: HTTP ${res.status}`)
        return new Uint8Array(await res.arrayBuffer())
      }))
      const pkgs = await wasmer.packages.loadMany(sources)
      const bash = pkgs.find((p) => p.commands.includes('bash')) || pkgs[0]
      return wasmer.sandboxes.create({
        packages: pkgs,
        shell: bash,
        env: ENV,
        network: { mode: 'disabled' },
      })
    })()
    sandboxPromise.catch(() => { sandboxPromise = null })
  }
  return sandboxPromise
}

function resetSandbox() { sandboxPromise = null }

// Serialize execs — one shell process at a time keeps stdout/stderr and the
// shared sandbox filesystem ordering predictable for the agent.
function enqueue(fn) {
  const next = queue.then(fn, fn)
  queue = next.then(() => undefined, () => undefined)
  return next
}

async function exec(args) {
  const sandbox = await getSandbox()
  const timeoutMs = Math.min(Math.max(Number(args.timeout_s || 120) * 1000, 1000), 600000)
  const out = await sandbox.shell(String(args.command || ''), {
    cwd: args.cwd || '/',
  }).run({
    stdin: args.stdin ? String(args.stdin) : undefined,
    timeoutMs,
    check: false,
  })
  const result = {
    stdout: out.stdout.text(),
    stderr: out.stderr.text(),
    exit_code: out.exitCode | 0,
  }
  if (out.reason === 'timeout') result.error = 'exec_timeout'
  return result
}

async function status() {
  try {
    await getSandbox()
    return { available: true, detail: 'WASIX userspace (bash + coreutils via @wasmer/sdk)' }
  } catch (e) {
    return { available: false, reason: String(e && e.message || e) }
  }
}

export function call(op, args) {
  return enqueue(async () => {
    try {
      if (op === 'status') return await status()
      if (op === 'exec') return await exec(args || {})
      return { error: 'unknown_op' }
    } catch (e) {
      if (e && (e.code === 'PROCESS_EXITED' || e.output)) {
        const o = e.output
        return {
          stdout: o.stdout.text(), stderr: o.stderr.text(),
          exit_code: o.exitCode | 0,
        }
      }
      // A dead sandbox (terminated kernel) shouldn't poison later execs.
      resetSandbox()
      return { error: String(e && e.message || e) }
    }
  })
}

// Bootstrap probes window.__HERMES_WASI__ for runner presence.
if (typeof window !== 'undefined') {
  window.__HERMES_WASI__ = { call }
}
