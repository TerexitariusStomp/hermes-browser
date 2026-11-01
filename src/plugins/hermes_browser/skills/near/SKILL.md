# NEAR — spend and earn under the owner's policy

You have a `near` toolset: a NEAR wallet whose keys live inside a
browser-vault worker (non-extractable where the engine supports Ed25519
WebCrypto). You can sign transactions, delegate actions and NEP-413
messages — but you can never read, copy or export key material. Every
value-moving call is gated by a spending policy the human owner approved.

## The loop

1. `near_status` — see which key handles this session may use and which
   policy applies. If no keys exist, ask the user whether to provision one.
2. `near_request_grant` — propose a spending policy (receivers, methods,
   per-tx cap, session cap, payment cap, confirm threshold). The human sees
   the exact caps and approves or rejects in-page. A key is generated inside
   the vault and bound to your session grant.
3. Work inside the policy: `near_account`/`near_view` are free reads;
   `near_send`/`near_transfer`/`near_pay`/`near_hire_agent`/
   `near_intents_execute` are policy-gated.
4. Denials are honest limits. If a call returns `policy_denied` or
   `near_policy_unset`, report it to the user — do not retry, reshape or
   escalate. The owner can raise caps; you cannot.

## Paying for APIs and hiring agents

- `near_pay` — fetch any x402-protected URL; the 402 price is paid in
  NEP-141 tokens (USDC) via a signed delegate a facilitator relays — you
  pay no gas. Policy caps apply to the discovered price before signing.
- `near_agent_card` then `near_hire_agent` — hire a listed agent on NEAR
  Agent Market (A2A protocol); payment escrows until it delivers.
- `near_intents_quote` (dry) → `near_intents_execute` — cross-chain swap:
  the exact input goes to the quote's deposit address through the same
  policy gate.

## Private inference proof

- `near_attest` — fetch NEAR AI Cloud TEE attestation for a model and the
  public `cloud.near.ai/verify` link. Show it when the user asks whether
  their prompts are actually private.

## Things to know

- `near_sign_message` (NEP-413) proves account ownership off-chain — use it
  to authenticate to NEAR services without a transaction.
- `near_delegate` signs a meta-transaction another party relays (gasless).
- Amounts: `amount_near` is decimal NEAR; `amount`/atomic values are the
  token's smallest units (USDC has 6 decimals). Yocto conversions are done
  for you — never hand-roll units.
- Networks: `testnet` for development; `mainnet` only when the owner says
  so. Intents and Agent Market are mainnet-only.
