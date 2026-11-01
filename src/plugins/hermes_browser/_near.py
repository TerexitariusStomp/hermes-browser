"""near toolset — NEAR wallet, payments and private inference for the
in-browser agent.

Every tool maps 1:1 to a fixed op in the page-side near-bridge (see
``src/near-bridge.js``): audited SDKs (near-api-js, @fastnear/x402,
@fastnear/intents) do the protocol work; signing runs inside the vault
worker under the caller's session grant; every value-moving op is gated by
the owner-set spending policy (allowlists, per-tx and session caps,
human-confirm threshold). Keys are non-extractable where the browser
supports WebCrypto Ed25519 — the agent can sign but can never read, leak
or export the key material.

Tools return JSON strings per upstream registry contract. ``check_fn``
answers reachability only: does the page-side near bridge respond.
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any, Callable, Dict

TOOLSET = "near"


def _bridge() -> Callable[..., Dict[str, Any]]:
    import py_gateway

    return py_gateway.near_call


def bridge_present() -> bool:
    """check_fn: True only when the page-side near bridge answers."""
    try:
        resp = _bridge()("status", timeout_s=8.0)
        return isinstance(resp, dict) and not resp.get("error")
    except Exception:
        return False


def _call(op: str, args: Dict[str, Any], timeout_s: float = 120.0) -> str:
    try:
        resp = _bridge()(op, args, timeout_s=timeout_s)
    except Exception as err:
        return json.dumps({"success": False, "error": f"bridge_unreachable: {err}"})
    if not isinstance(resp, dict):
        return json.dumps({"success": False, "error": "bridge_bad_response"})
    if resp.get("error"):
        return json.dumps({"success": False, "error": resp["error"]})
    return json.dumps({"success": True, **resp})


def _yocto(near_amount: Any) -> str:
    """NEAR decimal -> yocto string. Accepts str/float/int."""
    return str(int(Decimal(str(near_amount)) * Decimal(10) ** 24))


_POLICY_PROPS = {
    "network": {"type": "string", "description": "'mainnet' or 'testnet'; omit for either"},
    "allow_receivers": {"type": "array", "items": {"type": "string"},
                        "description": "Account/contract ids the agent may pay or call; '*' for any"},
    "allow_methods": {"type": "array", "items": {"type": "string"},
                      "description": "Contract methods allowed; '*' for any"},
    "max_per_tx_near": {"type": "string",
                        "description": "Max NEAR deposit per transaction, decimal NEAR"},
    "max_session_near": {"type": "string",
                         "description": "Max cumulative NEAR spend this session, decimal NEAR"},
    "max_payment_atomic": {"type": "string",
                           "description": "Max x402/token payment in the token's atomic units"},
    "confirm_above_near": {"type": "string",
                           "description": "Deposits at/above this NEAR amount need an in-page human confirm"},
}


def _policy_args(a: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "network": a.get("network", ""),
        "allowReceivers": a.get("allow_receivers", []),
        "allowMethods": a.get("allow_methods", []),
        "maxPerTxYocto": _yocto(a.get("max_per_tx_near", "0")),
        "maxSessionYocto": _yocto(a.get("max_session_near", "0")),
        "maxPaymentAtomic": str(a.get("max_payment_atomic", "0")),
        "confirmAboveYocto": _yocto(a.get("confirm_above_near", "0")),
    }


_ACTIONS_DESC = (
    "List of actions. Transfer: {\"type\":\"transfer\",\"amount_near\":\"0.1\"}. "
    "Function call: {\"type\":\"functionCall\",\"method\":\"m\",\"args\":{...},"
    "\"gas_tgas\":30,\"deposit_near\":\"0\"}."
)


def _actions(a: Dict[str, Any]) -> Dict[str, Any]:
    out = []
    for act in a.get("actions") or []:
        t = act.get("type")
        if t == "transfer":
            amt = act.get("amount_yocto") or _yocto(act.get("amount_near", "0"))
            out.append({"type": "transfer", "amount": amt})
        elif t == "functionCall":
            out.append({
                "type": "functionCall",
                "methodName": act.get("method") or act.get("methodName", ""),
                "args": act.get("args") or {},
                "gas": str(int(Decimal(str(act.get("gas_tgas", 30))) * Decimal(10) ** 12)),
                "deposit": act.get("deposit_yocto") or _yocto(act.get("deposit_near", "0")),
            })
    return {**a, "actions": out}


_SCHEMAS: Dict[str, Dict[str, Any]] = {
    "near_status": {
        "name": "near_status",
        "description": "NEAR bridge health: which vault key handles this session can use, "
                       "the effective spending policy, and supported networks. Call first.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "near_request_grant": {
        "name": "near_request_grant",
        "description": "Provision a NEAR key inside the vault and ask the human to approve a "
                       "spending policy for this session. The key is generated inside the "
                       "vault worker (non-extractable where the browser supports it) — the "
                       "agent can sign but can never read the key. The user sees the exact "
                       "caps and must approve.",
        "parameters": {"type": "object", "properties": {
            "account_id": {"type": "string", "description": "NEAR account to bind (optional)"},
            "policy": {"type": "object", "properties": _POLICY_PROPS},
        }, "required": []},
    },
    "near_link_account": {
        "name": "near_link_account",
        "description": "Bind a NEAR account id to a vault key handle.",
        "parameters": {"type": "object", "properties": {
            "handle": {"type": "string"}, "account_id": {"type": "string"},
        }, "required": ["handle", "account_id"]},
    },
    "near_account": {
        "name": "near_account",
        "description": "Read an account's on-chain state (balance, storage, code hash).",
        "parameters": {"type": "object", "properties": {
            "account_id": {"type": "string"},
            "network": {"type": "string", "description": "'mainnet'|'testnet' (default testnet)"},
        }, "required": ["account_id"]},
    },
    "near_view": {
        "name": "near_view",
        "description": "Call a read-only contract view method. Free, unsigned, no policy needed.",
        "parameters": {"type": "object", "properties": {
            "contract_id": {"type": "string"},
            "method": {"type": "string"},
            "args": {"type": "object"},
            "network": {"type": "string"},
        }, "required": ["contract_id", "method"]},
    },
    "near_send": {
        "name": "near_send",
        "description": "Sign and broadcast a transaction (transfers and/or contract calls). "
                       "Policy-gated: receiver/method allowlists, per-tx and session caps, "
                       "human confirm above the owner's threshold. Out-of-policy returns a "
                       "structured denial — report it, do not retry unchanged. " + _ACTIONS_DESC,
        "parameters": {"type": "object", "properties": {
            "handle": {"type": "string", "description": "vault key handle from near_status"},
            "account_id": {"type": "string"},
            "receiver_id": {"type": "string"},
            "actions": {"type": "array", "items": {"type": "object"}},
            "network": {"type": "string"},
        }, "required": ["handle", "account_id", "receiver_id", "actions"]},
    },
    "near_transfer": {
        "name": "near_transfer",
        "description": "Send NEAR to an account (single transfer). Same policy gate as near_send.",
        "parameters": {"type": "object", "properties": {
            "handle": {"type": "string"}, "account_id": {"type": "string"},
            "to": {"type": "string"}, "amount_near": {"type": "string"},
            "network": {"type": "string"},
        }, "required": ["handle", "account_id", "to", "amount_near"]},
    },
    "near_sign_message": {
        "name": "near_sign_message",
        "description": "NEP-413 off-chain message signature — 'sign in with NEAR' auth for "
                       "services, and the primitive for signed intent execution. No gas, "
                       "no broadcast. Still grant-scoped: only this session's keys sign.",
        "parameters": {"type": "object", "properties": {
            "handle": {"type": "string"}, "account_id": {"type": "string"},
            "message": {"type": "string"}, "recipient": {"type": "string"},
            "callback_url": {"type": "string"},
        }, "required": ["handle", "account_id", "message", "recipient"]},
    },
    "near_delegate": {
        "name": "near_delegate",
        "description": "Sign a NEP-366 delegate action (meta-transaction) without broadcasting — "
                       "a relayer submits it and pays gas. Policy-gated like near_send.",
        "parameters": {"type": "object", "properties": {
            "handle": {"type": "string"}, "account_id": {"type": "string"},
            "receiver_id": {"type": "string"},
            "actions": {"type": "array", "items": {"type": "object"}},
            "block_height_ttl": {"type": "integer"},
            "network": {"type": "string"},
        }, "required": ["handle", "account_id", "receiver_id", "actions"]},
    },
    "near_pay": {
        "name": "near_pay",
        "description": "Fetch an x402-protected URL and pay the 402 price in NEP-141 tokens "
                       "(usually USDC) with a vault-signed delegate — a facilitator relays it "
                       "and pays gas. The agent-commerce primitive: pay APIs per request. "
                       "Policy-gated on the discovered price before signing.",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string"},
            "method": {"type": "string", "description": "default GET"},
            "body": {"type": "string", "description": "request body for POST"},
            "handle": {"type": "string"}, "account_id": {"type": "string"},
            "network": {"type": "string", "description": "'near:mainnet'|'near:testnet'"},
        }, "required": ["url", "handle", "account_id"]},
    },
    "near_agent_card": {
        "name": "near_agent_card",
        "description": "Fetch an agent's A2A agent card (capabilities, pricing surface) from a "
                       "URL or a market.near.ai handle.",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string"}, "handle": {"type": "string"},
        }, "required": []},
    },
    "near_hire_agent": {
        "name": "near_hire_agent",
        "description": "Hire an agent on NEAR Agent Market (A2A + x402): sends the task, "
                       "pays the quoted USDC price from the vault key, escrow settles when "
                       "the agent delivers. Policy-gated on the quoted price.",
        "parameters": {"type": "object", "properties": {
            "handle_or_url": {"type": "string",
                              "description": "market.near.ai handle or full agent URL"},
            "task": {"type": "string"},
            "key_handle": {"type": "string"}, "account_id": {"type": "string"},
            "network": {"type": "string"},
        }, "required": ["handle_or_url", "task", "key_handle", "account_id"]},
    },
    "near_intents_tokens": {
        "name": "near_intents_tokens",
        "description": "List swappable assets in the NEAR Intents 1Click registry.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "near_intents_quote": {
        "name": "near_intents_quote",
        "description": "Quote a cross-chain swap via NEAR Intents 1Click. dry=true (default) "
                       "previews price without creating a deposit address.",
        "parameters": {"type": "object", "properties": {
            "origin_asset": {"type": "string", "description": "e.g. 'nep141:wrap.near'"},
            "destination_asset": {"type": "string", "description": "e.g. 'nep141:usdt.tether-token.near'"},
            "amount": {"type": "string", "description": "origin amount in atomic units"},
            "swap_type": {"type": "string", "description": "EXACT_INPUT|EXACT_OUTPUT|FLEX_INPUT"},
            "account_id": {"type": "string", "description": "recipient/refund account"},
            "recipient": {"type": "string"},
            "dry": {"type": "boolean", "description": "default true (preview only)"},
        }, "required": ["origin_asset", "destination_asset", "amount"]},
    },
    "near_intents_execute": {
        "name": "near_intents_execute",
        "description": "Execute an ORIGIN_CHAIN 1Click swap: gets a live quote, then pays the "
                       "exact input to the quote's deposit address via ft_transfer — fully "
                       "policy-gated like near_send. Returns deposit address + tx.",
        "parameters": {"type": "object", "properties": {
            "origin_asset": {"type": "string"},
            "destination_asset": {"type": "string"},
            "amount": {"type": "string"},
            "token_contract": {"type": "string",
                               "description": "NEP-141 contract of the origin asset"},
            "handle": {"type": "string"}, "account_id": {"type": "string"},
            "network": {"type": "string", "description": "default mainnet"},
        }, "required": ["origin_asset", "destination_asset", "amount",
                        "token_contract", "handle", "account_id"]},
    },
    "near_intents_status": {
        "name": "near_intents_status",
        "description": "Track a 1Click swap by deposit address.",
        "parameters": {"type": "object", "properties": {
            "deposit_address": {"type": "string"},
        }, "required": ["deposit_address"]},
    },
    "near_attest": {
        "name": "near_attest",
        "description": "Fetch NEAR AI Cloud TEE attestation evidence for a model — proves the "
                       "inference enclave rather than claiming it. Returns the attestation "
                       "payload plus the public cloud.near.ai/verify link.",
        "parameters": {"type": "object", "properties": {
            "model": {"type": "string", "description": "canonical model id, e.g. 'deepseek/deepseek-v3.2'"},
            "key_handle": {"type": "string", "description": "vault handle of the NEAR AI API key, if held"},
        }, "required": ["model"]},
    },
    "near_policy": {
        "name": "near_policy",
        "description": "Read this session's effective spending policy (limits the owner set). "
                       "Use before spending to know your budget.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
}


def _mapper(op_args_fn: Callable[[Dict[str, Any]], Dict[str, Any]]) -> Callable:
    return lambda a: op_args_fn(a or {})


def _identity(a: Dict[str, Any]) -> Dict[str, Any]:
    return dict(a)


_BINDINGS = [
    ("near_status", "status", _identity, 15.0),
    ("near_request_grant", "provision",
     _mapper(lambda a: {"accountId": a.get("account_id"),
                        "policy": _policy_args(a.get("policy") or a)}), 300.0),
    ("near_link_account", "linkAccount",
     _mapper(lambda a: {"handle": a.get("handle"), "accountId": a.get("account_id")}), 15.0),
    ("near_account", "account",
     _mapper(lambda a: {"accountId": a.get("account_id"), "network": a.get("network")}), 30.0),
    ("near_view", "view",
     _mapper(lambda a: {"contractId": a.get("contract_id"), "method": a.get("method"),
                        "args": a.get("args"), "network": a.get("network")}), 60.0),
    ("near_send", "signSend",
     _mapper(lambda a: {"handle": a.get("handle"), "accountId": a.get("account_id"),
                        "receiverId": a.get("receiver_id"), "actions": _actions(a)["actions"],
                        "network": a.get("network")}), 180.0),
    ("near_transfer", "signSend",
     _mapper(lambda a: {"handle": a.get("handle"), "accountId": a.get("account_id"),
                        "receiverId": a.get("to"),
                        "actions": [{"type": "transfer",
                                     "amount": _yocto(a.get("amount_near", "0"))}],
                        "network": a.get("network")}), 180.0),
    ("near_sign_message", "signMessage",
     _mapper(lambda a: {"handle": a.get("handle"), "accountId": a.get("account_id"),
                        "message": a.get("message"), "recipient": a.get("recipient"),
                        "callbackUrl": a.get("callback_url")}), 60.0),
    ("near_delegate", "delegate",
     _mapper(lambda a: {"handle": a.get("handle"), "accountId": a.get("account_id"),
                        "receiverId": a.get("receiver_id"),
                        "actions": _actions(a)["actions"],
                        "blockHeightTtl": a.get("block_height_ttl"),
                        "network": a.get("network")}), 60.0),
    ("near_pay", "x402Fetch",
     _mapper(lambda a: {"url": a.get("url"), "method": a.get("method"),
                        "bodyB64": a.get("body_b64"),
                        "handle": a.get("handle"), "accountId": a.get("account_id"),
                        "network": a.get("network")}), 180.0),
    ("near_agent_card", "a2aCard",
     _mapper(lambda a: {"url": a.get("url"),
                        "handle": None if a.get("url") else a.get("handle")}), 30.0),
    ("near_hire_agent", "a2aHire",
     _mapper(lambda a: {"task": a.get("task"), "keyHandle": a.get("key_handle"),
                        "accountId": a.get("account_id"), "network": a.get("network"),
                        **({"handle": a["handle_or_url"]}
                           if "/" not in (a.get("handle_or_url") or "")
                           else {"url": a["handle_or_url"]})}), 300.0),
    ("near_intents_tokens", "intentsTokens", _identity, 30.0),
    ("near_intents_quote", "intentsQuote",
     _mapper(lambda a: {"originAsset": a.get("origin_asset"),
                        "destinationAsset": a.get("destination_asset"),
                        "amount": a.get("amount"),
                        "swapType": a.get("swap_type"),
                        "accountId": a.get("account_id"),
                        "recipient": a.get("recipient"),
                        "dry": a.get("dry", True)}), 60.0),
    ("near_intents_execute", "intentsExecute",
     _mapper(lambda a: {"originAsset": a.get("origin_asset"),
                        "destinationAsset": a.get("destination_asset"),
                        "amount": a.get("amount"),
                        "tokenContract": a.get("token_contract"),
                        "handle": a.get("handle"), "accountId": a.get("account_id"),
                        "network": a.get("network")}), 300.0),
    ("near_intents_status", "intentsStatus",
     _mapper(lambda a: {"depositAddress": a.get("deposit_address")}), 30.0),
    ("near_attest", "attest",
     _mapper(lambda a: {"model": a.get("model"),
                        "keyHandle": a.get("key_handle")}), 60.0),
    ("near_policy", "policyGet", _identity, 15.0),
]


def register_tools(ctx) -> None:
    for name, op, mapper, timeout in _BINDINGS:
        ctx.register_tool(
            name=name, toolset=TOOLSET, schema=_SCHEMAS[name],
            handler=lambda args, _op=op, _m=mapper, _t=timeout, **kw:
                _call(_op, _m(args or {}), timeout_s=_t),
            check_fn=bridge_present,
            description=_SCHEMAS[name]["description"],
        )
