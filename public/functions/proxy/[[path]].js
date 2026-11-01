// Cloudflare Pages Function — same-origin proxy for hosts that don't send
// CORS headers. The in-browser backend's fetches are CORS-bound; upstream
// OAuth/API endpoints (Nous Portal, inference) aren't, so page JS rewrites
// them to /proxy/<host>/<rest> and this function forwards them.
//
// Allowlist only — this is not an open proxy.
const ALLOWED_HOSTS = new Set([
  'portal.nousresearch.com',
  'inference-api.nousresearch.com',
  'welcome-api.nousresearch.com',
])

export async function onRequest(context) {
  const segs = context.params.path || []
  const host = segs[0]
  if (!ALLOWED_HOSTS.has(host)) {
    return new Response('host not allowed', { status: 403 })
  }
  const url = new URL(context.request.url)
  const upstream = `https://${host}/${segs.slice(1).join('/')}${url.search}`

  const headers = new Headers(context.request.headers)
  headers.delete('host')
  headers.delete('origin')
  headers.delete('referer')
  // hop-by-hop headers must not be forwarded
  for (const h of ['connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
    'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cdn-loop',
    'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip'])
    headers.delete(h)

  const init = { method: context.request.method, headers, redirect: 'manual' }
  if (context.request.method !== 'GET' && context.request.method !== 'HEAD') {
    init.body = context.request.body
    init.duplex = 'half'
  }
  const resp = await fetch(upstream, init)
  const out = new Headers(resp.headers)
  for (const h of ['connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
    'content-encoding', 'content-length'])
    out.delete(h)
  return new Response(resp.body, { status: resp.status, headers: out })
}
