/**
 * vault-ops.mjs — the vault worker's op table, transport-free.
 *
 * Secrets live AES-GCM-encrypted in IndexedDB under a non-extractable
 * device key. The page and the Pyodide heap only ever see
 * `vault:<handle>` placeholders; resolution happens here, inside
 * resolveHeader, at fetch time.
 *
 * Grant model — sessions are separate key domains:
 *   - shared grant:   unattributed writes (outside a session context);
 *     every local session grant parents to it, so local sessions inherit
 *     the shared tier
 *   - session grant:  secrets written inside that session — no other
 *     session resolves them
 *   - share broker:   remote share's parent; remote-written secrets land
 *     here when unattributed
 *   - remote grant:   parents to the share broker — can never climb into
 *     the shared tier
 *   - absent grant:   local broker authority (the owner's ambient calls)
 *     resolves anything
 */
import { openDB } from './vendor/idb.mjs'
import * as ed25519 from './vendor/noble-ed25519.mjs'

const DB_NAME = 'hermes-vault'
const SECRETS_STORE = 'secrets'
const KEY_STORE = 'devicekey'
const GRANTS_STORE = 'grants'
const NEAR_KEYS_STORE = 'nearkeys'
const NEAR_POLICIES_STORE = 'nearpolicies'

export function openDb() {
  return openDB(DB_NAME, 3, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(SECRETS_STORE))
        db.createObjectStore(SECRETS_STORE, { keyPath: 'handle' })
      if (!db.objectStoreNames.contains(KEY_STORE))
        db.createObjectStore(KEY_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(GRANTS_STORE))
        db.createObjectStore(GRANTS_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(NEAR_KEYS_STORE))
        db.createObjectStore(NEAR_KEYS_STORE, { keyPath: 'handle' })
      if (!db.objectStoreNames.contains(NEAR_POLICIES_STORE))
        db.createObjectStore(NEAR_POLICIES_STORE, { keyPath: 'id' })
    },
  })
}

async function deviceKey(db) {
  const row = await db.get(KEY_STORE, 'local')
  if (row && row.key) return row.key
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  await db.put(KEY_STORE, { id: 'local', key })
  return key
}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function storeSecret(db, value, label) {
  const key = await deviceKey(db)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value))
  const handle = 'h_' + crypto.randomUUID().replace(/-/g, '')
  await db.put(SECRETS_STORE,
    { handle, label: label || '', created: Date.now(), revoked: false, iv: b64(iv), ct: b64(ct) })
  return handle
}

async function readSecret(db, handle) {
  const row = await db.get(SECRETS_STORE, handle)
  if (!row || row.revoked) return null
  const key = await deviceKey(db)
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(row.iv) }, key, unb64(row.ct))
  return new TextDecoder().decode(pt)
}

async function loadGrant(db, id) {
  const row = await db.get(GRANTS_STORE, id)
  if (!row || row.revoked) return null
  return row
}

function grantAllowsHandle(grant, handle) {
  return grant.handles === '*' ||
    (Array.isArray(grant.handles) && grant.handles.includes(handle))
}

// A handle resolves when any live ancestor of the grant allows it — this is
// what makes the "shared" tier work: local session grants parent to the
// shared grant (inheriting unattributed secrets), remote session grants
// parent to the share broker grant (inheriting only remote-written secrets,
// never the shared tier). A revoked ancestor dead-ends the chain.
async function grantAllows(db, grant, handle) {
  let g = grant
  for (let depth = 0; g && depth < 8; depth++) {
    if (grantAllowsHandle(g, handle)) return true
    if (!g.parent) return false
    g = await loadGrant(db, g.parent)
  }
  return false
}

// Replace every `vault:<handle>` token inside a header value.
// With a grant: the grant must be live and every referenced handle in scope
// (own list or a live ancestor's). Without: local broker authority resolves
// anything — the page's ambient calls (grant='') are the owner's own.
async function resolveHeader(db, value, grantId) {
  let grant = null
  if (grantId) {
    grant = await loadGrant(db, grantId)
    if (!grant) throw new Error('grant revoked or unknown')
  }
  const parts = value.split(/vault:(h_[a-z0-9]+)/g)
  for (let i = 1; i < parts.length; i += 2) {
    if (grant && !(await grantAllows(db, grant, parts[i])))
      throw new Error('handle outside grant scope')
    const real = await readSecret(db, parts[i])
    if (real === null) throw new Error('vault handle revoked or unknown')
    parts[i] = real
  }
  return parts.join('')
}

// ---- NEAR key custody -----------------------------------------------------
// NEAR keys are ed25519. Two custody modes, best-first:
//   'cryptokey' — a non-extractable WebCrypto Ed25519 CryptoKey persisted in
//     IndexedDB (structured-cloneable). Key bytes can never be read out, not
//     even inside this worker. Requires WebCrypto Ed25519 (Chrome 137+,
//     Firefox 129+, Safari 17+).
//   'seed' — fallback for older engines: the 32-byte seed AES-GCM-encrypted
//     under the device key; noble-ed25519 signs inside this worker.
// Either way, raw key material never crosses to page JS or the Python heap —
// callers see `vault:<handle>` and sign through `nearSign` under a grant.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function b58encode(bytes) {
  const digits = [0]
  for (const b of bytes) {
    let carry = b
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8
      digits[i] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0 }
  }
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  return '1'.repeat(zeros) +
    digits.reverse().map((d) => B58[d]).join('')
}

function b58decode(str) {
  const bytes = [0]
  for (const ch of str) {
    const v = B58.indexOf(ch)
    if (v < 0) throw new Error('bad base58')
    let carry = v
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8 }
  }
  let zeros = 0
  while (zeros < str.length && str[zeros] === '1') zeros++
  return Uint8Array.from(new Array(zeros).fill(0).concat(bytes.reverse()))
}

const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64url = (s) => unb64(s.replace(/-/g, '+').replace(/_/g, '/'))

async function webcryptoEd25519() {
  try {
    if (!crypto.subtle || !crypto.subtle.generateKey) return false
    await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    return true
  } catch (e) { return false }
}

// Parse a NEAR secret string (`ed25519:<b58>` of 64B seed||pub or 32B seed)
// into {seed, pubkey}. Pubkey is derived, never trusted from the string.
async function parseNearSecret(secret) {
  const raw = String(secret || '').trim()
  const body = raw.startsWith('ed25519:') ? raw.slice(8) : raw
  const bytes = b58decode(body)
  if (bytes.length !== 64 && bytes.length !== 32)
    throw new Error('NEAR secret must be 64-byte secret_key or 32-byte seed (base58)')
  const seed = bytes.slice(0, 32)
  const pub = new Uint8Array(await ed25519.getPublicKeyAsync(seed))
  if (bytes.length === 64 && b58encode(bytes.slice(32)) !== b58encode(pub))
    throw new Error('NEAR secret pubkey suffix does not match the seed')
  return { seed, pubkey: 'ed25519:' + b58encode(pub), pubBytes: pub }
}

async function importCryptoKey(seed, pubBytes) {
  const jwk = {
    kty: 'OKP', crv: 'Ed25519',
    d: b64url(seed), x: b64url(pubBytes), ext: false,
  }
  return crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign'])
}

async function storeNearKey(db, { seed, pubkey, pubBytes, label, accountId }) {
  const handle = 'h_' + crypto.randomUUID().replace(/-/g, '')
  const base = {
    handle, pubkey, accountId: accountId || '',
    label: label || 'near', created: Date.now(), revoked: false,
  }
  if (await webcryptoEd25519()) {
    try {
      const cryptoKey = await importCryptoKey(seed, pubBytes)
      await db.put(NEAR_KEYS_STORE, { ...base, kind: 'cryptokey', cryptoKey })
      return { handle, pubkey, kind: 'cryptokey' }
    } catch (e) { /* fall through to seed custody */ }
  }
  const key = await deviceKey(db)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, seed)
  await db.put(NEAR_KEYS_STORE,
    { ...base, kind: 'seed', iv: b64(iv), ct: b64(ct) })
  return { handle, pubkey, kind: 'seed' }
}

async function loadNearKey(db, handle) {
  const row = await db.get(NEAR_KEYS_STORE, handle)
  if (!row || row.revoked) return null
  return row
}

// Sign arbitrary bytes (tx hash, delegate hash, NEP-413 hash) with a stored
// key, scoped by grant exactly like resolveHeader: absent grant = local
// owner authority; session/remote grants need the handle in scope.
async function nearSign(db, m) {
  const handle = String(m.handle || '').replace(/^vault:/, '')
  if (m.grant) {
    const grant = await loadGrant(db, m.grant)
    if (!grant) throw new Error('grant revoked or unknown')
    if (!(await grantAllows(db, grant, handle)))
      throw new Error('handle outside grant scope')
  }
  const row = await loadNearKey(db, handle)
  if (!row) throw new Error('vault handle revoked or unknown')
  const msg = unb64(m.payloadB64 || '')
  let sig
  if (row.kind === 'cryptokey' && row.cryptoKey) {
    sig = new Uint8Array(await crypto.subtle.sign(
      { name: 'Ed25519' }, row.cryptoKey, msg))
  } else {
    const key = await deviceKey(db)
    const seed = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(row.iv) }, key, unb64(row.ct)))
    sig = new Uint8Array(await ed25519.signAsync(msg, seed))
    seed.fill(0)
  }
  return { signatureB64: b64(sig), pubkey: row.pubkey }
}

async function nearPolicyGet(db, scope) {
  const row = await db.get(NEAR_POLICIES_STORE, scope || 'default')
  return row || null
}

export const ops = {
  async storeSecret(db, m) { return { handle: await storeSecret(db, m.value, m.label) } },
  async resolveHeader(db, m) { return { value: await resolveHeader(db, m.value, m.grant) } },
  async revoke(db, m) {
    const row = await db.get(SECRETS_STORE, m.handle)
    if (row) await db.put(SECRETS_STORE, { ...row, revoked: true })
    return { ok: !!row }
  },
  async list(db) {
    const rows = await db.getAll(SECRETS_STORE)
    return { handles: rows.map((r) => ({ handle: r.handle, label: r.label, created: r.created, revoked: r.revoked })) }
  },
  async createGrant(db, m) {
    const grant = {
      id: 'g_' + crypto.randomUUID().replace(/-/g, ''),
      kind: m.kind || 'session',
      session_id: m.session_id || null,
      parent: m.parent || null,
      handles: m.handles === '*' ? '*' : (m.handles || []),
      created: Date.now(),
      revoked: false,
    }
    await db.put(GRANTS_STORE, grant)
    return { grant: grant.id }
  },
  async grantAddHandle(db, m) {
    const grant = await loadGrant(db, m.grant)
    if (!grant) return { ok: false, error: 'grant revoked or unknown' }
    if (grant.handles !== '*') {
      if (!grant.handles.includes(m.handle)) {
        grant.handles = grant.handles.concat([m.handle])
        await db.put(GRANTS_STORE, grant)
      }
    }
    return { ok: true }
  },
  async revokeGrant(db, m) {
    const row = await db.get(GRANTS_STORE, m.grant)
    if (row) await db.put(GRANTS_STORE, { ...row, revoked: true })
    return { ok: !!row }
  },
  async listGrants(db) {
    const rows = await db.getAll(GRANTS_STORE)
    return {
      grants: rows.map((r) => ({
        grant: r.id, kind: r.kind, session_id: r.session_id,
        parent: r.parent, handles: r.handles, created: r.created, revoked: r.revoked,
      })),
    }
  },

  // ---- NEAR ops ----
  async nearGenKey(db, m) {
    // Generate inside the vault when possible: non-extractable CryptoKey,
    // seed material never exists in JS at all. Fallback derives a seed here
    // and AES-GCM-stores it (noble signs in-worker).
    if (await webcryptoEd25519()) {
      try {
        const pair = await crypto.subtle.generateKey(
          { name: 'Ed25519' }, false, ['sign', 'verify'])
        const pubBytes = new Uint8Array(
          await crypto.subtle.exportKey('raw', pair.publicKey))
        const handle = 'h_' + crypto.randomUUID().replace(/-/g, '')
        const pubkey = 'ed25519:' + b58encode(pubBytes)
        await db.put(NEAR_KEYS_STORE, {
          handle, pubkey, accountId: m.accountId || '', label: m.label || 'near',
          created: Date.now(), revoked: false, kind: 'cryptokey',
          cryptoKey: pair.privateKey, publicKey: pair.publicKey,
        })
        return { handle, pubkey, kind: 'cryptokey' }
      } catch (e) { /* fall through */ }
    }
    const seed = crypto.getRandomValues(new Uint8Array(32))
    const parsed = await parseNearSecret('ed25519:' + b58encode(seed))
    return storeNearKey(db, {
      seed: parsed.seed, pubkey: parsed.pubkey, pubBytes: parsed.pubBytes,
      label: m.label, accountId: m.accountId,
    })
  },
  async nearImportKey(db, m) {
    const parsed = await parseNearSecret(m.seed || '')
    return storeNearKey(db, {
      seed: parsed.seed, pubkey: parsed.pubkey, pubBytes: parsed.pubBytes,
      label: m.label, accountId: m.accountId,
    })
  },
  async nearLinkAccount(db, m) {
    const row = await loadNearKey(db, m.handle)
    if (!row) return { ok: false, error: 'vault handle revoked or unknown' }
    row.accountId = m.accountId || ''
    await db.put(NEAR_KEYS_STORE, row)
    return { ok: true }
  },
  async nearPubkey(db, m) {
    const row = await loadNearKey(db, String(m.handle || '').replace(/^vault:/, ''))
    if (!row) return { error: 'vault handle revoked or unknown' }
    return { pubkey: row.pubkey, accountId: row.accountId, kind: row.kind }
  },
  async nearList(db, m) {
    const rows = await db.getAll(NEAR_KEYS_STORE)
    let grant = null
    if (m.grant) {
      grant = await loadGrant(db, m.grant)
      if (!grant) return { error: 'grant revoked or unknown' }
    }
    const visible = []
    for (const r of rows) {
      // Ambient callers see all keys; granted callers only see handles in
      // their scope — other sessions' keys stay unenumerable.
      if (grant && !(await grantAllows(db, grant, r.handle))) continue
      visible.push({
        handle: r.handle, pubkey: r.pubkey, accountId: r.accountId || '',
        label: r.label, kind: r.kind, created: r.created, revoked: !!r.revoked,
      })
    }
    return { keys: visible }
  },
  async nearRevoke(db, m) {
    const row = await db.get(NEAR_KEYS_STORE, String(m.handle || '').replace(/^vault:/, ''))
    if (row) await db.put(NEAR_KEYS_STORE, { ...row, revoked: true })
    return { ok: !!row }
  },
  nearSign,
  async nearPolicyGet(db, m) {
    // Walk the caller's grant chain — a session reads the most specific
    // policy set for it, else inherits its parent's, else 'default'.
    if (m.grant) {
      let g = await loadGrant(db, m.grant)
      for (let depth = 0; g && depth < 8; depth++) {
        const p = await nearPolicyGet(db, g.id)
        if (p) return { policy: p.policy, scope: g.id }
        g = g.parent ? await loadGrant(db, g.parent) : null
      }
    }
    const p = await nearPolicyGet(db, 'default')
    return { policy: p ? p.policy : null, scope: 'default' }
  },
  async nearPolicySet(db, m) {
    // Ambient-authority only: an empty/absent grant is the owner. Agent
    // sessions (which always carry a grant) can never raise their own caps.
    if (m.grant) return { ok: false, error: 'policy set requires owner authority' }
    const scope = m.scope || 'default'
    await db.put(NEAR_POLICIES_STORE, {
      id: scope, policy: m.policy || {}, updated: Date.now(),
    })
    return { ok: true, scope }
  },
}
