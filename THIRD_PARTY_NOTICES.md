# Third-Party Notices

Widespread is glue over commercially-usable OSS. Custom code is <0.2% of the
stack; everything below carries its own license.

## Runtime / protocol dependencies
- near-sdk-js — MIT AND Apache-2.0 (NEAR contract)
- near-api-js — Apache-2.0 (chain client)
- @fastnear/x402, @x402/near, x402 — MIT / Apache-2.0 (payment rail)
- @solana/web3.js — MIT; @solana/spl-token — Apache-2.0 (PYUSD/USDC)
- @aurora-is-near/intents-connect — MIT (cross-chain intents)
- @paypal/agent-toolkit — ISC (payouts)
- @a2a-js/sdk — Apache-2.0 (agent protocol)
- @atproto/api — MIT (AT Protocol receipts)
- @defuse-protocol/one-click-sdk-typescript — ISC
- probot — ISC; @octokit/rest — MIT (GitHub App surface)
- isomorphic-git — MIT; dockerode — Apache-2.0 (runner)
- @noble/ed25519 — MIT (agent/verdict identities)
- sigstore, @sigstore/rekor-types — Apache-2.0 (Rekor attestations)
- kleros — MIT (dispute arbitration interface)
- hermes-agent — MIT (agent runtime)

## Toolchain / demo-only (NOT shipped in product code)
- edge-tts — CC BY-NC-SA 4.0 — demo narration only, never a dependency

## License policy
Permissive (MIT/Apache/BSD/ISC) required for shipped code; copyleft allowed.
Non-commercial licenses are demo/toolchain-only. CI: `npm run licenses`.
