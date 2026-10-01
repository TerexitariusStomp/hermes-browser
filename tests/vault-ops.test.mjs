/**
 * vault-ops grant scoping — the key-domain invariants the share/session
 * model depends on. Runs under node:test with a fake IndexedDB.
 */
import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, ops } from '../src/vault-ops.mjs'

const dbP = openDb()
const call = async (op, m) => ops[op](await dbP, m || {})
const grant = (spec) => call('createGrant', spec).then((r) => r.grant)
const add = (g, h) => call('grantAddHandle', { grant: g, handle: h })
const store = (v) => call('storeSecret', { value: v }).then((r) => 'vault:' + r.handle)
const resolve = (v, g) => call('resolveHeader', { value: v, grant: g })
const resolves = async (v, g) => {
  try { await resolve(v, g); return true } catch { return false }
}

test('session grant resolves its own handle, not another session\'s', async () => {
  const a = await grant({ kind: 'session', session_id: 'A' })
  const b = await grant({ kind: 'session', session_id: 'B' })
  const ha = await store('secret-a')
  const hb = await store('secret-b')
  await add(a, ha.slice(6)); await add(b, hb.slice(6))
  assert.equal((await resolve(ha, a)).value, 'secret-a')
  assert.equal(await resolves(hb, a), false, 'session A resolved B\'s secret')
})

test('local sessions inherit the shared tier; remotes cannot climb to it', async () => {
  const shared = await grant({ kind: 'shared' })
  const broker = await grant({ kind: 'broker' })
  const local = await grant({ kind: 'session', session_id: 'L', parent: shared })
  const remote = await grant({ kind: 'remote', session_id: 'R', parent: broker })

  const sharedSecret = await store('shared-secret')
  await add(shared, sharedSecret.slice(6))
  assert.equal(await resolves(sharedSecret, local), true, 'local lost shared tier')
  assert.equal(await resolves(sharedSecret, remote), false, 'remote reached shared tier')

  const remoteSecret = await store('remote-secret')
  await add(broker, remoteSecret.slice(6))
  assert.equal(await resolves(remoteSecret, remote), true, 'remote lost broker tier')
  assert.equal(await resolves(remoteSecret, local), false, 'local reached broker tier')
})

test('remote session cannot resolve another remote session\'s secret', async () => {
  const broker = await grant({ kind: 'broker' })
  const r1 = await grant({ kind: 'remote', session_id: 'R1', parent: broker })
  const r2 = await grant({ kind: 'remote', session_id: 'R2', parent: broker })
  const h = await store('r1-only')
  await add(r1, h.slice(6))
  assert.equal(await resolves(h, r1), true)
  assert.equal(await resolves(h, r2), false, 'remote sibling resolved it')
})

test('revoked ancestor dead-ends the chain; own handles still resolve', async () => {
  const shared = await grant({ kind: 'shared' })
  const sess = await grant({ kind: 'session', session_id: 'S', parent: shared })
  const own = await store('own')
  const shr = await store('shared')
  await add(sess, own.slice(6))
  await add(shared, shr.slice(6))
  await call('revokeGrant', { grant: shared })
  assert.equal(await resolves(own, sess), true, 'own secret lost with parent')
  assert.equal(await resolves(shr, sess), false, 'revoked parent still resolved')
})

test('revoked grant resolves nothing; absent grant is owner authority', async () => {
  const g = await grant({ kind: 'session', session_id: 'X' })
  const h = await store('x')
  await add(g, h.slice(6))
  await call('revokeGrant', { grant: g })
  assert.equal(await resolves(h, g), false)
  assert.equal((await resolve(h, '')).value, 'x', 'ambient authority broke')
})

test('unknown handle fails loudly under any grant', async () => {
  const g = await grant({ kind: 'session', session_id: 'Y' })
  assert.equal(await resolves('vault:h_deadbeef', g), false)
})
