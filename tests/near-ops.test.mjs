/**
 * NEAR vault ops — key custody, grant-scoped signing, policy gating.
 * Runs under node:test with fake IndexedDB (as vault-ops.test.mjs).
 */
import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, ops } from '../src/vault-ops.mjs'

const dbP = openDb()
const call = async (op, m) => ops[op](await dbP, m || {})
const grant = (spec) => call('createGrant', spec).then((r) => r.grant)
const add = (g, h) => call('grantAddHandle', { grant: g, handle: h })
const sign = (h, g) => call('nearSign', {
  handle: h, payloadB64: Buffer.from('x').toString('base64'), grant: g,
})
const canSign = async (h, g) => {
  try { await sign(h, g); return true } catch { return false }
}

test('genKey: key material never leaves the vault row', async () => {
  const k = await call('nearGenKey', { label: 'a', accountId: 'a.testnet' })
  assert.match(k.pubkey, /^ed25519:/)
  assert.equal(k.kind, 'cryptokey')
  const keys = (await call('nearList', {})).keys
  const row = keys.find((x) => x.handle === k.handle)
  assert.equal(row.pubkey, k.pubkey)
  assert.equal(row.cryptoKey, undefined, 'list leaks key object')
})

test('session grant signs only with its own key handle', async () => {
  const a = await grant({ kind: 'session', session_id: 'A' })
  const b = await grant({ kind: 'session', session_id: 'B' })
  const ka = (await call('nearGenKey', { label: 'a' })).handle
  const kb = (await call('nearGenKey', { label: 'b' })).handle
  await add(a, ka); await add(b, kb)
  assert.equal(await canSign(ka, a), true)
  assert.equal(await canSign(kb, a), false, 'session A signed with B\'s key')
})

test('ambient authority signs with any handle', async () => {
  const k = (await call('nearGenKey', { label: 'x' })).handle
  assert.equal(await canSign(k, ''), true)
})

test('remote grant cannot reach shared-tier keys', async () => {
  const shared = await grant({ kind: 'shared' })
  const broker = await grant({ kind: 'broker' })
  const remote = await grant({ kind: 'remote', session_id: 'R', parent: broker })
  const k = (await call('nearGenKey', { label: 'shared' })).handle
  await add(shared, k)
  assert.equal(await canSign(k, remote), false, 'remote reached shared key')
})

test('revoked key signs nothing', async () => {
  const k = (await call('nearGenKey', { label: 'dead' })).handle
  await call('nearRevoke', { handle: k })
  assert.equal(await canSign(k, ''), false)
})

test('imported NEAR secret derives the same pubkey as near-api-js', async () => {
  const { KeyPair } = await import('near-api-js')
  const kp = KeyPair.fromRandom('ed25519')
  const r = await call('nearImportKey', { seed: kp.toString() })
  assert.equal(r.pubkey, kp.getPublicKey().toString())
})

test('policy: ambient sets, session reads via chain, sessions cannot write', async () => {
  const shared = await grant({ kind: 'shared' })
  const sess = await grant({ kind: 'session', session_id: 'S', parent: shared })
  await call('nearPolicySet', { scope: 'default', policy: { maxPerTxYocto: '7' } })
  const r = await call('nearPolicyGet', { grant: sess })
  assert.equal(r.policy.maxPerTxYocto, '7')
  const denied = await call('nearPolicySet', { grant: sess, policy: { maxPerTxYocto: '9' } })
  assert.equal(denied.ok, false)
  // session-specific policy beats inherited default
  await call('nearPolicySet', { scope: sess, policy: { maxPerTxYocto: '1' } })
  const r2 = await call('nearPolicyGet', { grant: sess })
  assert.equal(r2.policy.maxPerTxYocto, '1')
  assert.equal(r2.scope, sess)
})

test('nearList filters to grant-visible handles only', async () => {
  const sess = await grant({ kind: 'session', session_id: 'V' })
  const mine = (await call('nearGenKey', { label: 'mine' })).handle
  const other = (await call('nearGenKey', { label: 'other' })).handle
  await add(sess, mine)
  const listed = (await call('nearList', { grant: sess })).keys.map((k) => k.handle)
  assert.ok(listed.includes(mine))
  assert.ok(!listed.includes(other), 'session enumerated another session\'s key')
})
