// PWA grant bridge — browser-native capability ops for the agent.
// Every op is a fixed vocabulary entry; args carry data only, never code.
// Anything needing a user gesture (FSA pickers) parks a pending grant and
// surfaces a click target; the browser's own permission prompts cover the
// rest. Grant state is auditable via `status` and persisted handles live in
// IndexedDB so a granted folder survives reloads.

import { openDB } from './vendor/idb.mjs'

const DB_NAME = 'hermes-pwa'
const STORE = 'handles'

let dbPromise = null
function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(d) { d.createObjectStore(STORE) },
    })
  }
  return dbPromise
}

const idbPut = async (k, v) => (await db()).put(STORE, v, k)
const idbGet = async (k) => (await db()).get(STORE, k)
const idbDel = async (k) => (await db()).delete(STORE, k)

// --- pending interactive grants ------------------------------------------
// FSA pickers require transient user activation: the op parks a resolver
// and shows a click target; the click is the activation that opens the picker.

const pendingGrants = new Map()
let grantSeq = 0

function grantButton(label) {
  let el = document.getElementById('hermes-pwa-grant')
  if (!el) {
    el = document.createElement('button')
    el.id = 'hermes-pwa-grant'
    el.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;' +
      'padding:8px 14px;border-radius:8px;border:0;background:#7c5cff;color:#fff;' +
      'font:13px system-ui;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.4)'
    document.body.appendChild(el)
    el.onclick = function () {
      const first = pendingGrants.entries().next().value
      if (first) first[1](el)
    }
  }
  el.textContent = label
  el.style.display = 'block'
  return el
}

function hideGrantButtonIfIdle() {
  if (pendingGrants.size === 0) {
    const el = document.getElementById('hermes-pwa-grant')
    if (el) el.style.display = 'none'
  }
}

function awaitUserGesture(label, runPicker, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const id = ++grantSeq
    const timer = setTimeout(function () {
      pendingGrants.delete(id)
      hideGrantButtonIfIdle()
      reject(new Error('grant timed out waiting for user click'))
    }, timeoutMs || 120000)
    pendingGrants.set(id, async function (el) {
      pendingGrants.delete(id)
      hideGrantButtonIfIdle()
      clearTimeout(timer)
      try { resolve(await runPicker()) } catch (e) { reject(e) }
    })
    grantButton(label)
  })
}

// --- fs (File System Access) ----------------------------------------------

async function fsPickDir(args) {
  if (!window.showDirectoryPicker) return { error: 'fsa_unsupported' }
  const handle = await awaitUserGesture(
    'Grant folder access', function () {
      return showDirectoryPicker({ mode: (args.mode === 'rw' ? 'readwrite' : 'read') })
    })
  const key = 'dir:' + handle.name
  await idbPut(key, { handle: handle, name: handle.name, mode: args.mode || 'read' })
  return { ok: true, dir_id: key, name: handle.name }
}

async function fsDirHandle(dirId, write) {
  const rec = await idbGet(dirId)
  if (!rec || !rec.handle) return { error: 'unknown_dir_id' }
  const h = rec.handle
  const perm = await h.queryPermission({ mode: write ? 'readwrite' : 'read' })
  if (perm !== 'granted') {
    // requestPermission needs activation only when state is 'prompt'
    const got = await h.requestPermission({ mode: write ? 'readwrite' : 'read' })
    if (got !== 'granted') return { error: 'fs_permission_denied' }
  }
  return { handle: h }
}

async function fsList(args) {
  const r = await fsDirHandle(args.dir_id, false)
  if (r.error) return r
  const entries = []
  for await (const [name, h] of r.handle.entries()) {
    entries.push({ name: name, kind: h.kind })
    if (entries.length >= 500) break
  }
  return { ok: true, entries: entries }
}

async function fsRead(args) {
  const r = await fsDirHandle(args.dir_id, false)
  if (r.error) return r
  const fh = await r.handle.getFileHandle(args.path)
  const f = await fh.getFile()
  if (f.size > 8 * 1024 * 1024) return { error: 'file_too_large' }
  const buf = new Uint8Array(await f.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
  return { ok: true, name: f.name, size: f.size, body_b64: btoa(bin) }
}

async function fsWrite(args) {
  const r = await fsDirHandle(args.dir_id, true)
  if (r.error) return r
  const fh = await r.handle.getFileHandle(args.path, { create: true })
  const w = await fh.createWritable()
  const bytes = Uint8Array.from(atob(args.body_b64 || ''), function (c) { return c.charCodeAt(0) })
  await w.write(bytes)
  await w.close()
  return { ok: true, path: args.path, bytes: bytes.length }
}

async function fsForget(args) {
  await idbDel(args.dir_id)
  return { ok: true }
}

// --- notifications ---------------------------------------------------------

async function notify(args) {
  if (!('Notification' in window)) return { error: 'notifications_unsupported' }
  let perm = Notification.permission
  if (perm === 'default') perm = await Notification.requestPermission()
  if (perm !== 'granted') return { error: 'notification_permission_denied', permission: perm }
  const n = new Notification(args.title || 'Hermes', {
    body: args.body || '', tag: args.tag || undefined,
  })
  return { ok: true, permission: perm }
}

// --- media: mic / camera / speech ------------------------------------------

async function micRecord(args) {
  const secs = Math.min(Math.max(Number(args.seconds) || 5, 1), 60)
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (e) {
    return { error: 'mic_permission_denied', detail: String(e).slice(0, 200) }
  }
  try {
    const rec = new MediaRecorder(stream)
    const chunks = []
    rec.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data) }
    const done = new Promise(function (res) { rec.onstop = res })
    rec.start()
    await new Promise(function (res) { setTimeout(res, secs * 1000) })
    rec.stop()
    await done
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
    const buf = new Uint8Array(await blob.arrayBuffer())
    let bin = ''
    for (let i = 0; i < buf.length; i += 0x8000)
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
    return { ok: true, mime: blob.type, seconds: secs, audio_b64: btoa(bin) }
  } finally {
    stream.getTracks().forEach(function (t) { t.stop() })
  }
}

async function sttListen(args) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) return { error: 'stt_unsupported' }
  const rec = new SR()
  rec.lang = args.lang || 'en-US'
  rec.interimResults = false
  rec.maxAlternatives = 1
  const secs = Math.min(Number(args.timeout_s) || 15, 60)
  return new Promise(function (resolve) {
    const timer = setTimeout(function () { rec.stop() }, secs * 1000)
    rec.onresult = function (e) {
      clearTimeout(timer)
      const t = e.results[0] && e.results[0][0] && e.results[0][0].transcript
      resolve({ ok: true, transcript: t || '', confidence: e.results[0][0].confidence })
    }
    rec.onerror = function (e) {
      clearTimeout(timer)
      resolve({ error: 'stt_error', detail: e.error })
    }
    rec.onend = function () {
      clearTimeout(timer)
      resolve({ ok: true, transcript: '', note: 'ended_no_result' })
    }
    try { rec.start() } catch (e) { resolve({ error: 'stt_start_failed', detail: String(e) }) }
  })
}

async function visionSnap() {
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true })
  } catch (e) {
    return { error: 'camera_permission_denied', detail: String(e).slice(0, 200) }
  }
  try {
    const track = stream.getVideoTracks()[0]
    let blob
    if (window.ImageCapture) {
      blob = await new ImageCapture(track).takePhoto()
    } else {
      const v = document.createElement('video')
      v.srcObject = stream
      await v.play()
      const c = document.createElement('canvas')
      c.width = v.videoWidth; c.height = v.videoHeight
      c.getContext('2d').drawImage(v, 0, 0)
      blob = await new Promise(function (res) { c.toBlob(res, 'image/jpeg', 0.85) })
    }
    const buf = new Uint8Array(await blob.arrayBuffer())
    let bin = ''
    for (let i = 0; i < buf.length; i += 0x8000)
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
    return { ok: true, mime: blob.type, image_b64: btoa(bin) }
  } finally {
    stream.getTracks().forEach(function (t) { t.stop() })
  }
}

// --- wake lock ---------------------------------------------------------------

let wakeLock = null

async function wakeAcquire() {
  if (!navigator.wakeLock) return { error: 'wakelock_unsupported' }
  if (wakeLock) return { ok: true, held: true, already: true }
  try {
    wakeLock = await navigator.wakeLock.request('screen')
    wakeLock.addEventListener('release', function () { wakeLock = null })
    return { ok: true, held: true }
  } catch (e) {
    return { error: 'wakelock_denied', detail: String(e).slice(0, 200) }
  }
}

async function wakeRelease() {
  if (wakeLock) { await wakeLock.release(); wakeLock = null }
  return { ok: true, held: false }
}

// --- periodic sync / service worker ------------------------------------------

async function swRegister() {
  if (!('serviceWorker' in navigator)) return { error: 'sw_unsupported' }
  const reg = await navigator.serviceWorker.register('./sw.js')
  return reg
}

async function periodicSync(args) {
  const reg = await swRegister()
  if (!('periodicSync' in reg)) return { error: 'periodic_sync_unsupported', note: 'requires installed PWA on Chromium' }
  const perm = await navigator.permissions.query({ name: 'periodic-background-sync' })
  if (perm.state !== 'granted') return { error: 'periodic_sync_denied', state: perm.state }
  const minIntervalMs = Math.max(Number(args.min_interval_ms) || 3600000, 12 * 3600 * 1000)
  await reg.periodicSync.register(args.tag || 'hermes-cron', { minInterval: minIntervalMs })
  return { ok: true, tag: args.tag || 'hermes-cron', min_interval_ms: minIntervalMs }
}

async function periodicSyncList() {
  const reg = await swRegister()
  if (!('periodicSync' in reg)) return { ok: true, tags: [] }
  const tags = await reg.periodicSync.getTags()
  return { ok: true, tags: tags }
}

// --- status ------------------------------------------------------------------

async function status() {
  const out = {
    notification: ('Notification' in window) ? Notification.permission : 'unsupported',
    fsa: !!window.showDirectoryPicker,
    mic: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    camera: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    stt: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
    wakelock: !!navigator.wakeLock,
    serviceWorker: 'serviceWorker' in navigator,
    periodicSync: false,
    webgpu: !!navigator.gpu,
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    out.serviceWorker = !!reg
    out.periodicSync = !!(reg && reg.periodicSync)
  } catch (e) {}
  return { ok: true, capabilities: out }
}

const OPS = {
  'status': status,
  'notify': notify,
  'fs.pick_dir': fsPickDir,
  'fs.list': fsList,
  'fs.read': fsRead,
  'fs.write': fsWrite,
  'fs.forget': fsForget,
  'mic.record': micRecord,
  'stt.listen': sttListen,
  'vision.snap': visionSnap,
  'wakelock.acquire': wakeAcquire,
  'wakelock.release': wakeRelease,
  'periodic.register': periodicSync,
  'periodic.list': periodicSyncList,
}

export async function handle(op, args) {
  const fn = OPS[op]
  if (!fn) return { error: 'unknown_pwa_op', op: op }
  return fn(args || {})
}
