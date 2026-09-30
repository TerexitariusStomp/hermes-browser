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
  check('mint returns stock baseUrl', sess.baseUrl === `${BASE}/s/${sess.sid}`)

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
