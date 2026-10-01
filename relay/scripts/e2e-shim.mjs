#!/usr/bin/env node
/**
 * e2e-shim.mjs — localhost stock-gateway front for an encrypted share.
 *
 * A stock Hermes client (Desktop → Settings → Gateway, curl, etc.) points
 * at this shim's loopback surface exactly as it would at the relay — the
 * shim encrypts every payload with the share's AES-GCM key and forwards
 * ciphertext through the relay, which routes it blind. Plaintext exists
 * only on this machine and inside the owner's browser tab.
 *
 * Usage:
 *   node e2e-shim.mjs '<shareUrl>' [--listen 127.0.0.1:8790]
 *
 * shareUrl comes from the host's Share panel ("e2e shareUrl") and looks
 * like  https://<relay>/s/<sid>?token=<clientToken>#k=<base64url-key>
 * The #k fragment never transits the relay — it is the whole point.
 *
 * Then point the client at  baseUrl = http://127.0.0.1:8790  with any
 * token value (loopback is the trust boundary; the real client token
 * stays inside the envelope key + relay auth).
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : null
}

export function parseShareUrl(shareUrl) {
  const u = new URL(shareUrl)
  const frag = new URLSearchParams(u.hash.replace(/^#/, ''))
  const k = frag.get('k')
  if (!k) throw new Error('share URL has no #k= key fragment')
  const raw = Buffer.from(k.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  if (raw.length !== 32) throw new Error('bad key length')
  const base = `${u.protocol}//${u.host}${u.pathname}` // .../s/<sid>
  return { base, token: u.searchParams.get('token') || '', rawKey: raw }
}

export async function importKey(rawKey) {
  return crypto.webcrypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function enc(key, text) {
  const iv = crypto.randomBytes(12)
  const ct = await crypto.webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(text))
  return Buffer.concat([iv, Buffer.from(ct)])
}

export async function dec(key, buf) {
  const pt = await crypto.webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: buf.subarray(0, 12) }, key, buf.subarray(12))
  return Buffer.from(pt)
}

export function serve(shareUrl, listen) {
  const { base, token, rawKey } = parseShareUrl(shareUrl)
  const keyP = importKey(rawKey)
  const [host, portStr] = listen.split(':')
  const port = Number(portStr || 8790)

  const wss = new WebSocketServer({ noServer: true })

  const server = http.createServer((req, res) => {
    // Stock REST surface -> encrypted /api/e2e envelope.
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      try {
        const key = await keyP
        const headers = {}
        for (const [k, v] of Object.entries(req.headers)) {
          const lk = k.toLowerCase()
          if (lk === 'host' || lk === 'connection' || lk === 'content-length' ||
              lk === 'authorization' || lk === 'x-hermes-session-token') continue
          headers[lk] = Array.isArray(v) ? v.join(', ') : v
        }
        const bodyB64 = chunks.length
          ? Buffer.concat(chunks).toString('base64') : undefined
        const ct = await enc(key, JSON.stringify({
          method: req.method, path: req.url, headers, bodyB64,
        }))
        const resp = await fetch(`${base}/api/e2e`, {
          method: 'POST',
          headers: {
            'x-hermes-session-token': token,
            'content-type': 'application/octet-stream',
          },
          body: ct,
        })
        const pt = JSON.parse((await dec(key, Buffer.from(await resp.arrayBuffer()))).toString())
        res.writeHead(pt.status || 502, pt.headers || {})
        res.end(pt.bodyB64 ? Buffer.from(pt.bodyB64, 'base64') : '')
      } catch (e) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'shim_upstream_failed', detail: String(e).slice(0, 200) }))
      }
    })
  })

  // Stock ws surface (/api/ws) -> encrypted /api/e2e-ws channel.
  server.on('upgrade', (req, sock, head) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname !== '/api/ws') { sock.destroy(); return }
    wss.handleUpgrade(req, sock, head, async (client) => {
      try {
        const key = await keyP
        const upstream = new WebSocket(
          `${base.replace(/^http/, 'ws')}/api/e2e-ws?token=${encodeURIComponent(token)}`)
        // Queue client frames until the upstream channel opens — a stock
        // client may send immediately after its local upgrade completes.
        const pending = []
        let upstreamOpen = false
        const pump = async () => {
          while (pending.length && upstreamOpen) {
            const data = pending.shift()
            try { upstream.send((await enc(key, data.toString())).toString('base64')) }
            catch (e) { console.error('[e2e-shim] send failed:', e); return }
          }
        }
        client.on('message', (data) => { pending.push(data); pump() })
        upstream.on('open', () => { upstreamOpen = true; pump() })
        upstream.on('message', async (data) => {
          try {
            const pt = await dec(key, Buffer.from(data.toString(), 'base64'))
            client.send(pt.toString())
          } catch { /* undecryptable frame — drop */ }
        })
        upstream.on('close', (code, reason) => { console.error('[e2e-shim] upstream close', code); client.close(code, reason) })
        upstream.on('error', (e) => { console.error('[e2e-shim] upstream error:', e.message); client.close(1011, 'upstream error') })
        client.on('close', () => { try { upstream.close() } catch { /* gone */ } })
      } catch (e) {
        client.close(1011, String(e).slice(0, 120))
      }
    })
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, host, () => {
      console.log(`[e2e-shim] stock gateway on http://${host}:${port}`)
      console.log(`[e2e-shim] relay sees ciphertext only — share ${base}`)
      resolve(server)
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const shareUrl = process.argv[2]
  const listen = arg('--listen') || '127.0.0.1:8790'
  if (!shareUrl) {
    console.error('usage: e2e-shim.mjs <shareUrl> [--listen 127.0.0.1:8790]')
    process.exit(2)
  }
  serve(shareUrl, listen).catch((e) => { console.error(e); process.exit(1) })
}
