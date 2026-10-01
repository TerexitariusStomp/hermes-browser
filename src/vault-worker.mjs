/**
 * vault-worker.mjs — secret vault boundary for the standalone web app.
 *
 * Secrets live only inside this worker, AES-GCM-encrypted in IndexedDB under
 * a non-extractable device key. The page and the Pyodide heap only ever see
 * `vault:<handle>` placeholders; resolution happens here, inside
 * resolveHeader, at fetch time. All vault logic lives in vault-ops.mjs
 * (transport-free, unit-testable); this file is only the coincident wiring.
 *
 * Ops (see vault-ops.mjs for semantics):
 *   storeSecret {value, label} -> {handle}
 *   resolveHeader {value, grant?} -> {value}
 *   revoke {handle}            -> {ok}
 *   list {}                    -> {handles:[{handle,label,created}]}
 *   createGrant {kind, session_id?, parent?, handles?} -> {grant}
 *   grantAddHandle {grant, handle} -> {ok}
 *   revokeGrant {grant}        -> {ok}        (tombstone: instant lockout)
 *   listGrants {}              -> {grants:[...]}
 */
import coincident from './vendor/coincident-worker.js'
import { openDb, ops } from './vault-ops.mjs'

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
