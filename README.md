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

## NEAR HACKATHON submission

Tracks: **Privacy & Private AI**, **AI Security & Defense**, **Agent
Economy**, **Open Innovation**. Live demo:
**https://near-hermes-browser.pages.dev** (no install — the agent runs in
the tab).

Everything above the `pre-hackathon` tag is the in-window submission; the
browser-runtime agent core is disclosed baseline (built earlier, see
[the diff](https://github.com/TerexitariusStomp/near-hermes-browser/compare/pre-hackathon...hackathon-submission)).
Built on NEAR in-window:

- **Agent money the owner controls** (`near` toolset, `src/near-bridge.js`,
  `src/vault-ops.mjs`): NEAR keys are generated/imported into a vault worker
  as **non-extractable WebCrypto Ed25519 CryptoKeys** — the agent can sign
  transactions, NEP-366 delegate actions and NEP-413 messages but can never
  read the key. Every spend passes a per-session **spending policy** the
  human approves verbatim: receiver/method allowlists, per-tx and session
  caps, and a human-confirm threshold. Sessions are separate key domains —
  a remote/shared session cannot touch another session's keys.
- **Agent commerce**: `near_pay` runs x402 v2 `exact` on
  `near:mainnet`/`near:testnet` (NEP-366 delegate + facilitator-settled
  NEP-141 payment — the agent pays APIs per request); `near_hire_agent`
  hires listed agents on NEAR Agent Market over A2A+x402 with escrow;
  `near_intents_*` drives 1Click quotes and deposit settlement.
- **Private inference, verifiable**: `near-ai-cloud` is a first-class
  provider (`https://cloud-api.near.ai/v1`, Confidential-TEE models ≥64K
  ctx); `near_attest` fetches TEE attestation evidence and the public
  `cloud.near.ai/verify` link — proof, not claims.
- **Composed from audited OSS** — near-api-js, @fastnear/x402 + @x402/near,
  @fastnear/intents, @a2a-js/sdk (all MIT/Apache, see `LICENSES.md`); new
  code is glue only: the vault signer adapter, policy table, tool schemas,
  consent UI (~1.5k lines vs. ~1M LOC of upstream+deps).

Try it: `npm install && npm run build && npm run serve` →
http://localhost:8471 → ask the agent "status" → it calls `near_status`,
proposes a policy, you approve caps in-page, then `near_send` /
`near_pay` / `near_hire_agent` work inside them. See `SUBMISSION.md` for
the demo script and judge steps.

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
| `bootstrap.js` | Page side: coincident transport, fetch/ws shims, vault mediation, grant binding, share/embed wiring |
| `backend-worker.mjs` | Pyodide host worker; `pullInbound` frame pump + sync proxy calls into the page |
| `vault-worker.mjs` | Secrets boundary transport wrapper — ops live in `vault-ops.mjs` |
| `vault-ops.mjs` | Vault logic: AES-GCM in IndexedDB under a non-extractable device key; page sees only `vault:<handle>` tokens; scoped revocable grants with parent-chain resolution |
| `plugins/hermes_browser/` | Plugin payload installed to `~/.hermes/plugins/` at boot: `wasi` + `local_host` terminal env providers, `pwa` + `browser_ext` toolsets |
| `wasi-runner.mjs` | container2wasm Debian userspace (real `bash`, coreutils) for `terminal`/`process_manage` |
| `pwa-bridge.js` | Browser-grant capability bridge (Notification, FSA, getUserMedia, Web Speech, WakeLock, periodic-sync) |
| `host-bridge.js` + `host-agent/host-agent.py` | Opt-in localhost substrate — run `python3 host-agent.py` to let the agent drive your real machine (127.0.0.1 only, token-paired, token vault-held) |
| `local-llm.js` | In-page local model endpoint (wllama/WebGPU) — agent can run fully offline from any provider. Ships a **patched wllama wasm** — built from `wllama-src/` (ngxson/wllama@3.6.1 + llama.cpp@83d855c fork) with added `save_state`/`load_state` glue actions that round-trip `server_prompt_cache_state` for KV persistence. The fork also clamps `cache_ram_mib` to 128 MiB, disables context checkpoints (each pins a full KV copy — fatal in wasm32 at long prompts), and refuses to serialize states over 192 MiB: wasm32 heap is ~4 GiB total, so prompts whose KV state exceeds the remaining headroom skip persistence and degrade to boot priming rather than aborting the worker mid-request. Verified envelope: snapshots round-trip at ~3K-token prefixes (51 MiB state; turn 1 after reload: `prompt_n=6, cache_n=3039, prompt_ms=226`); at ~10K tokens the request itself completes normally with in-session KV reuse (`cache_n=10039`) and reload falls back to `prime()`. A plain `npm install` reverts it; rebuild via `wllama-src/scripts/build_wasm.sh` then copy `esm/index.js` + `esm/wasm/wllama.wasm` into `node_modules/@wllama/wllama/` before assembling. |
| `embed.js` + `embed-peer.js` | One-line embeddable widget + JSON-RPC bridge, per-origin consent-gated (see `EMBEDDING.md`) |
| `sw.js` | Service worker (periodic-sync, notifications) |

## Security model

- **Secret custody**: BYOK keys, the host-agent token, and session tokens are
  stored only inside `vault-ops.mjs`'s IndexedDB stores (AES-GCM,
  non-extractable device key). Python code and page JS see `vault:<handle>`
  placeholders; resolution happens inside the worker at fetch time against
  scoped, revocable grants.
- **Sessions are key domains**: each `session.create` mints a grant parented
  to the "shared" tier (secrets written outside a session context). A secret
  written inside a session is attributed to that session's grant only — no
  other session resolves it. Remote share sessions sub-grant under the share
  broker and can never climb into the local secret domain.
- **Origin scoping**: `embed-peer.js` requires an explicit Allow/Deny grant
  per embedder origin; the relay (`relay/`) mints sessions only from
  allowlisted origins and stores only sha256 token hashes.
- **Fixed-op substrates**: the extension protocol (`hermes-substrate-call`)
  and `host-agent.py` expose canned operations parameterized by args — never
  page-supplied code.
- **Relay is honest**: `relay/` holds in-memory socket state only. A fully
  compromised relay can drop or mangle frames but cannot mint sessions or
  reach secrets. With an E2E client (`/api/e2e-ws`, `POST /api/e2e`, or the
  `e2e-shim.mjs` loopback front for stock clients) the relay sees only
  AES-GCM ciphertext — the key ships in the share URL's `#k=` fragment and
  never transits the wire.

## Remote gateway

The tab can dial out to a rendezvous relay (`relay/` — a self-hostable
Cloudflare Worker + Durable Object, or anything speaking the same handshake).
Remote Hermes Desktop / CLI clients then reach this browser-hosted agent via
the stock remote-gateway contract (`baseUrl` + `X-Hermes-Session-Token` /
`wss` JSON-RPC). Set `window.__HERMES_RELAY_URL__` or
`localStorage['hermes.relayUrl']` to point at your relay.

`startShare` returns both the stock `baseUrl`/`token` and an E2E `shareUrl`
(key in the `#k=` fragment). For relay-blind sharing, run
`node relay/scripts/e2e-shim.mjs "<shareUrl>"` on the client machine — it
serves the stock gateway surface on loopback, encrypting both directions so
the relay pipes ciphertext only. Stock clients pointed at `baseUrl` directly
still work in plaintext.

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
