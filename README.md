# hermes-browser

Run [Hermes](https://github.com/NousResearch/hermes-agent) — the full agent
core, not a wrapper — entirely inside a browser tab. No server, no install:
the upstream `run_agent`/`tui_gateway`/`hermes_cli` code runs under Pyodide
in a Web Worker, behind a secret-vault boundary so API keys never enter the
Python heap or page JS.

A deployed instance serves a complete Hermes web app (the upstream Desktop
renderer) plus a stock remote-gateway surface, a WASI Linux userspace for
`terminal`, browser-native capability tools (notifications, File System
Access, mic/camera, speech-to-text, wake lock, periodic sync), an in-page
local-model endpoint, a one-line embed API, and an opt-in localhost
companion for driving the user's real machine.

## Requirements

- A cross-origin-isolated host page (`SharedArrayBuffer`/`Atomics` need it):

  ```
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp    # or credentialless
  ```

- Chromium-class browser recommended (OPFS persistence, FSA, periodic sync).
  Firefox/Safari run the core; some capability tools degrade gracefully.

## Build

```bash
npm install
npm run build      # vendors upstream hermes-agent, packs env, assembles dist/
npm run serve      # http://localhost:8471 (COOP/COEP headers set)
npm run smoke      # end-to-end boot + RPC smoke (needs playwright-core chromium)
```

`scripts/vendor.sh` pins upstream via `HERMES_REF` (currently the open
webapp PR head for the `dist-webapp` renderer; point at `main` once merged).
The vendored tree is never edited — all browser adaptation lives in `src/`.

## What's in `src/`

| File | Role |
|---|---|
| `browser_runtime.py` | Cooperative scheduler + threading/asyncio shims that make the stock synchronous core survivable under Pyodide |
| `browser_bootstrap.py` | Pyodide env setup; httpx/urllib3/urllib → page-fetch transports |
| `py_gateway.py` | In-process host for the real REST app + `tui_gateway` ws dispatch; page-bridge bus (`net`/`wasi`/`pwa`/`host`/`ext` channels) |
| `bootstrap.js` | Page side: SAB ring writer (framed, fragmented, back-pressured), fetch/ws shims, vault mediation, share/embed wiring |
| `backend-worker.mjs` | Pyodide host worker; ring reader + fragment reassembly |
| `vault-worker.mjs` | Secrets boundary: AES-GCM in IndexedDB under a non-extractable device key; page sees only `vault:<handle>` tokens; scoped revocable grants |
| `plugins/hermes_browser/` | Plugin payload installed to `~/.hermes/plugins/` at boot: `wasi` + `local_host` terminal env providers, `pwa` + `browser_ext` toolsets |
| `wasi-runner.mjs` | container2wasm Debian userspace (real `bash`, coreutils) for `terminal`/`process_manage` |
| `pwa-bridge.js` | Browser-grant capability bridge (Notification, FSA, getUserMedia, Web Speech, WakeLock, periodic-sync) |
| `host-bridge.js` + `host-agent/host-agent.py` | Opt-in localhost substrate — run `python3 host-agent.py` to let the agent drive your real machine (127.0.0.1 only, token-paired, token vault-held) |
| `local-llm.js` | In-page local model endpoint (wllama/WebGPU) — agent can run fully offline from any provider |
| `embed.js` + `embed-peer.js` | One-line embeddable widget + JSON-RPC bridge, per-origin consent-gated (see `EMBEDDING.md`) |
| `sw.js` | Service worker (periodic-sync, notifications) |

## Security model

- **Secret custody**: BYOK keys, the host-agent token, and session tokens are
  stored only inside `vault-worker.mjs` (AES-GCM, non-extractable device key).
  Python code and page JS see `vault:<handle>` placeholders; resolution
  happens inside the worker at fetch time against scoped, revocable grants.
- **Origin scoping**: `embed-peer.js` requires an explicit Allow/Deny grant
  per embedder origin; the relay (`relay/`) mints sessions only from
  allowlisted origins and stores only sha256 token hashes.
- **Fixed-op substrates**: the extension protocol (`hermes-substrate-call`)
  and `host-agent.py` expose canned operations parameterized by args — never
  page-supplied code.
- **Relay is honest**: `relay/` holds in-memory socket state only. A fully
  compromised relay can drop or mangle frames but cannot mint sessions or
  reach secrets.

## Remote gateway

The tab can dial out to a rendezvous relay (`relay/` — a self-hostable
Cloudflare Worker + Durable Object, or anything speaking the same handshake).
Remote Hermes Desktop / CLI clients then reach this browser-hosted agent via
the stock remote-gateway contract (`baseUrl` + `X-Hermes-Session-Token` /
`wss` JSON-RPC). Set `window.__HERMES_RELAY_URL__` or
`localStorage['hermes.relayUrl']` to point at your relay.

## Embedding

```html
<script src="https://<your-hermes-origin>/embed.js" data-hermes></script>
```

See `EMBEDDING.md` for the API (`Hermes.mount`, `Hermes.bubble`, `call`,
`prompt`, `on('event')`) and the cross-origin-isolation requirements.

## Relationship to upstream

This is an edge deployment topology for
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
(MIT): the unmodified agent core runs under Pyodide; nothing here patches
upstream code. Complementary to the server-hosted webapp direction
(upstream PR #93508) — that hosts the backend on a server and renders in
the browser; this runs the backend *in* the browser. The substrate plugin
also works as a `~/.hermes/plugins/hermes_browser/` drop-in for any
Pyodide-hosted Hermes.

## License

MIT — see `LICENSE`. Vendored upstream components remain under their own
licenses (hermes-agent MIT; Pyodide MPL-2.0 loaded unmodified; container2wasm
Apache-2.0; @wasmer/sdk MIT).
