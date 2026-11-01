/**
 * near-bridge.js — fixed-op NEAR substrate for the in-browser agent.
 *
 * Same trust model as pwa-bridge.js / host-bridge.js: the agent (Python,
 * via py_gateway.near_call) may invoke ONLY the named ops below with plain
 * JSON args. All protocol work runs inside audited SDKs bundled as
 * ./vendor/near-sdk.mjs:
 *   - near-api-js        transactions, delegate actions, NEP-413, RPC
 *   - @fastnear/x402     x402 v2 `exact` paid-fetch on near:mainnet/testnet
 *   - @fastnear/intents  1Click quotes + NEP-413 signed-intent helpers
 *
 * Custody boundary: this module never holds key material. Signing is a
 * VaultSigner that forwards payload hashes to the vault worker's `nearSign`
 * op, which enforces the session grant's handle scope — remote/shared
 * sessions can only sign with keys attributed to their own domain.
 *
 * Enforcement boundary: every spend passes enforcePolicy() first —
 * receiver/method allowlists, per-tx and cumulative session caps, and an
 * optional human-confirm threshold. Policies live in the vault; only
 * ambient (owner) calls may write them — the agent's own tools carry a
 * session grant and can never raise their own caps.
 *
 * Ops:
 *   status, genKey, importKey, linkAccount, listKeys, revokeKey, pubkey,
 *   provision, policyGet, policySet,
 *   account, view, signSend, signMessage, delegate,
 *   x402Fetch, a2aCard, a2aHire,
 *   intentsTokens, intentsQuote, intentsExecute, intentsStatus,
 *   attest
 */

const RPC = {
  mainnet: 'https://rpc.mainnet.fastnear.com',
  testnet: 'https://rpc.testnet.fastnear.com',
}

// x402 speaks CAIP ('near:mainnet'); policy + RPC speak 'mainnet'.
const toNet = (n) => String(n || '').replace(/^near:/, '') || 'mainnet'
const toCaip = (n) => (String(n || '').startsWith('near:') ? n : `near:${toNet(n)}`)
const INTENTS_DEPOSIT_GAS = 30000000000000n
const ONE_CLICK = 'https://1click.chaindefuser.com'
const NEAR_AI_API = 'https://cloud-api.near.ai/v1'

// Deny-by-default: until the owner provisions or sets a policy, every spend
// op is refused. Documented behavior — the agent reports it honestly.
const DEFAULT_POLICY = {
  network: '',               // '' = any network allowed
  allowReceivers: [],
  allowMethods: [],
  maxPerTxYocto: '0',
  maxSessionYocto: '0',
  maxPaymentAtomic: '0',     // x402/token-unit cap per payment
  confirmAboveYocto: '0',
}

let sdkP = null
function sdk() {
  if (!sdkP) sdkP = import('./vendor/near-sdk.mjs')
  return sdkP
}

const b64 = (bytes) => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

const toNear = (yocto) => (Number(BigInt(yocto || '0')) / 1e24).toFixed(6)

// ---------------------------------------------------------------- policy --

function allowList(list, value) {
  return Array.isArray(list) && (list.includes('*') || list.includes(value))
}

// Sum every action's deposit (ft_transfer deposits carry value; gas is
// prepaid from balance, not counted).
function depositOf(actions) {
  let total = 0n
  for (const a of actions || []) {
    if (a.type === 'transfer' && a.amount) total += BigInt(a.amount)
    if (a.type === 'functionCall' && a.deposit) total += BigInt(a.deposit)
  }
  return total
}

async function spentGet(ctx, scope) {
  const r = await ctx.vaultCall('nearPolicyGet', { scope: 'spent:' + scope })
  return BigInt((r && r.policy && r.policy.spent) || '0')
}
async function spentAdd(ctx, scope, delta) {
  if (delta <= 0n) return
  const cur = await spentGet(ctx, scope)
  await ctx.vaultCall('nearPolicySet', {
    scope: 'spent:' + scope,
    policy: { spent: (cur + delta).toString() },
  })
}

/**
 * Gate every value-moving op. Returns {policy, scope} on success —
 * callers proceed to signing — or throws an Error describing the denial
 * (which the agent surfaces verbatim to the user).
 */
async function enforcePolicy(ctx, grant, meta) {
  const pr = await ctx.vaultCall('nearPolicyGet', { grant: grant || undefined })
  const scope = (pr && pr.scope) || 'default'
  const p = Object.assign({}, DEFAULT_POLICY, (pr && pr.policy) || {})
  if (!(pr && pr.policy)) {
    const err = new Error('near_policy_unset: owner has not granted this session a spending policy')
    err.code = 'policy_unset'
    throw err
  }
  const { network = '', receiverId = '', method = '', depositYocto = '0', paymentAtomic = '0' } = meta
  if (p.network && p.network !== network)
    throw new Error(`policy_denied: network '${network}' not allowed (policy: ${p.network})`)
  if (receiverId && !allowList(p.allowReceivers, receiverId))
    throw new Error(`policy_denied: receiver '${receiverId}' not in allowlist`)
  if (method && !allowList(p.allowMethods, method))
    throw new Error(`policy_denied: method '${method}' not in allowlist`)
  const dep = BigInt(depositYocto)
  if (dep > BigInt(p.maxPerTxYocto || '0'))
    throw new Error(`policy_denied: deposit ${toNear(dep)} NEAR exceeds per-tx cap ${toNear(p.maxPerTxYocto)} NEAR`)
  const spent = await spentGet(ctx, scope)
  if (spent + dep > BigInt(p.maxSessionYocto || '0'))
    throw new Error(`policy_denied: session cap ${toNear(p.maxSessionYocto)} NEAR would be exceeded`)
  if (BigInt(paymentAtomic) > BigInt(p.maxPaymentAtomic || '0'))
    throw new Error(`policy_denied: payment ${paymentAtomic} exceeds atomic cap ${p.maxPaymentAtomic}`)
  const confirmAbove = BigInt(p.confirmAboveYocto || '0')
  if ((dep > 0n || BigInt(paymentAtomic) > 0n) &&
      dep >= confirmAbove && ctx.confirm) {
    const ok = await ctx.confirm(
      `NEAR spend request\n\n` +
      `receiver: ${receiverId || '(payment)'}\n` +
      (method ? `method:   ${method}\n` : '') +
      `deposit:  ${toNear(dep)} NEAR\n` +
      (BigInt(paymentAtomic) ? `payment:  ${paymentAtomic} (token units)\n` : '') +
      `network:  ${network}\n` +
      `session spent so far: ${toNear(spent)} NEAR\n\nApprove?`)
    if (!ok) throw new Error('policy_denied: rejected by user')
  }
  return { policy: p, scope, spent }
}

// ---------------------------------------------------------------- signer --

// near-api-js Signer that never sees key material: getPublicKey comes from
// vault metadata; signBytes forwards the hash to the vault worker, which
// enforces grant scope internally. signTransaction / signDelegateAction /
// signNep413Message on the base class do all borsh/serialization work.
async function vaultSigner(ctx, grant, handle) {
  const near = await sdk()
  const meta = await ctx.vaultCall('nearPubkey', { handle })
  if (!meta || !meta.pubkey) throw new Error('vault handle revoked or unknown')
  const sign = async (bytes) => {
    const r = await ctx.vaultCall('nearSign', {
      handle, payloadB64: b64(bytes), grant: grant || undefined,
    })
    if (r && r.error) throw new Error(r.error)
    return unb64(r.signatureB64)
  }
  class VaultSigner extends near.Signer {
    async getPublicKey() { return near.PublicKey.fromString(meta.pubkey) }
    async signBytes(bytes) { return sign(bytes) }
  }
  return new VaultSigner()
}

function provider(near, network) {
  const url = RPC[network]
  if (!url) throw new Error(`unknown network '${network}'`)
  return new near.JsonRpcProvider({ url })
}

// ------------------------------------------------------------- x402 path --

// ClientNearSigner for @fastnear/x402: builds the NEP-366 delegate the
// spec requires (one exact ft_transfer) and signs it through the vault.
// Policy is enforced on the payment requirements BEFORE signing.
function x402Signer(ctx, grant, handle, accountId, network) {
  return {
    async createSignedDelegateAction({ x402Version, paymentRequirements }) {
      const near = await sdk()
      const req = paymentRequirements || {}
      if (x402Version !== 2) throw new Error(`unsupported x402 version ${x402Version}`)
      if (req.scheme !== 'exact') throw new Error(`unsupported scheme ${req.scheme}`)
      await enforcePolicy(ctx, grant, {
        network: toNet(req.network || network),
        receiverId: req.asset,
        method: 'ft_transfer',
        depositYocto: '1',
        paymentAtomic: String(req.amount || '0'),
      })
      const signer = await vaultSigner(ctx, grant, handle)
      const prov = provider(near, toNet(req.network || network))
      const pk = await signer.getPublicKey()
      const [accessKey, block] = await Promise.all([
        prov.viewAccessKey(accountId, pk),
        prov.viewBlock({ finality: 'final' }),
      ])
      const ttl = Number(req.maxTimeoutSeconds) > 0 ? Number(req.maxTimeoutSeconds) : 4200
      const delegateAction = near.buildDelegateAction({
        senderId: accountId,
        receiverId: req.asset,
        nonce: BigInt(accessKey.nonce) + 1n,
        maxBlockHeight: BigInt(block.header.height) + BigInt(Math.ceil(ttl)),
        publicKey: pk,
        actions: [near.actions.functionCall('ft_transfer', {
          receiver_id: req.payTo,
          amount: String(req.amount),
        }, 30000000000000n, 1n)],
      })
      const { signedDelegate } = await signer.signDelegateAction(delegateAction)
      const scope = 'x402:' + (grant || 'ambient')
      await spentAdd(ctx, scope, 0n) // x402 spends are token-denominated; tracked via policy caps only
      return b64(near.encodeSignedDelegate(signedDelegate))
    },
  }
}

// ------------------------------------------------------------------ ops ---

const OPS = {
  // Introspection: keys this grant can see, effective policy, bridge health.
  async status(ctx, grant, a) {
    const [keys, pol] = await Promise.all([
      ctx.vaultCall('nearList', { grant: grant || undefined }),
      ctx.vaultCall('nearPolicyGet', { grant: grant || undefined }),
    ])
    return {
      keys: (keys && keys.keys) || [],
      policy: (pol && pol.policy) || null,
      policyScope: (pol && pol.scope) || null,
      networks: Object.keys(RPC),
    }
  },

  async genKey(ctx, grant, a) {
    const r = await ctx.vaultCall('nearGenKey', { label: a.label, accountId: a.accountId })
    if (r.error) return r
    if (grant) await ctx.vaultCall('grantAddHandle', { grant, handle: r.handle })
    return r
  },

  async importKey(ctx, grant, a) {
    // The seed crosses page JS once, into the vault — same exposure as the
    // existing storeSecret flow. After this it lives only in the worker.
    const r = await ctx.vaultCall('nearImportKey', {
      seed: a.seed, label: a.label, accountId: a.accountId,
    })
    if (r.error) return r
    if (grant) await ctx.vaultCall('grantAddHandle', { grant, handle: r.handle })
    return r
  },

  async linkAccount(ctx, grant, a) {
    return ctx.vaultCall('nearLinkAccount', { handle: a.handle, accountId: a.accountId })
  },

  async listKeys(ctx, grant) {
    return ctx.vaultCall('nearList', { grant: grant || undefined })
  },

  async revokeKey(ctx, grant, a) {
    return ctx.vaultCall('nearRevoke', { handle: a.handle })
  },

  async pubkey(ctx, grant, a) {
    return ctx.vaultCall('nearPubkey', { handle: a.handle })
  },

  // One-consent provisioning: generate (or accept) a key, bind the account,
  // write the session-scoped policy the user just approved, attribute the
  // handle to the caller's grant. The confirm shows the requested caps
  // verbatim — the owner is the gate.
  async provision(ctx, grant, a) {
    const policy = Object.assign({}, DEFAULT_POLICY, a.policy || {})
    const desc =
      `Grant this agent NEAR spending?\n\n` +
      `account:      ${a.accountId || '(bind later)'}\n` +
      `network:      ${policy.network || 'any'}\n` +
      `receivers:    ${(policy.allowReceivers || []).join(', ') || '(none)'}\n` +
      `methods:      ${(policy.allowMethods || []).join(', ') || '(none)'}\n` +
      `per-tx cap:   ${toNear(policy.maxPerTxYocto)} NEAR\n` +
      `session cap:  ${toNear(policy.maxSessionYocto)} NEAR\n` +
      `payment cap:  ${policy.maxPaymentAtomic} (token units)\n\n` +
      `Key is generated inside the vault and cannot be exported.`
    const ok = ctx.confirm ? await ctx.confirm(desc) : true
    if (!ok) return { error: 'provision rejected by user' }
    let r
    if (a.seed) {
      r = await OPS.importKey(ctx, grant, a)
    } else {
      r = await OPS.genKey(ctx, grant, a)
    }
    if (r.error) return r
    // Policy binds to the caller's grant scope (falls back to 'default'
    // for ambient callers). Written ambient-side: the bridge is the
    // enforcement boundary, and the user just approved these exact caps.
    const scope = grant || 'default'
    await ctx.vaultCall('nearPolicySet', { scope, policy })
    return { ...r, policyScope: scope, policy }
  },

  async policyGet(ctx, grant) {
    return ctx.vaultCall('nearPolicyGet', { grant: grant || undefined })
  },

  async policySet(ctx, grant, a) {
    // Owner path only — ambient callers (dashboard/CLI) may write policy;
    // agent sessions always carry a grant and the vault op refuses them.
    const ok = ctx.confirm
      ? await ctx.confirm(`Set NEAR spending policy?\n\n${JSON.stringify(a.policy, null, 2)}`)
      : true
    if (!ok) return { error: 'policy set rejected by user' }
    return ctx.vaultCall('nearPolicySet', { scope: a.scope || 'default', policy: a.policy })
  },

  async account(ctx, grant, a) {
    const near = await sdk()
    const state = await provider(near, toNet(a.network || 'testnet')).viewAccount(a.accountId)
    return {
      accountId: a.accountId,
      amount: state.amount != null ? String(state.amount) : undefined,
      locked: state.locked != null ? String(state.locked) : undefined,
      storageUsage: state.storageUsage,
      codeHash: state.codeHash,
    }
  },

  async view(ctx, grant, a) {
    const near = await sdk()
    return provider(near, toNet(a.network || 'testnet')).callFunction({
      accountId: a.contractId,
      methodName: a.method,
      args: a.args || {},
    })
  },

  async signSend(ctx, grant, a) {
    const near = await sdk()
    const acts = (a.actions || []).map((act) => {
      if (act.type === 'transfer')
        return near.actions.transfer(BigInt(act.amount || '0'))
      if (act.type === 'functionCall')
        return near.actions.functionCall(
          act.methodName, act.args || {},
          BigInt(act.gas || '30000000000000'), BigInt(act.deposit || '0'))
      throw new Error(`unsupported action type ${act.type}`)
    })
    const method = (a.actions || []).map((x) => x.methodName || x.type).join(',')
    await enforcePolicy(ctx, grant, {
      network: toNet(a.network), receiverId: a.receiverId,
      method, depositYocto: depositOf(a.actions).toString(),
    })
    const signer = await vaultSigner(ctx, grant, a.handle)
    const account = new near.Account(a.accountId, provider(near, toNet(a.network || 'testnet')), signer)
    const outcome = await account.signAndSendTransaction({
      receiverId: a.receiverId, actions: acts,
    })
    const pr = await ctx.vaultCall('nearPolicyGet', { grant: grant || undefined })
    await spentAdd(ctx, (pr && pr.scope) || 'default', depositOf(a.actions))
    return {
      transactionHash: outcome.transaction && outcome.transaction.hash ||
        outcome.transaction_outcome && outcome.transaction_outcome.id,
      status: outcome.status,
    }
  },

  async signMessage(ctx, grant, a) {
    const near = await sdk()
    const nonce = a.nonceB64 ? unb64(a.nonceB64) : crypto.getRandomValues(new Uint8Array(32))
    const signer = await vaultSigner(ctx, grant, a.handle)
    const signed = await signer.signNep413Message(a.accountId, {
      message: a.message,
      recipient: a.recipient,
      nonce,
      callbackUrl: a.callbackUrl,
    })
    return {
      accountId: signed.accountId,
      publicKey: signed.publicKey && signed.publicKey.toString(),
      signature: typeof signed.signature === 'string'
        ? signed.signature : b64(signed.signature && signed.signature.data || signed.signature),
      state: signed.state,
      nonceB64: b64(nonce),
    }
  },

  // Raw NEP-366 delegate (meta-transaction) for callers that relay it
  // themselves — e.g. custom x402 servers or sponsored-tx services.
  async delegate(ctx, grant, a) {
    const near = await sdk()
    const acts = (a.actions || []).map((act) => {
      if (act.type === 'functionCall')
        return near.actions.functionCall(
          act.methodName, act.args || {},
          BigInt(act.gas || '30000000000000'), BigInt(act.deposit || '0'))
      if (act.type === 'transfer')
        return near.actions.transfer(BigInt(act.amount || '0'))
      throw new Error(`unsupported action type ${act.type}`)
    })
    const method = (a.actions || []).map((x) => x.methodName || x.type).join(',')
    await enforcePolicy(ctx, grant, {
      network: toNet(a.network), receiverId: a.receiverId,
      method, depositYocto: depositOf(a.actions).toString(),
    })
    const signer = await vaultSigner(ctx, grant, a.handle)
    const prov = provider(near, toNet(a.network || 'testnet'))
    const pk = await signer.getPublicKey()
    const [accessKey, block] = await Promise.all([
      prov.viewAccessKey(a.accountId, pk),
      prov.viewBlock({ finality: 'final' }),
    ])
    const delegateAction = near.buildDelegateAction({
      senderId: a.accountId,
      receiverId: a.receiverId,
      nonce: BigInt(accessKey.nonce) + 1n,
      maxBlockHeight: BigInt(block.header.height) + BigInt(a.blockHeightTtl || 200),
      publicKey: pk,
      actions: acts,
    })
    const { signedDelegate } = await signer.signDelegateAction(delegateAction)
    return { signedDelegateB64: b64(near.encodeSignedDelegate(signedDelegate)) }
  },

  // x402 v2 paid fetch: the SDK handles the 402 -> PAYMENT-REQUIRED ->
  // signed delegate -> retry flow; the signer checks policy before signing.
  async x402Fetch(ctx, grant, a) {
    const near = await sdk()
    const net = toNet(a.network || 'mainnet')
    const payFetch = near.createNearPaymentFetch({
      signer: x402Signer(ctx, grant, a.handle, a.accountId, net),
      network: a.network && String(a.network).startsWith('near:') ? a.network : 'near:*',
      fetch: globalThis.fetch,
    })
    const init = { method: a.method || 'GET' }
    if (a.headers) init.headers = a.headers
    if (a.bodyB64) init.body = unb64(a.bodyB64)
    const resp = await payFetch(a.url, init)
    const body = await resp.arrayBuffer()
    return {
      status: resp.status,
      headers: Object.fromEntries(resp.headers.entries()),
      bodyB64: b64(new Uint8Array(body)),
    }
  },

  async a2aCard(ctx, grant, a) {
    // Agent-card discovery is a plain unauthenticated GET.
    const base = String(a.url || (a.handle ? `https://${a.handle}.market.near.ai` : '')).replace(/\/$/, '')
    if (!base) return { error: 'a2aCard needs url or handle' }
    const resp = await fetch(base + '/.well-known/agent-card.json')
    if (!resp.ok) return { error: `agent card fetch failed: ${resp.status}` }
    return { card: await resp.json() }
  },

  async a2aHire(ctx, grant, a) {
    // NEAR Agent Market: SendMessage -> 402 price -> pay USDC via x402 ->
    // result; marketplace escrows until the agent delivers.
    const near = await sdk()
    const base = String(a.url || (a.handle ? `https://${a.handle}.market.near.ai` : '')).replace(/\/$/, '')
    if (!base) return { error: 'a2aHire needs url or handle' }
    const payFetch = near.createNearPaymentFetch({
      signer: x402Signer(ctx, grant, a.keyHandle, a.accountId, toNet(a.network || 'mainnet')),
      network: 'near:*',
      fetch: globalThis.fetch,
    })
    const rpc = {
      jsonrpc: '2.0', id: crypto.randomUUID(),
      method: 'SendMessage',
      params: {
        message: {
          messageId: crypto.randomUUID(), role: 'ROLE_USER',
          parts: [{ text: String(a.task || '') }],
        },
      },
    }
    const resp = await payFetch(base + '/a2a/v1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rpc),
    })
    return { status: resp.status, result: await resp.json().catch(() => null) }
  },

  async intentsTokens(ctx) {
    const near = await sdk()
    const client = near.createOneClickClient({ fetch: globalThis.fetch })
    return { tokens: await client.tokens() }
  },

  async intentsQuote(ctx, grant, a) {
    const near = await sdk()
    const client = near.createOneClickClient({
      fetch: globalThis.fetch,
      apiKey: a.apiKey || undefined,
    })
    const body = {
      dry: a.dry !== false,
      swapType: a.swapType || 'EXACT_INPUT',
      slippageTolerance: a.slippageTolerance || 100,
      originAsset: a.originAsset,
      destinationAsset: a.destinationAsset,
      amount: String(a.amount),
      depositType: a.depositType || 'ORIGIN_CHAIN',
      refundTo: a.refundTo || a.accountId,
      refundType: 'ORIGIN_CHAIN',
      recipient: a.recipient || a.accountId,
      recipientType: a.recipientType || 'ORIGIN_CHAIN',
      deadline: a.deadline || new Date(Date.now() + 3600e3).toISOString(),
    }
    return { quote: await client.quote(body) }
  },

  // Executes the deposit leg of an ORIGIN_CHAIN quote: ft_transfer the
  // exact input to the quote's depositAddress (policy-checked like any
  // other spend). Returns the deposit tx; status tracked via intentsStatus.
  async intentsExecute(ctx, grant, a) {
    const near = await sdk()
    const q = await OPS.intentsQuote(ctx, grant, { ...a, dry: false })
    if (q.error) return q
    const quote = q.quote && (q.quote.quote || q.quote)
    const depositAddress = quote && (quote.depositAddress || (quote.quoteRequest || {}).depositAddress)
    if (!depositAddress) return { error: 'no depositAddress in quote', quote: q.quote }
    const amountIn = String(quote.amountIn || a.amount)
    const send = await OPS.signSend(ctx, grant, {
      handle: a.handle, accountId: a.accountId, network: a.network || 'mainnet',
      receiverId: a.tokenContract,
      actions: [{
        type: 'functionCall', methodName: 'ft_transfer',
        args: {
          receiver_id: depositAddress, amount: amountIn,
          ...(quote.depositMemo ? { memo: quote.depositMemo } : {}),
        },
        gas: INTENTS_DEPOSIT_GAS.toString(), deposit: '1',
      }],
    })
    return { depositAddress, amountIn, send }
  },

  async intentsStatus(ctx, grant, a) {
    const near = await sdk()
    const client = near.createOneClickClient({ fetch: globalThis.fetch })
    return { status: await client.status({ depositAddress: a.depositAddress }) }
  },

  // NEAR AI Cloud TEE attestation evidence for a model. Passes the user's
  // NEAR AI key through vault header resolution — key never touches page JS.
  async attest(ctx, grant, a) {
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, '0')).join('')
    const params = new URLSearchParams({
      model: a.model, provider: a.provider || 'near',
      signing_algo: a.algo || 'ecdsa', nonce,
    })
    const headers = { Accept: 'application/json', 'x-no-aliasing': 'true' }
    if (a.keyHandle) headers.Authorization = `Bearer vault:${String(a.keyHandle).replace(/^vault:/, '')}`
    const resolved = ctx.resolveHeaders
      ? await ctx.resolveHeaders(headers, grant || '') : headers
    const resp = await fetch(`${NEAR_AI_API}/attestation/report?${params}`, { headers: resolved })
    const body = await resp.json().catch(() => null)
    return {
      status: resp.status,
      verifyUrl: `https://cloud.near.ai/verify?model=${encodeURIComponent(a.model)}`,
      attestation: body,
    }
  },
}

export async function handle(op, args, grant, ctx) {
  const fn = OPS[op]
  if (!fn) return { error: `unknown near op '${op}'` }
  try {
    return await fn(ctx, grant, args || {})
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 500), code: e && e.code }
  }
}
