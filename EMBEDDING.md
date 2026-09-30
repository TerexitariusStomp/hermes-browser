# Embedding Hermes

The whole stack — Pyodide backend, vault worker, UI — runs inside your page
on your Hermes deployment's origin. The host site never sees secrets; it
only reaches the JSON-RPC surface it explicitly calls.

## One line

```html
<script src="https://<your-hermes-origin>/embed.js" data-hermes></script>
```

Adds a floating launcher (bottom-right). Clicking opens the agent.

## Inline mount + programmatic API

```html
<script src="https://<your-hermes-origin>/embed.js"></script>
<div id="chat" style="width:800px;height:600px"></div>
<script>
  const h = Hermes.mount('#chat')
  await h.ready()                                    // resolves on backend-ready
  const { session_id } = await h.call('session.create', {})
  h.on('event', e => { /* backend events: message.delta, message.complete, ... */ })
  await h.prompt(session_id, 'Summarize this page')
</script>
```

`h.call(method, params)` is a pass-through to the backend's JSON-RPC
(`session.create`, `prompt.submit`, `tools.list`, `gateway.ping`, ...).
`h.prompt(sessionId, text)` is the `prompt.submit` shorthand.
`h.unmount()` tears down the frame.

## Host requirements for the inline/API mode

The backend blocks on `SharedArrayBuffer` + `Atomics`, which browsers only
expose to **cross-origin isolated** contexts. An iframe is isolated only when
the *host page* is too — so hosts must send two response headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp      # or: credentialless
```

(Under `require-corp`, every cross-origin subresource on the host page needs
`Cross-Origin-Resource-Policy`; the app already serves `CORP: cross-origin`.)

**Fallback:** on non-isolated hosts `Hermes.mount`/`bubble` degrade
automatically to a launcher that opens the agent as a standalone popup —
the window is isolated by the app's own headers. No API bridge exists in that
mode (COOP severs `window.opener` cross-origin); `call()` rejects with a
clear error telling you which headers to add.

## Consent

The first API call from a new embedder origin prompts the user *inside the
frame* — on the app's own origin — to allow or deny that site. Grants persist
in the app's localStorage (`hermes.embed.grants`), so a hidden iframe can't
silently drive the user's agent. Deny is remembered; clearing site data resets.

## Local testing

```bash
node scripts/serve.mjs          # serves dist/ on :8471 with prod-parity headers
node scripts/embed-smoke.mjs    # isolated host + iframe + consent + RPC e2e
node scripts/embed-popup-smoke.mjs  # non-isolated host -> popup fallback
```

Self-hosting is supported: `embed.js` defaults its target to the origin it
was served from, so `src="https://your-copy.example/embed.js"` embeds that
deployment.

## Files

| File | Role |
|---|---|
| `dist/embed.js` | host-side loader (`Hermes.mount` / `Hermes.bubble`) |
| `dist/embed-peer.js` | in-app bridge: postMessage → `/api/ws` JSON-RPC, consent gate |
| `dist/_headers` | `frame-ancestors https: http://localhost:* http://127.0.0.1:*` + `CORP: cross-origin` |
