// CORS proxy for hosts that send no CORS headers (Nous Portal auth,
// inference API). The in-browser backend's fetches are CORS-bound, so
// bootstrap.js rewrites allowlisted hosts to
// https://<worker>/proxy/<host>/<rest> — this Worker forwards them and
// stamps ACAO on the response. Allowlist only — not an open proxy.
const ALLOWED_HOSTS = new Set([
  'portal.nousresearch.com',
  'inference-api.nousresearch.com',
  'welcome-api.nousresearch.com',
])

const HOP_BY_HOP = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]

function cors(resp, origin) {
  const h = new Headers(resp.headers)
  for (const x of HOP_BY_HOP) h.delete(x)
  h.set('Access-Control-Allow-Origin', origin || '*')
  h.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  h.set('Access-Control-Allow-Headers', '*')
  h.set('Access-Control-Max-Age', '86400')
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h })
}

export default {
  async fetch(request) {
    const url = new URL(request.url)
    const origin = request.headers.get('origin') || '*'

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(new Response(), origin).headers })
    }

    // /proxy/<host>/<rest>
    const segs = url.pathname.split('/').filter(Boolean)
    if (segs[0] !== 'proxy' || !ALLOWED_HOSTS.has(segs[1])) {
      return cors(new Response('host not allowed', { status: 403 }), origin)
    }
    const upstream = `https://${segs[1]}/${segs.slice(2).join('/')}${url.search}`

    const headers = new Headers(request.headers)
    for (const h of [...HOP_BY_HOP, 'host', 'origin', 'referer',
      'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cdn-loop',
      'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip']) headers.delete(h)

    const init = { method: request.method, headers, redirect: 'manual' }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body
    }
    const resp = await fetch(upstream, init)
    return cors(resp, origin)
  },
}
