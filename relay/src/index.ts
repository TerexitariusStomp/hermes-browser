/**
 * hermes-relay — rendezvous Worker for browser-hosted Hermes gateways.
 *
 * The browser tab runs the whole agent client-side (Pyodide). This worker
 * exists only so a REMOTE client (Hermes Desktop pointed at a remote
 * gateway URL, curl, another browser) can reach that tab:
 *
 *   POST /s                       -> {sid, agentToken, clientToken, baseUrl}
 *   GET  /s/:sid/agent?token=…    -> agent outbound ws dial (one per session)
 *   GET  /s/:sid/api/ws?token=…   -> stock client ws  (clientToken)
 *   GET  /s/:sid/api/e2e-ws?token=… -> ciphertext-channel client ws (same
 *                                   token gate; payloads are AES-GCM opaque)
 *   ANY  /s/:sid/api/*            -> stock client REST (X-Hermes-Session-Token
 *                                  or Bearer or ?token=, bridged to the agent)
 *   GET  /s/:sid                  -> status (agent token)
 *   DELETE /s/:sid?token=…        -> teardown (agent token)
 *
 * A Desktop remote-gateway entry is therefore just:
 *   baseUrl = https://<relay-host>/s/<sid>   token = <clientToken>
 *
 * Nothing is stored in this worker — no KV, no logs (observability off).
 * Session state lives in the per-session DO: sha256 token hashes only.
 */
import { HermesSessionDO } from './session-do'

export interface Env {
  GW_SESSIONS: DurableObjectNamespace
  SHARE_ORIGINS?: string
}

const te = new TextEncoder()
const SID_RE = /^[0-9a-f-]{36}$/
const TOKEN_LEN = 43 // 32 random bytes, base64url

async function sha256Hex(data: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', te.encode(data))
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode.apply(null, Array.from(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function json(status: number, body: unknown, corsOrigin?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (corsOrigin) headers['access-control-allow-origin'] = corsOrigin
  return new Response(JSON.stringify(body), { status, headers })
}

// --- Per-isolate rate limiter for the unauthenticated mint -----------------
// Coarse best-effort (per-isolate, resets on evictions). Session creation is
// cheap and per-session limits inside the DO cap actual damage.
const rl = new Map<string, { n: number; reset: number }>()
function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  let e = rl.get(key)
  if (!e || e.reset < now) {
    e = { n: 0, reset: now + windowMs }
    rl.set(key, e)
    if (rl.size > 10000) rl.clear()
  }
  e.n++
  return e.n <= max
}

function shareOriginAllowed(origin: string | null, env: Env): string | null {
  const allowed = (env.SHARE_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!allowed.length) return null
  if (origin && allowed.includes(origin)) return origin
  return null
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const origin = request.headers.get('origin')

    // CORS preflight. Minting is origin-restricted; the token-gated client
    // surface answers any origin (the token is the capability; no cookies).
    if (request.method === 'OPTIONS') {
      const allow = url.pathname === '/s'
        ? shareOriginAllowed(origin, env) || 'null'
        : '*'
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': allow,
          'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
          'access-control-allow-headers': 'content-type,authorization,x-hermes-session-token',
          'access-control-max-age': '86400',
        },
      })
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return json(200, { service: 'gw-relay', ok: true })
    }

    // POST /s — mint a rendezvous session. Origin-restricted + rate-limited.
    if (url.pathname === '/s' && request.method === 'POST') {
      const allowOrigin = shareOriginAllowed(origin, env)
      if (!allowOrigin) return json(403, { error: 'origin_not_allowed' })
      const ip = request.headers.get('cf-connecting-ip') || 'unknown'
      if (!rateLimit(`mint:${ip}`, 30, 3600_000) || !rateLimit('mint:global', 2000, 3600_000)) {
        return json(429, { error: 'rate_limited' }, allowOrigin)
      }
      const body = (await request.json().catch(() => ({}))) as { scopes?: string[] }
      const sid = crypto.randomUUID()
      const agentToken = randomToken()
      const clientToken = randomToken()
      const stub = env.GW_SESSIONS.get(env.GW_SESSIONS.idFromName(sid))
      const init = await stub.fetch('https://gw-session/__init', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-gw-internal': '1' },
        body: JSON.stringify({
          agentHash: await sha256Hex(agentToken),
          clientHash: await sha256Hex(clientToken),
          scopes: Array.isArray(body.scopes) ? body.scopes.slice(0, 32).map(String) : [],
          createdAt: Date.now(),
          expiresAt: Date.now() + 24 * 3600 * 1000,
        }),
      })
      if (!init.ok) return json(502, { error: 'session_init_failed' }, allowOrigin)
      return json(
        200,
        {
          sid,
          agentToken,
          clientToken,
          // The stock remote-gateway entry: Desktop takes these verbatim.
          baseUrl: `${url.protocol}//${request.headers.get('host')}/s/${sid}`,
          token: clientToken,
          expiresIn: 24 * 3600,
        },
        allowOrigin,
      )
    }

    // /s/:sid/... — agent dial, client ws, REST bridge, status, teardown.
    const m = url.pathname.match(/^\/s\/([0-9a-f-]{36})(\/.*)?$/)
    if (m && SID_RE.test(m[1]!)) {
      const sid = m[1]!
      const rest = m[2] || '/'
      const stub = env.GW_SESSIONS.get(env.GW_SESSIONS.idFromName(sid))

      if (rest === '/' || rest === '') {
        if (request.method === 'GET') {
          return stub.fetch(`https://gw-session/status?token=${encodeURIComponent(url.searchParams.get('token') || '')}`)
        }
        if (request.method === 'DELETE') {
          return stub.fetch(`https://gw-session/teardown?token=${encodeURIComponent(url.searchParams.get('token') || '')}`, { method: 'POST' })
        }
        return json(405, { error: 'method_not_allowed' })
      }

      // ws upgrades (agent + client) and REST bridge: forward to the DO with
      // the /s/:sid prefix stripped so the DO sees the stock paths.
      return stub.fetch(new Request(`https://gw-session${rest}${url.search}`, request))
    }

    return json(404, { error: 'not_found' })
  },
}

export { HermesSessionDO }

// Keep TOKEN_LEN referenced (documents the token shape invariant).
void TOKEN_LEN
