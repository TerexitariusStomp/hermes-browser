/**
 * HermesSessionDO — rendezvous for one browser-hosted Hermes gateway session.
 *
 * Topology: the browser tab (the "agent") dials OUT to this object; remote
 * clients (Hermes Desktop, curl) connect IN. The DO pipes client ws frames
 * to the agent and bridges REST calls over the agent socket.
 *
 * PRIVACY / CLIENT-SIDE BOUNDARY
 * - RPC payloads transit this isolate's memory only. They are NEVER written
 *   to state.storage, KV, or logs. The only persisted fields are sha256
 *   token hashes, scope labels, and timestamps — the minimum needed to
 *   authenticate reconnects across isolate hibernation.
 * - Secrets never leave the page: vault handles (`vault:<handle>`) are
 *   opaque strings here; resolution happens in the browser's vault worker.
 * - A fully compromised relay can drop or corrupt frames, but cannot mint
 *   sessions (tokens are per-session random, only hashes are stored), cannot
 *   recover secrets, and cannot impersonate the agent (agent token hash).
 *
 * Frame protocol (JSON text on the agent socket):
 *   DO -> agent:  {t:'ws-open',cid,path} {t:'ws-msg',cid,data}
 *                 {t:'ws-close',cid,code?,reason?}
 *                 {t:'rest',id,method,path,headers,bodyB64?}
 *                 {t:'end',reason}
 *   agent -> DO:  {t:'ws-opened',cid} {t:'ws-msg',cid,data}
 *                 {t:'ws-close',cid} {t:'rest-res',id,status,headers,bodyB64?}
 *
 * Connection plumbing (accept, tags, state, close/error dispatch) is
 * partyserver's Server; auth gating, the REST bridge, and the frame
 * protocol above are the session's own contract.
 */
import { Server, type Connection, type ConnectionContext, type WSMessage } from 'partyserver'

export interface SessionInit {
  agentHash: string
  clientHash: string
  scopes: string[]
  createdAt: number
  expiresAt: number
}

interface PendingRest {
  resolve: (r: { status: number; headers: Record<string, string>; bodyB64?: string }) => void
  timer: ReturnType<typeof setTimeout>
}

interface ConnState {
  role: 'agent' | 'client'
}

interface Env {
  GW_SESSIONS: DurableObjectNamespace
}

const MAX_CLIENTS = 16
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_PENDING_REST = 64
const MAX_QUEUED_PER_CLIENT = 64
const REST_TIMEOUT_MS = 60_000
const INTERNAL_HEADER = 'x-gw-internal'

const te = new TextEncoder()

async function sha256Hex(data: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', te.encode(data))
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function b64encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return btoa(s)
}

function b64decode(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export class HermesSessionDO extends Server<Env> {
  private pendingRest = new Map<string, PendingRest>()
  // cid -> client messages received before the agent acked ws-open.
  private openQueue = new Map<string, string[]>()
  private init: SessionInit | null = null

  private async getInit(): Promise<SessionInit | null> {
    if (!this.init) this.init = (await this.ctx.storage.get<SessionInit>('init')) ?? null
    return this.init
  }

  private agentConn(): Connection<ConnState> | null {
    for (const c of this.getConnections<ConnState>('agent')) return c
    return null
  }

  private clientConn(cid: string): Connection<ConnState> | null {
    const c = this.getConnection<ConnState>(cid)
    return c && c.state?.role === 'client' ? c : null
  }

  private sendToAgent(obj: unknown): boolean {
    const conn = this.agentConn()
    if (!conn) return false
    try {
      conn.send(JSON.stringify(obj))
      return true
    } catch {
      return false
    }
  }

  private async hashOk(token: string, which: 'agentHash' | 'clientHash'): Promise<boolean> {
    if (!this.init) return false
    return (await sha256Hex(token)) === this.init[which]
  }

  /**
   * Auth gate for ws upgrades, preserving the HTTP contract (401/503/429
   * before the 101 switch). Partyserver's Server.fetch owns accept/tagging;
   * non-upgrade requests fall through to onRequest.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return super.fetch(request)
    }
    const url = new URL(request.url)
    const path = url.pathname
    const init = await this.getInit()
    if (!init) return json(404, { error: 'unknown_session' })
    if (Date.now() > init.expiresAt) {
      this.teardown('expired')
      return json(410, { error: 'session_expired' })
    }

    // Agent outbound dial: GET /agent?token=<agentToken> (ws upgrade)
    if (path === '/agent') {
      const token = url.searchParams.get('token') || ''
      if (!(await this.hashOk(token, 'agentHash'))) return json(401, { error: 'bad_token' })
      // A second agent dial replaces the first (tab reload).
      const old = this.agentConn()
      if (old) {
        try { old.close(1000, 'replaced') } catch { /* already gone */ }
        this.failAllClients('agent-replaced')
      }
      return super.fetch(request)
    }

    // Stock client ws: GET /api/ws?token=<clientToken>
    if (path === '/api/ws') {
      const token = url.searchParams.get('token') || ''
      if (!(await this.hashOk(token, 'clientHash'))) return json(401, { error: 'bad_token' })
      if (!this.agentConn()) return json(503, { error: 'agent_not_connected' })
      if ([...this.getConnections('client')].length >= MAX_CLIENTS) {
        return json(429, { error: 'too_many_clients' })
      }
      return super.fetch(request)
    }

    return json(404, { error: 'not_found' })
  }

  /** Tag + role-stamp each accepted socket from the upgrade path. */
  getConnectionTags(connection: Connection<ConnState>, ctx: ConnectionContext): string[] {
    const role = new URL(ctx.request.url).pathname === '/agent' ? 'agent' : 'client'
    connection.setState({ role })
    return [role]
  }

  onConnect(connection: Connection<ConnState>): void {
    if (connection.state?.role !== 'client') return
    // Messages arriving before the agent acks (ws-opened) queue here.
    this.openQueue.set(connection.id, [])
    this.sendToAgent({ t: 'ws-open', cid: connection.id, path: '/api/ws' })
  }

  /** Non-upgrade surface: init, status, teardown, and the REST bridge. */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    // Internal: initialize a fresh session (called by the worker on POST /s).
    if (path === '/__init' && request.method === 'POST') {
      if (request.headers.get(INTERNAL_HEADER) !== '1') return json(403, { error: 'forbidden' })
      const body = (await request.json().catch(() => null)) as SessionInit | null
      if (!body?.agentHash || !body?.clientHash) return json(400, { error: 'invalid_init' })
      if (await this.getInit()) return json(409, { error: 'already_initialized' })
      this.init = {
        agentHash: body.agentHash,
        clientHash: body.clientHash,
        scopes: Array.isArray(body.scopes) ? body.scopes.slice(0, 32) : [],
        createdAt: body.createdAt || Date.now(),
        expiresAt: body.expiresAt || Date.now() + 24 * 3600 * 1000,
      }
      await this.ctx.storage.put('init', this.init)
      await this.ctx.storage.setAlarm(this.init.expiresAt)
      return json(200, { ok: true })
    }

    const init = await this.getInit()
    if (!init) return json(404, { error: 'unknown_session' })
    if (Date.now() > init.expiresAt) {
      this.teardown('expired')
      return json(410, { error: 'session_expired' })
    }

    if (path === '/status' && request.method === 'GET') {
      const token = url.searchParams.get('token') || ''
      if (!(await this.hashOk(token, 'agentHash'))) return json(401, { error: 'bad_token' })
      return json(200, {
        agentConnected: !!this.agentConn(),
        clients: [...this.getConnections('client')].length,
        expiresAt: init.expiresAt,
      })
    }

    if (path === '/teardown' && request.method === 'POST') {
      const token = url.searchParams.get('token') || ''
      if (!(await this.hashOk(token, 'agentHash'))) return json(401, { error: 'bad_token' })
      this.teardown('ended')
      return json(200, { ok: true })
    }

    // Stock client REST bridge: ANY /api/* with the client token.
    if (path.startsWith('/api/')) {
      const token =
        request.headers.get('x-hermes-session-token') ||
        (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
        url.searchParams.get('token') ||
        ''
      if (!(await this.hashOk(token, 'clientHash'))) return json(401, { error: 'bad_token' })
      if (!this.agentConn()) return json(503, { error: 'agent_not_connected' })
      if (this.pendingRest.size >= MAX_PENDING_REST) return json(429, { error: 'too_many_pending' })

      const len = Number(request.headers.get('content-length') || 0)
      if (len > MAX_BODY_BYTES) return json(413, { error: 'body_too_large' })
      let bodyB64: string | undefined
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const buf = await request.arrayBuffer()
        if (buf.byteLength > MAX_BODY_BYTES) return json(413, { error: 'body_too_large' })
        if (buf.byteLength) bodyB64 = b64encode(buf)
      }

      // Strip hop-by-hop + auth headers; the page re-injects local auth.
      const headers: Record<string, string> = {}
      request.headers.forEach((v, k) => {
        const lk = k.toLowerCase()
        if (
          lk === 'connection' || lk === 'keep-alive' || lk === 'upgrade' ||
          lk === 'transfer-encoding' || lk === 'host' || lk === 'authorization' ||
          lk === 'x-hermes-session-token' || lk === INTERNAL_HEADER
        ) return
        headers[lk] = v
      })

      const id = crypto.randomUUID()
      const result = await new Promise<{ status: number; headers: Record<string, string>; bodyB64?: string }>(
        (resolve) => {
          const timer = setTimeout(() => {
            this.pendingRest.delete(id)
            resolve({ status: 504, headers: {}, bodyB64: b64encode(te.encode(JSON.stringify({ error: 'agent_timeout' })).buffer as ArrayBuffer) })
          }, REST_TIMEOUT_MS)
          this.pendingRest.set(id, { resolve, timer })
          const ok = this.sendToAgent({ t: 'rest', id, method: request.method, path: path + url.search, headers, bodyB64 })
          if (!ok) {
            clearTimeout(timer)
            this.pendingRest.delete(id)
            resolve({ status: 503, headers: {}, bodyB64: b64encode(te.encode(JSON.stringify({ error: 'agent_not_connected' })).buffer as ArrayBuffer) })
          }
        },
      )

      const respHeaders = new Headers()
      for (const [k, v] of Object.entries(result.headers || {})) {
        const lk = k.toLowerCase()
        if (lk === 'content-length' || lk === 'transfer-encoding' || lk === 'connection' || lk === 'keep-alive') continue
        try { respHeaders.set(k, v) } catch { /* skip malformed */ }
      }
      const body = result.bodyB64 ? b64decode(result.bodyB64) : null
      return new Response(body, { status: result.status, headers: respHeaders })
    }

    return json(404, { error: 'not_found' })
  }

  async onMessage(conn: Connection<ConnState>, message: WSMessage): Promise<void> {
    const role = conn.state?.role
    if (!role) return

    if (role === 'agent') {
      let m: any
      try {
        m = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message as ArrayBuffer))
      } catch {
        return
      }
      if (m.t === 'ws-opened' && typeof m.cid === 'string') {
        const queued = this.openQueue.get(m.cid)
        this.openQueue.delete(m.cid)
        const client = this.clientConn(m.cid)
        if (client && queued) {
          for (const data of queued) {
            if (!this.sendToAgent({ t: 'ws-msg', cid: m.cid, data })) break
          }
        }
      } else if (m.t === 'ws-msg' && typeof m.cid === 'string') {
        const client = this.clientConn(m.cid)
        if (client) {
          try { client.send(m.data) } catch { /* client gone */ }
        } else {
          // Client vanished — tell the agent so its sidecar socket closes.
          this.sendToAgent({ t: 'ws-close', cid: m.cid, code: 1001, reason: 'client-gone' })
        }
      } else if (m.t === 'ws-close' && typeof m.cid === 'string') {
        const client = this.clientConn(m.cid)
        if (client) {
          try { client.close(m.code || 1000, String(m.reason || '')) } catch { /* gone */ }
        }
      } else if (m.t === 'rest-res' && typeof m.id === 'string') {
        const p = this.pendingRest.get(m.id)
        if (p) {
          this.pendingRest.delete(m.id)
          clearTimeout(p.timer)
          p.resolve({ status: m.status || 200, headers: m.headers || {}, bodyB64: m.bodyB64 })
        }
      }
      return
    }

    // Client socket -> forward payload to the agent.
    if (role === 'client') {
      const cid = conn.id
      const data = typeof message === 'string' ? message : new TextDecoder().decode(message as ArrayBuffer)
      // Agent hasn't acked the open yet — queue briefly.
      if (this.openQueue.has(cid)) {
        const q = this.openQueue.get(cid)!
        if (q.length < MAX_QUEUED_PER_CLIENT) q.push(data)
        return
      }
      if (!this.sendToAgent({ t: 'ws-msg', cid, data })) {
        try { conn.close(1013, 'agent-gone') } catch { /* gone */ }
      }
    }
  }

  async onClose(conn: Connection<ConnState>, code: number, reason: string): Promise<void> {
    if (conn.state?.role === 'client') {
      this.openQueue.delete(conn.id)
      this.sendToAgent({ t: 'ws-close', cid: conn.id, code, reason })
    } else if (conn.state?.role === 'agent') {
      // Agent left: every client stream is dead — close them so clients
      // reconnect (and re-open) against a future agent socket.
      this.failAllClients('agent-disconnected')
      for (const [, p] of this.pendingRest) {
        clearTimeout(p.timer)
        p.resolve({ status: 503, headers: {}, bodyB64: b64encode(te.encode(JSON.stringify({ error: 'agent_disconnected' })).buffer as ArrayBuffer) })
      }
      this.pendingRest.clear()
    }
  }

  async onError(conn: Connection<ConnState>): Promise<void> {
    if (conn.state?.role === 'client') {
      this.sendToAgent({ t: 'ws-close', cid: conn.id, code: 1011, reason: 'client-error' })
    }
  }

  async onAlarm(): Promise<void> {
    if (this.init && Date.now() > this.init.expiresAt) {
      this.teardown('expired')
    }
  }

  private failAllClients(reason: string): void {
    for (const conn of this.getConnections('client')) {
      try { conn.close(1012, reason) } catch { /* gone */ }
    }
    this.openQueue.clear()
  }

  private teardown(reason: string): void {
    this.sendToAgent({ t: 'end', reason })
    for (const conn of this.getConnections()) {
      try { conn.close(1000, reason) } catch { /* gone */ }
    }
    this.failAllClients(reason)
    for (const [, p] of this.pendingRest) {
      clearTimeout(p.timer)
      p.resolve({ status: 410, headers: {}, bodyB64: b64encode(te.encode(JSON.stringify({ error: 'session_ended' })).buffer as ArrayBuffer) })
    }
    this.pendingRest.clear()
    this.init = null
    void this.ctx.storage.deleteAll()
  }
}
