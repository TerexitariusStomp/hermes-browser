/**
 * host-bridge.js — page-side bridge to the user's local host agent.
 *
 * The `local_host` terminal substrate (opt-in, plan P6/T3) talks to a
 * companion `host-agent.py` the user runs on their own machine. All calls
 * go through fixed ops — `status`, `exec`, `pair`, `unpair` — never
 * arbitrary requests. The pairing token lives in the vault worker; this
 * module resolves the `vault:<handle>` placeholder into the
 * `X-Host-Token` header at fetch time, same as provider secrets.
 */
const DEFAULT_BASE = 'http://127.0.0.1:8788'

function base(args) {
  return String(args && args.base || DEFAULT_BASE).replace(/\/+$/, '')
}

async function authedFetch(ctx, args, path, init) {
  const headers = { 'X-Host-Token': 'vault:' + (args.handle || '') }
  if (init && init.body) headers['Content-Type'] = 'application/json'
  const resolved = await ctx.resolveHeaders(headers)
  const resp = await fetch(base(args) + path, { ...init, headers: resolved })
  const text = await resp.text()
  let body
  try { body = JSON.parse(text) } catch (e) { body = { raw: text.slice(0, 2000) } }
  if (!resp.ok) return { error: `host ${resp.status}: ${(body && body.error) || text.slice(0, 200)}` }
  return body
}

const ops = {
  // Bridge liveness only — no vault, no network. The toolset's check_fn.
  ping: () => ({ ok: true }),

  status: (ctx, args) => authedFetch(ctx, args, '/status', { method: 'GET' }),

  exec: (ctx, args) => authedFetch(ctx, args, '/exec', {
    method: 'POST',
    body: JSON.stringify({
      command: args.command, cwd: args.cwd, env: args.env,
      stdin: args.stdin, timeout_s: args.timeout_s,
    }),
  }),

  // Pair: prompt for the host-agent token, vault it in vault under a
  // stable handle, then verify. The token crosses the page UI only — never
  // the Pyodide heap.
  pair: async (ctx, args) => {
    const token = window.prompt(
      'Hermes local host pairing\n\n' +
      'Run `python3 host-agent.py` on the machine the agent should drive,\n' +
      'then paste the token it printed here.')
    if (!token) return { error: 'pairing cancelled' }
    const r = await ctx.vaultCall('storeSecret', { value: token.trim(), label: 'local-host-token' })
    if (!r || !r.handle) return { error: 'vault store failed' }
    const probe = await ops.status(ctx, { ...args, handle: r.handle })
    if (probe.error) {
      await ctx.vaultCall('revoke', { handle: r.handle })
      return { error: `paired but status failed: ${probe.error}`, handle: r.handle }
    }
    return { ok: true, handle: r.handle, status: probe }
  },

  unpair: async (ctx, args) => {
    if (args.handle) await ctx.vaultCall('revoke', { handle: args.handle })
    return { ok: true }
  },
}

export async function handle(op, args, ctx) {
  const fn = ops[op]
  if (!fn) return { error: 'unknown host op: ' + op }
  try {
    return await fn(ctx, args || {})
  } catch (e) {
    const msg = String(e && e.message || e)
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
      return { error: 'host unreachable — is host-agent.py running on this machine?' }
    }
    return { error: msg.slice(0, 300) }
  }
}
