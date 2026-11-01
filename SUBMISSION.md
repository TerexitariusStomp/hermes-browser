# NEAR HACKATHON — submission notes

**Project**: near-hermes-browser — an autonomous agent that runs entirely
in your browser tab, holds NEAR keys it cannot leak, pays APIs and other
agents per-request under limits you set, and proves its inference ran in a
TEE.

**Tracks**: `privacy`, `security`, `agents`, `open`

**Baseline disclosure**: tag `pre-hackathon` = the disclosed baseline
(browser-runtime agent core, built pre-announcement per Q-001/Q-004).
Judged work is the in-window diff:
`compare/pre-hackathon...hackathon-submission`.

## What NEAR enables (concretely)

| Capability | NEAR piece | Where |
|---|---|---|
| Agent wallet that can't leak keys | Ed25519 keys as non-extractable WebCrypto CryptoKeys in the vault worker; grant-scoped `nearSign` | `src/vault-ops.mjs` |
| Bounded autonomy | Per-session spending policy: receiver/method allowlists, per-tx + session caps, human-confirm threshold; only the owner may write policy | `src/near-bridge.js` `enforcePolicy` |
| Pay-per-request APIs | x402 v2 `exact`: NEP-366 SignedDelegateAction for one `ft_transfer`; facilitator relays + pays gas | `near_pay` → `@fastnear/x402` + `@x402/near` |
| Agents hiring agents | A2A `SendMessage` → 402 → USDC payment → escrowed delivery on market.near.ai | `near_hire_agent` → `@a2a-js/sdk` |
| Cross-chain settlement | 1Click quotes + deposit-address execution, `dry` quotes by default | `near_intents_*` → `@fastnear/intents` |
| Verifiable private AI | Confidential-TEE models on `cloud-api.near.ai/v1`; `/v1/attestation/report` evidence + public `cloud.near.ai/verify` link | `near_attest`, provider config in `src/py_gateway.py` |
| Off-chain auth | NEP-413 `signMessage` (sign-in-with-NEAR) — also the primitive for signed intents | `near_sign_message` |

## Architecture map

```
agent (upstream Hermes core, Pyodide worker)
  └─ near_* tools            src/plugins/hermes_browser/_near.py
       └─ py_gateway.near_call → nearRequest channel (session grant rides along)
            └─ near-bridge.js  — FIXED OPS ONLY
                 ├─ VaultSigner → vault worker `nearSign` (grant-scoped)
                 │     └─ non-extractable Ed25519 CryptoKey | AES-GCM seed
                 ├─ enforcePolicy → vault `nearpolicies` (owner-written)
                 └─ SDKs: near-api-js · @fastnear/x402 · @fastnear/intents
                       · @a2a-js/sdk   (bundle: dist/vendor/near-sdk.mjs)
```

The agent's tools carry the session's broker grant; the vault refuses
signing with handles outside that session's key domain — remote share
sessions get a strict subset, never the owner's ambient authority.

## Judge steps (do X → see Y)

1. `npm install && npm run build && npm run serve` → open
   http://localhost:8471 (Chromium; COOP/COEP already set by serve.mjs).
2. Ask the agent: *"set up a NEAR key for me on testnet"* → it calls
   `near_request_grant`; a consent dialog shows the exact policy caps →
   approve → `near_status` shows a vault handle + `ed25519:` pubkey.
3. *"read vitalik.near's balance"* → `near_account` returns on-chain state.
4. *"send 0.01 NEAR to your own account"* → `near_send` inside policy →
   transaction hash returned; verify on the testnet explorer.
5. *"send 100 NEAR"* (over the session cap you approved) → structured
   `policy_denied` — the agent reports it and does not retry.
6. *"is my inference private?"* → `near_attest` returns TEE evidence +
   a `cloud.near.ai/verify?model=…` link that independently verifies.
7. (mainnet, funded) *"pay this x402 URL"* → `near_pay` settles the 402
   price via a facilitator-relayed delegate — no gas from the agent.

`tests/near-ops.test.mjs` (8 cases) proves the custody invariants under
node: grant-scoped signing, remote sessions can't reach shared keys,
revocation, imported-seed pubkey equality with near-api-js, policy
read/write authority, and key-list filtering per grant.

## Demo video script (for the X post)

0:00–0:10 One line: "This agent lives in a browser tab and holds NEAR keys
it literally cannot leak."
0:10–0:35 `near_request_grant` consent dialog → approve caps → key minted
in-vault (show `kind: cryptokey` in near_status).
0:35–1:05 Agent pays an x402-protected endpoint inside policy → result
returns; show the facilitator-settled transfer.
1:05–1:30 Ask for an over-limit spend → `policy_denied` shown → then
`near_attest` + the verify page proving TEE inference.
1:30–end Repo + hosted demo links.

## Draft X post (human publishes)

> Your AI agent shouldn't need your seed phrase to pay for things.
>
> At NEAR HACKATHON we put a full agent inside a browser tab: its NEAR key
> is a non-extractable CryptoKey it can sign with but never read, every
> spend is capped by a policy you approved, it pays APIs per-request with
> x402, hires other agents over A2A, and proves its inference ran in a TEE.
>
> Repo + live demo in the reply. What's the first thing you'd let an agent
> pay for? @NEARProtocol #NEARHackathon @NearLegion @NearBuilders

## Submission status

- [x] repo public at https://github.com/TerexitariusStomp/near-hermes-browser
- [x] `hackathon-submission` tag pushed
- [x] hosted demo: https://near-hermes-browser.pages.dev
- [ ] demo post published on X (human)
- [ ] `POST /api/applications` with human-confirmed payload (one-shot)
