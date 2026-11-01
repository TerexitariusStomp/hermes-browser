# Third-party licenses

Audit of `npm` production dependencies for this repository, generated with
`license-checker-rseidelsohn` on 2026-11-01. All direct dependencies are
permissively licensed (or weak copyleft, which the project accepts); nothing
GPL/AGPL/SSPL is present. Source: 129 packages scanned.

| Package | License | Role |
|---|---|---|
| near-api-js | MIT **and** Apache-2.0 | NEAR transactions, delegate actions, NEP-413, RPC |
| @fastnear/x402 | MIT (transitive `@fastnear/borsh-schema`, `@fastnear/utils` undeclared — see note) | x402 v2 `exact` paid fetch |
| @x402/near | Apache-2.0 | x402-foundation NEAR scheme |
| @fastnear/intents | MIT (see note) | 1Click quotes, NEP-413 intent signing |
| @a2a-js/sdk | Apache-2.0 | Agent2Agent client (Agent Market hiring) |
| @noble/ed25519 | MIT | Ed25519 fallback signing + seed->pubkey derive (vendored `src/vendor/`) |
| pyodide | MPL-2.0 | In-browser Python runtime (weak copyleft — accepted) |
| @wllama/wllama | MIT | Local in-page model endpoint |
| coincident | MIT | Sync worker<->page transport |
| penpal | Apache-2.0 | Embed iframe RPC |
| idb | ISC | IndexedDB wrapper |
| partysocket | MIT | Reconnecting WebSocket (relay) |
| playwright / esbuild / fake-indexeddb | Apache-2.0 / MIT / Apache-2.0 | Dev/test only |

## Note on `@fastnear/borsh-schema` and `@fastnear/utils`

These two transitive packages publish **no license field and no LICENSE
file**; the `fastnear/js-monorepo` repository also has no root LICENSE at
audit time. Sibling packages in the same monorepo (`@fastnear/x402`,
`@fastnear/intents`, `@fastnear/api`) declare MIT. We treat this as a
documentation gap, not a restriction — the upstream intent is plainly MIT —
and have flagged it to the maintainer. If a stricter reading is required,
both packages are reachable only through the audited `@fastnear/x402` /
`@fastnear/intents` entry points and can be swapped for `near-api-js` +
`borsh` equivalents without API changes on our side.

## Vendored upstream

- `vendor/hermes-agent` — NousResearch/hermes-agent, MIT (pinned via
  `scripts/vendor.sh`; unmodified).
- `models.dev` snapshot — public model registry data (packed at build time).
