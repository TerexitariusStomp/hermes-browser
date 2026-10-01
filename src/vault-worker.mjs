/**
 * vault-worker.mjs — secret vault boundary for the standalone web app.
 *
 * Secrets live only inside this worker, AES-GCM-encrypted in IndexedDB under
 * a non-extractable device key. The page and the Pyodide heap only ever see
 * `vault:<handle>` placeholders; resolution happens here, inside
 * resolveHeader, at fetch time.
 *
 * Transport is coincident: the page calls `vaultWorker.proxy.call(op,
 * payload)` and the promise resolves with the op result. Ops:
 *   storeSecret {value, label} -> {handle}
 *   resolveHeader {value, grant?} -> {value}   (vault: placeholders replaced;
 *      when `grant` names a live grant, every handle must be in its scope —
 *      absent grant is the local broker authority and resolves anything)
 *   revoke {handle}            -> {ok}
 *   list {}                    -> {handles:[{handle,label,created}]}
 *   createGrant {kind, session_id?, parent?, handles?} -> {grant}
 *   grantAddHandle {grant, handle} -> {ok}
 *   revokeGrant {grant}        -> {ok}        (tombstone: instant lockout)
 *   listGrants {}              -> {grants:[...]}
 */
import coincident from './vendor/coincident-worker.js'
import { openDB } from './vendor/idb.mjs'

const DB_NAME = 'hermes-vault'
const SECRETS_STORE = 'secrets'
const KEY_STORE = 'devicekey'
const GRANTS_STORE = 'grants'

function openDb() {
  return openDB(DB_NAME, 2, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(SECRETS_STORE))
        db.createObjectStore(SECRETS_STORE, { keyPath: 'handle' })
      if (!db.objectStoreNames.contains(KEY_STORE))
        db.createObjectStore(KEY_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(GRANTS_STORE))
        db.createObjectStore(GRANTS_STORE, { keyPath: 'id' })
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

// Replace every `vault:<handle>` token inside a header value.
// With a grant: the grant must be live and every referenced handle in scope.
// Without: the request came from local broker authority — anything resolves.
async function resolveHeader(db, value, grantId) {
  let grant = null
  if (grantId) {
    grant = await loadGrant(db, grantId)
    if (!grant) throw new Error('grant revoked or unknown')
  }
  const parts = value.split(/vault:(h_[a-z0-9]+)/g)
  for (let i = 1; i < parts.length; i += 2) {
    if (grant && !grantAllowsHandle(grant, parts[i]))
      throw new Error('handle outside grant scope')
    const real = await readSecret(db, parts[i])
    if (real === null) throw new Error('vault handle revoked or unknown')
    parts[i] = real
  }
  return parts.join('')
}

const ops = {
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
    const rows = await tx(db, GRANTS_STORE, 'readonly', (s) => s.getAll())
    return {
      grants: rows.map((r) => ({
        grant: r.id, kind: r.kind, session_id: r.session_id,
        parent: r.parent, handles: r.handles, created: r.created, revoked: r.revoked,
      })),
    }
  },
}

let dbPromise = null
const { proxy } = await coincident()
proxy.call = async (op, payload) => {
  try {
    dbPromise = dbPromise || openDb()
    const db = await dbPromise
    return await ops[op](db, payload || {})
  } catch (e) {
    return { error: String(e && e.message || e) }
  }
}
