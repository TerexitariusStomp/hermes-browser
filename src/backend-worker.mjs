/**
 * backend-worker.mjs — the real Hermes backend under Pyodide.
 *
 * Transport is coincident (MIT): synchronous worker→page proxy calls over
 * SharedArrayBuffer + Atomics. Python's pump parks inside
 * proxy.pullInbound(ms), which resolves when the page has buffered inbound
 * frames; outbound events are plain postMessage (fire-and-forget).
 * postMessage alone could never reach this worker while Python blocks —
 * coincident's sync channel carries both directions.
 */
import { loadPyodide } from './pyodide/pyodide.mjs'
import coincident from './vendor/coincident-worker.js'

const { proxy } = await coincident()

const bridge = {
  // Called from inside Python while it blocks on a primitive. The page
  // resolves pullInbound with the buffered inbound frames; an empty array
  // on timeout means "poll again" — same bounded-wait semantics as before.
  pump(ms) {
    // -1 = nothing scheduled: park until a frame arrives. Finite waits are
    // clamped to 500ms like the old bounded Atomics.wait.
    return proxy.pullInbound(ms < 0 ? -1 : Math.min(ms, 500))
  },
  emit(wsId, text) {
    self.postMessage({ type: 'ws-event', id: wsId, event: 'message', data: text })
  },
  wsAccepted(wsId) {
    self.postMessage({ type: 'ws-event', id: wsId, event: 'open' })
  },
  wsClosed(wsId, code, reason) {
    self.postMessage({ type: 'ws-event', id: wsId, event: 'close', code, reason })
  },
  restReply(id, status, headersJson, bodyB64) {
    // headersJson crosses the Python boundary as a string (PyProxy dicts
    // can't survive structured clone).
    self.postMessage({
      type: 'fetch-response', id, status,
      headers: JSON.parse(headersJson || '{}'),
      bodyB64,
    })
  },
  // Page-mediated request/response channels — all synchronous proxy calls.
  // headersJson/argsJson cross as strings; the page resolves the return
  // value and coincident hands it back here as the call result.
  fetchRequest(url, method, headersJson, bodyB64, grant) {
    return proxy.fetchRequest(
      url, method, headersJson, bodyB64, grant || null)
  },
  substrateRequest(op, argsJson) {
    // Extension substrate call — page relays a fixed-op request to the
    // Hermes substrate extension's content-script bridge (grant-gated there).
    return proxy.substrateRequest(op, argsJson)
  },
  wasiRequest(op, argsJson) {
    // In-page WASI runner — no extension involvement.
    return proxy.wasiRequest(op, argsJson)
  },
  pwaRequest(op, argsJson) {
    // In-page browser-grant ops — pwa-bridge.js executes them against the
    // page's own APIs.
    return proxy.pwaRequest(op, argsJson)
  },
  hostRequest(op, argsJson) {
    // Opt-in local host substrate (companion host-agent.py on 127.0.0.1).
    return proxy.hostRequest(op, argsJson)
  },
  nearRequest(op, argsJson, grant) {
    // In-page NEAR substrate — near-bridge.js composes the vendored SDKs
    // (near-api-js, @fastnear/x402, @fastnear/intents) behind the vault's
    // grant-scoped signer and the spending-policy engine.
    return proxy.nearRequest(op, argsJson, grant || null)
  },
  persistFile(path, b64) {
    // ~/.hermes config mirror — page writes it to localStorage so settings
    // survive reloads on hosts without OPFS.
    return proxy.persistFile(path, b64)
  },
  log(level, msg) { console.log('[py]', msg) },
}

self.onmessage = async (ev) => {
  const msg = ev.data
  if (msg.type !== 'boot') return
  try {
    await main(msg)
  } catch (e) {
    self.postMessage({ type: 'boot-failed', error: String(e && e.message || e) })
    throw e
  }
}

async function main(msg) {
  const pyodide = await loadPyodide({ indexURL: msg.pyodideUrl })
  // Debug aid: page can write 2 to interruptSab[0] to SIGINT a wedged boot.
  if (msg.interruptSab) pyodide.setInterruptBuffer(new Uint8Array(msg.interruptSab))
  self.globalThis.hermesBridge = bridge
  pyodide.setStdout({ batched: (s) => self.postMessage({ type: 'log', stream: 'out', text: s }) })
  pyodide.setStderr({ batched: (s) => self.postMessage({ type: 'log', stream: 'err', text: s }) })
  pyodide.setStdin({ stdin: () => null })

  // Pyodide stdlib packages shipped with the distribution.
  await pyodide.loadPackage(['sqlite3', 'ssl'])

  // Preinstalled site-packages env (built by scripts/pack-env.mjs at
  // build time — no runtime PyPI dependency).
  const envZip = await (await fetch(msg.envZipUrl)).arrayBuffer()
  pyodide.FS.mkdirTree('/hermes-env')
  pyodide.unpackArchive(new Uint8Array(envZip), 'zip', { extractDir: '/hermes-env' })

  // Unpack the vendored upstream python tree.
  const zip = await (await fetch(msg.pyZipUrl)).arrayBuffer()
  pyodide.FS.mkdirTree('/hermes-py')
  pyodide.unpackArchive(new Uint8Array(zip), 'zip', { extractDir: '/hermes-py' })

  // Our python overlay modules (manifest-driven so assemble.mjs stays the
  // single source of file names).
  const overlay = await (await fetch(msg.overlayManifestUrl)).json()
  for (const f of overlay) {
    const bytes = await (await fetch(f.url)).arrayBuffer()
    const target = `/hermes-py/${f.name}`
    const parent = target.slice(0, target.lastIndexOf('/'))
    pyodide.FS.mkdirTree(parent)
    pyodide.FS.writeFile(target, new Uint8Array(bytes))
  }

  // Optional OPFS persistence for ~/.hermes (cross-origin isolated only).
  let homePersist = 'memfs'
  if (msg.persistHome && pyodide.mountNativeFS) {
    try {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('hermes', { create: true })
      pyodide.FS.mkdirTree('/hermes-home')
      await pyodide.mountNativeFS('/hermes-home', dir)
      homePersist = 'opfs'
    } catch (e) {
      self.postMessage({ type: 'log', stream: 'err', text: `opfs mount failed: ${e.message}` })
    }
  }
  // No OPFS (old Chrome/Safari, non-isolated contexts): MEMFS is ephemeral,
  // so seed it from the page's localStorage mirror — py_gateway mirrors
  // every small config write back out through the same channel.
  if (msg.persistHome && homePersist !== 'opfs' && Array.isArray(msg.homeFiles)) {
    for (const f of msg.homeFiles) {
      try {
        const rel = String(f && f.path || '')
        if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) continue
        const target = `/hermes-home/${rel}`
        const parent = target.slice(0, target.lastIndexOf('/'))
        pyodide.FS.mkdirTree(parent)
        const bin = atob(f.b64 || '')
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        pyodide.FS.writeFile(target, bytes)
      } catch (e) {
        self.postMessage({ type: 'log', stream: 'err', text: `home mirror restore failed: ${e.message}` })
      }
    }
  }

  await pyodide.runPythonAsync(`
import sys, os
# hermes-env last: the zip contains pure-python stdlib shims (ssl.py etc.)
# captured from site-packages; they must NOT shadow the wasm stdlib.
sys.path.append('/hermes-env')
sys.path.insert(0, '/hermes-py')
${msg.extraConfigJson ? `os.environ['HERMES_EXTRA_CONFIG_JSON'] = ${JSON.stringify(String(msg.extraConfigJson))}` : ''}
${(msg.env && typeof msg.env === 'object') ? Object.entries(msg.env).map(([k, v]) => `os.environ[${JSON.stringify(String(k))}] = ${JSON.stringify(String(v))}`).join('\n') : ''}
import py_gateway
py_gateway.boot(${JSON.stringify(String(msg.sessionToken || ''))}, ${JSON.stringify(String(msg.publicHost || ''))}, ${msg.persistHome && homePersist !== 'opfs' ? 'True' : 'False'})
`)

  const gw = pyodide.pyimport('py_gateway')
  const runtime = pyodide.pyimport('browser_runtime')
  self.postMessage({ type: 'boot-ready' })

  // Main loop: park in pullInbound until the page hands over frames, route
  // each into Python, then drain Python-side work (loop tasks, thread
  // reschedules) to quiescence. Python calls that block (approvals, vault
  // fetches) are synchronous proxy calls that park the same way.
  while (true) {
    const frames = bridge.pump(-1)
    for (const raw of frames) {
      try { gw.handle(raw) } catch (e) {
        self.postMessage({ type: 'log', stream: 'err', text: `handle: ${e.message}` })
      }
    }
    try {
      let pending = runtime.pump_once(0)
      let guard = 0
      while (pending > 0 && guard++ < 1000) pending = runtime.pump_once(0)
    } catch (e) {
      self.postMessage({ type: 'log', stream: 'err', text: `pump: ${e.message}` })
    }
  }
}
