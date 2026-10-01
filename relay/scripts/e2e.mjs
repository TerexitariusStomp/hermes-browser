#!/usr/bin/env node
/**
 * gw-relay e2e — exercises the full rendezvous path against `wrangler dev`:
 *   mint session -> agent dials -> client ws pipe -> REST bridge ->
 *   auth rejections -> teardown.
 * The "agent" here is a stub ws that echoes RPC shapes; the real agent is
 * the browser page (bootstrap.js share module) speaking the same frames.
 *
 * Usage: node scripts/e2e.mjs [baseUrl]   (default http://localhost:8787)
 */
import { WebSocket } from 'ws'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import { serve as serveShim, enc, dec, importKey } from './e2e-shim.mjs'

const BASE = process.argv[2] || 'http://localhost:8787'
const WS_BASE = BASE.replace(/^http/, 'ws')

let passed = 0, failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok  ${name}`) }
  else { failed++; console.log(`  FAIL ${name} ${detail || ''}`) }
}

function wsOpen(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const to = setTimeout(() => reject(new Error('ws open timeout')), 8000)
    ws.on('open', () => { clearTimeout(to); resolve(ws) })
    ws.on('error', (e) => { clearTimeout(to); reject(e) })
  })
}
function nextMsg(ws) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('msg timeout')), 8000)
    ws.once('message', (d) => { clearTimeout(to); resolve(JSON.parse(d.toString())) })
  })
}

async function main() {
  console.log(`gw-relay e2e @ ${BASE}`)

  // 1. mint
  const mint = await fetch(`${BASE}/s`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:8787' }, body: '{}',
  })
  check('POST /s status', mint.status === 200, `got ${mint.status}`)
  const sess = await mint.json()
  check('mint returns tokens', !!(sess.sid && sess.agentToken && sess.clientToken))
  const bu = new URL(sess.baseUrl)
  const base = new URL(BASE)
  check('mint returns stock baseUrl',
    bu.protocol === base.protocol && bu.hostname === base.hostname &&
    bu.pathname === `/s/${sess.sid}`,
    `got ${sess.baseUrl}`)

  // 2. client rejected before agent connects
  const early = await fetch(`${BASE}/s/${sess.sid}/api/status`, { headers: { 'x-hermes-session-token': sess.clientToken } })
  check('REST before agent -> 503', early.status === 503, `got ${early.status}`)

  // bad token rejected
  const bad = await fetch(`${BASE}/s/${sess.sid}/api/status`, { headers: { 'x-hermes-session-token': 'wrong' } })
  check('bad client token -> 401', bad.status === 401, `got ${bad.status}`)

  // 3. agent dials out
  const agent = await wsOpen(`${WS_BASE}/s/${sess.sid}/agent?token=${sess.agentToken}`)
  check('agent ws connects', agent.readyState === 1)

  // 4. client ws -> agent sees ws-open; agent acks
  //    (listen BEFORE connecting — ws-open fires during the upgrade)
  const openPromise = nextMsg(agent)
  const client = await wsOpen(`${WS_BASE}/s/${sess.sid}/api/ws?token=${sess.clientToken}`)
  const openFrame = await openPromise
  check('agent got ws-open', openFrame.t === 'ws-open' && !!openFrame.cid)
  const cid = openFrame.cid
  // Agent acks the open first (page does this when its sidecar socket opens);
  // pre-ack client messages queue in the DO and flush on ws-opened.
  agent.send(JSON.stringify({ t: 'ws-opened', cid }))
  const fwdPromise = nextMsg(agent)
  client.send('{"jsonrpc":"2.0","id":1,"method":"gateway.ping","params":{}}')
  const fwd = await fwdPromise
  check('client msg -> ws-msg frame', fwd.t === 'ws-msg' && fwd.cid === cid && fwd.data.includes('gateway.ping'))
  // agent -> client
  agent.send(JSON.stringify({ t: 'ws-msg', cid, data: '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}' }))
  const clientMsg = await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('timeout')), 8000)
    client.once('message', (d) => { clearTimeout(to); res(d.toString()) })
  })
  check('agent msg reached client', clientMsg.includes('"ok":true'))

  // 5. REST bridge round-trip
  const restPromise = fetch(`${BASE}/s/${sess.sid}/api/config?include_defaults=false`, {
    headers: { 'x-hermes-session-token': sess.clientToken },
  })
  const restFrame = await nextMsg(agent)
  check('REST arrived as frame', restFrame.t === 'rest' && restFrame.method === 'GET' && restFrame.path.startsWith('/api/config'))
  check('client token stripped from headers', !JSON.stringify(restFrame.headers).includes(sess.clientToken))
  agent.send(JSON.stringify({ t: 'rest-res', id: restFrame.id, status: 200, headers: { 'content-type': 'application/json' }, bodyB64: btoa('{"ok":1}') }))
  const restResp = await restPromise
  check('REST round-trip 200', restResp.status === 200)
  check('REST body passthrough', (await restResp.text()) === '{"ok":1}')

  // 6. POST body bridge
  const postPromise = fetch(`${BASE}/s/${sess.sid}/api/test`, {
    method: 'POST', headers: { 'x-hermes-session-token': sess.clientToken, 'content-type': 'application/json' },
    body: '{"hello":"world"}',
  })
  const postFrame = await nextMsg(agent)
  check('POST body bridged', postFrame.t === 'rest' && atob(postFrame.bodyB64) === '{"hello":"world"}')
  agent.send(JSON.stringify({ t: 'rest-res', id: postFrame.id, status: 201, headers: {}, bodyB64: btoa('ok') }))
  check('POST round-trip', (await postPromise).status === 201)

  // 6b. pre-ack queue: a second client's message sent before ws-opened
  //     flushes on the ack.
  const open2Promise = nextMsg(agent)
  const client2 = await wsOpen(`${WS_BASE}/s/${sess.sid}/api/ws?token=${sess.clientToken}`)
  const open2 = await open2Promise
  client2.send('{"queued":true}')
  agent.send(JSON.stringify({ t: 'ws-opened', cid: open2.cid }))
  const flushed = await nextMsg(agent)
  check('pre-ack msg flushed on ws-opened', flushed.t === 'ws-msg' && flushed.cid === open2.cid && flushed.data === '{"queued":true}')
  client2.close()

  // 7. client close propagates (client2's close also lands — match by cid)
  const closes = []
  const collect = () => { agent.on('message', (d) => { try { closes.push(JSON.parse(d.toString())) } catch {} }) }
  collect()
  client.close()
  await new Promise((r) => setTimeout(r, 1500))
  check('client close -> ws-close frame', closes.some((f) => f.t === 'ws-close' && f.cid === cid))

  // 6c. E2E channel — stock client traffic rides ciphertext through the
  //     DO. A local shim exposes the stock surface on loopback; the fake
  //     agent here plays the browser's decrypt/dispatch/re-encrypt role.
  const e2eKeyRaw = crypto.randomBytes(32)
  const e2eKey = await importKey(e2eKeyRaw)
  const shareUrl = `${BASE}/s/${sess.sid}?token=${sess.clientToken}#k=${e2eKeyRaw.toString('base64url')}`
  const shim = await serveShim(shareUrl, '127.0.0.1:8790')

  // ws: stock client -> shim -> relay -> agent (ciphertext frames)
  const e2eOpenPromise = nextMsg(agent)
  const e2eClient = await wsOpen('ws://127.0.0.1:8790/api/ws')
  const e2eOpen = await e2eOpenPromise
  check('e2e ws-open forwarded with path', e2eOpen.t === 'ws-open' && e2eOpen.path === '/api/e2e-ws')
  const ecid = e2eOpen.cid
  agent.send(JSON.stringify({ t: 'ws-opened', cid: ecid }))
  const e2eFwdPromise = nextMsg(agent)
  e2eClient.send('{"jsonrpc":"2.0","id":7,"method":"gateway.ping","params":{}}')
  const e2eFwd = await e2eFwdPromise
  const e2eCt = Buffer.from(e2eFwd.data || '', 'base64')
  check('e2e ws-msg arrived ciphertext-only',
    e2eFwd.t === 'ws-msg' && e2eFwd.cid === ecid &&
    !e2eCt.includes(Buffer.from('gateway.ping')) && !e2eCt.includes(Buffer.from('jsonrpc')))
  const e2eInner = (await dec(e2eKey, e2eCt)).toString()
  check('agent decrypts e2e ws payload', e2eInner.includes('gateway.ping'))
  agent.send(JSON.stringify({
    t: 'ws-msg', cid: ecid,
    data: (await enc(e2eKey, '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}')).toString('base64'),
  }))
  const e2eClientMsg = await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('e2e client timeout')), 8000)
    e2eClient.once('message', (d) => { clearTimeout(to); res(d.toString()) })
  })
  check('e2e round-trip decrypts at client', e2eClientMsg.includes('"ok":true'))

  // REST: client -> shim -> POST /api/e2e (opaque) -> agent decrypts.
  // ws-close for the e2e client may interleave here — skip until 'rest'.
  const e2eRestPromise = fetch('http://127.0.0.1:8790/api/config?probe=1')
  let e2eRestFrame = null
  for (let i = 0; i < 5; i++) {
    const f = await nextMsg(agent)
    if (f.t === 'rest') { e2eRestFrame = f; break }
  }
  const e2eRestCt = Buffer.from(e2eRestFrame.bodyB64 || '', 'base64')
  check('e2e rest envelope is opaque to relay',
    e2eRestFrame.t === 'rest' && e2eRestFrame.path === '/api/e2e' &&
    e2eRestFrame.method === 'POST' && !e2eRestCt.includes(Buffer.from('/api/config')))
  const innerRest = JSON.parse((await dec(e2eKey, e2eRestCt)).toString())
  check('e2e rest inner request decrypts', innerRest.method === 'GET' && innerRest.path === '/api/config?probe=1')
  agent.send(JSON.stringify({
    t: 'rest-res', id: e2eRestFrame.id, status: 200,
    headers: { 'content-type': 'application/octet-stream' },
    bodyB64: (await enc(e2eKey, JSON.stringify({
      status: 200, headers: { 'content-type': 'application/json' }, bodyB64: btoa('{"ok":1}'),
    }))).toString('base64'),
  }))
  const e2eRestResp = await e2eRestPromise
  check('e2e rest round-trip', e2eRestResp.status === 200 && (await e2eRestResp.text()) === '{"ok":1}')
  e2eClient.readyState === 1 && e2eClient.close()
  shim.close()

  // 8. teardown
  const del = await fetch(`${BASE}/s/${sess.sid}?token=${sess.agentToken}`, { method: 'DELETE' })
  check('DELETE teardown', del.status === 200)
  const gone = await fetch(`${BASE}/s/${sess.sid}/api/status`, { headers: { 'x-hermes-session-token': sess.clientToken } })
  check('session gone after teardown', gone.status === 404, `got ${gone.status}`)

  // 9. wrong-scope token can't teardown
  const mint2 = await fetch(`${BASE}/s`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:8787' }, body: '{}' })
  const s2 = await mint2.json()
  const delBad = await fetch(`${BASE}/s/${s2.sid}?token=${s2.clientToken}`, { method: 'DELETE' })
  check('client token cannot teardown', delBad.status === 401)

  agent.close()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('e2e error:', e); process.exit(1) })
