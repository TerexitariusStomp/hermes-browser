"""widespread toolset — earn verified-work bounties on the widespread
protocol: discover funded markets, claim one, ship a signed ``dg-ship-1``
attestation, watch the adjudicator, collect the payout.

The only earning-side toolset in the Hermes catalog: every other payments
plugin helps an agent *spend*; ``wide_*`` tools let an agent *get paid for
work it can prove*. Both market sides are exposed — an agent can also
*post* a bounty and *accept* a claim, so a whole payer↔worker loop can run
inside one session.

Transport is plain HTTPS to the live bridge (``WIDE_BRIDGE`` env overrides
the default production worker). Claims are signed Ed25519 ``dg-ship-1``
envelopes — same wire format the standalone widespread-runner emits, so a
claim made by Hermes and a claim made by a sealed container are
indistinguishable to the verifier.

Tools return JSON strings per upstream registry contract.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict

TOOLSET = "widespread"
BRIDGE = os.environ.get(
    "WIDE_BRIDGE", "https://widespread-bridge.widespread.workers.dev"
).rstrip("/")
FORGE = os.environ.get(
    "WIDE_FORGE", "https://code.widespread.fyi"
).rstrip("/")


# ---------- signing (ed25519: cryptography → nacl → pure fallback) ---------

def _sign(msg: bytes, seed: bytes) -> bytes:
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import (
            Ed25519PrivateKey,
        )
        return Ed25519PrivateKey.from_private_bytes(seed).sign(msg)
    except Exception:
        pass
    try:
        import nacl.signing  # type: ignore
        return nacl.signing.SigningKey(seed).sign(msg).signature
    except Exception:
        pass
    return _pure_ed25519_sign(msg, seed)


def _pubkey(seed: bytes) -> bytes:
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import (
            Ed25519PrivateKey,
        )
        from cryptography.hazmat.primitives.serialization import (
            Encoding, PublicFormat,
        )
        return Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(
            Encoding.Raw, PublicFormat.Raw)
    except Exception:
        pass
    import nacl.signing  # type: ignore
    return bytes(nacl.signing.SigningKey(seed).verify_key)


def _pure_ed25519_sign(msg: bytes, seed: bytes) -> bytes:
    """RFC 8032 reference impl — dependency-free fallback (~60 LOC)."""
    q = 2**255 - 19
    l_ = 2**252 + 27742317777372353535851937790883648493
    d_ = -121665 * pow(121666, q - 2, q) % q
    I = pow(2, (q - 1) // 4, q)

    def xrecover(y):
        xx = (y * y - 1) * pow(d_ * y * y + 1, q - 2, q)
        x = pow(xx, (q + 3) // 8, q)
        if (x * x - xx) % q != 0:
            x = (x * I) % q
        return x if x % 2 == 0 else q - x

    B = (xrecover(4 * pow(5, q - 2, q) % q), 4 * pow(5, q - 2, q) % q)

    def add(P, Q):
        x1, y1 = P; x2, y2 = Q
        x3 = (x1 * y2 + x2 * y1) * pow(1 + d_ * x1 * x2 * y1 * y2, q - 2, q) % q
        y3 = (y1 * y2 + x1 * x2) * pow(1 - d_ * x1 * x2 * y1 * y2, q - 2, q) % q
        return x3, y3

    def mul(P, n):
        R = (0, 1)
        while n:
            if n & 1:
                R = add(R, P)
            P = add(P, P)
            n >>= 1
        return R

    def enc(P):
        x, y = P
        return (y | ((x & 1) << 255)).to_bytes(32, "little")

    h = hashlib.sha512(seed).digest()
    a = int.from_bytes(h[:32], "little") & (2**254 - 8) | (1 << 254)
    A = enc(mul(B, a))
    r = int.from_bytes(hashlib.sha512(h[32:] + msg).digest(), "little") % l_
    R = enc(mul(B, r))
    s = (r + int.from_bytes(hashlib.sha512(R + A + msg).digest(), "little") * a) % l_
    return R + s.to_bytes(32, "little")


def _load_agent() -> Dict[str, str]:
    """Ephemeral Ed25519 agent — seed persisted per plugin-data dir; the
    forge assigns the did:key at registration."""
    import secrets
    try:
        from plugin_db import plugin_data_dir  # type: ignore
        path = os.path.join(plugin_data_dir(TOOLSET), "agent.json")
    except Exception:
        path = os.path.expanduser(
            "~/.hermes/plugin-data/widespread/agent.json")
    if os.path.exists(path):
        a = json.load(open(path))
        if "pubkey_hex" not in a:
            a["pubkey_hex"] = _pubkey(base64.b64decode(a["seed_b64"])).hex()
            a.setdefault("did", None)
            json.dump(a, open(path, "w"))
        return a
    seed = secrets.token_bytes(32)
    agent = {
        "seed_b64": base64.b64encode(seed).decode(),
        "pubkey_hex": _pubkey(seed).hex(),
        "did": None,
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(agent, open(path, "w"))
    return agent


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------- HTTP ----------

def _req(method: str, path: str, body: Dict[str, Any] | None = None,
         headers: Dict[str, str] | None = None, timeout: float = 30.0,
         base: str | None = None) -> Dict[str, Any]:
    url = (base or BRIDGE) + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("content-type", "application/json")
    r.add_header("user-agent", "Mozilla/5.0 (X11; Linux x86_64) HermesAgent/1.0")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return {"error": f"http_{e.code}: {e.read()[:300].decode('utf-8', 'replace')}"}
    except Exception as e:
        return {"error": f"bridge_unreachable: {e}"}


def _signed_headers(seed_b64: str, did: str, path: str,
                    body: bytes) -> Dict[str, str]:
    """x-dg-* envelope — exactly the forge's dg1 wire format:
    sig = ed25519( sha256( "dg1\\n{did}\\n{ts}\\n{nonce}\\nPOST\\n{path}\\n
                            {sha256hex(body)}" ) )."""
    seed = base64.b64decode(seed_b64)
    ts = str(int(time.time()))
    nonce = os.urandom(16).hex()
    payload = _sha256_hex(
        f"dg1\n{did}\n{ts}\n{nonce}\nPOST\n{path}\n{_sha256_hex(body)}".encode()
    )
    sig = _sign(payload.encode(), seed).hex()
    return {
        "x-dg-did": did, "x-dg-ts": ts, "x-dg-nonce": nonce, "x-dg-sig": sig,
    }


def _ok(resp: Dict[str, Any]) -> str:
    return json.dumps({"success": "error" not in resp, **resp})


def bridge_alive() -> bool:
    """check_fn: True when the bridge answers."""
    try:
        r = _req("GET", "/api/state", timeout=8.0)
        return "error" not in r
    except Exception:
        return False


# ---------- tool handlers ----------

def _t_bounties(a: Dict[str, Any]) -> str:
    return _ok(_req("GET", "/api/state"))


def _t_post(a: Dict[str, Any]) -> str:
    return _ok(_req("POST", "/api/bounties", {
        "repo": a["repo"], "amount_usd": a["amount_usd"], "spec": a["spec"],
        "email": a.get("email", "agent@widespread"),
    }))


def _t_agent(a: Dict[str, Any]) -> str:
    """Register the ephemeral pubkey with the forge — it assigns the did."""
    agent = _load_agent()
    reg = _req("POST", "/api/agents",
               {"pubkey": agent["pubkey_hex"],
                "label": a.get("label", "hermes-widespread")},
               base=FORGE)
    if reg.get("did"):
        agent["did"] = reg["did"]
        try:
            from plugin_db import plugin_data_dir  # type: ignore
            p = os.path.join(plugin_data_dir(TOOLSET), "agent.json")
        except Exception:
            p = os.path.expanduser(
                "~/.hermes/plugin-data/widespread/agent.json")
        json.dump(agent, open(p, "w"))
    return _ok({"did": agent.get("did"), **reg})


def _dg_post(repo: str, kind_path: str, body: Dict[str, Any],
             agent: Dict[str, str]) -> Dict[str, Any]:
    if not agent.get("did"):
        return {"error": "agent_unregistered: call wide_agent first"}
    body_bytes = json.dumps(body).encode()
    path = f"/api/{repo}{kind_path}"
    hdrs = _signed_headers(agent["seed_b64"], agent["did"], path, body_bytes)
    url = FORGE + path
    r = urllib.request.Request(url, data=body_bytes, method="POST")
    r.add_header("content-type", "application/json")
    r.add_header("user-agent", "Mozilla/5.0 HermesAgent/1.0")
    for k, v in hdrs.items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=45.0) as resp:
            return json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return {"error": f"http_{e.code}: {e.read()[:300].decode('utf-8','replace')}"}
    except Exception as e:
        return {"error": f"forge_unreachable: {e}"}


def _t_claim(a: Dict[str, Any]) -> str:
    """Bind intent to work a bounty — a local ledger entry, not an op:
    the forge op for work IS the ship; 'claiming' is intent + verification
    that the market is actually funded before you spend effort."""
    agent = _load_agent()
    st = _req("GET", "/api/state")
    mkts = [m for m in st.get("bounties", [])
            if m.get("repo") == a["repo"] or m.get("id") == a["bounty_id"]]
    entry = {"op": "claim", "repo": a["repo"], "bounty_id": a["bounty_id"],
             "did": agent.get("did"), "eta": a.get("eta"),
             "funded": bool(mkts)}
    _log(entry)
    return _ok({**entry, "warning": None if mkts else
                "bounty_not_found_in_state — verify the market is funded"})


def _t_ship(a: Dict[str, Any]) -> str:
    agent = _load_agent()
    return _ok(_dg_post(a["repo"], "/dg/ship", {
        "session_id": a.get("session_id", f"hermes-{int(time.time())}"),
        "tool": "hermes-widespread",
        "commits": [c.lower() for c in a["commits"]],
        **({"files": a["files"]} if a.get("files") else {}),
    }, agent))


def _t_verdict(a: Dict[str, Any]) -> str:
    body = {"repo": a["repo"], "seq": a["seq"]}
    return _ok(_req("POST", "/review", body, timeout=120.0))


def _t_payout(a: Dict[str, Any]) -> str:
    st = _req("GET", "/api/state")
    claim = next((c for c in st.get("claims", [])
                  if c.get("id") == a.get("claim_id")
                  or (c.get("repo") == a.get("repo") and c.get("seq") == a.get("seq"))), None)
    return _ok({"claim": claim} if claim else {"error": "claim_not_found"})


def _t_fund(a: Dict[str, Any]) -> str:
    st = _req("GET", "/api/state")
    mkts = [m for m in st.get("bounties", []) if m.get("repo") == a.get("repo")]
    return _ok({"bounties": mkts})


def _t_accept(a: Dict[str, Any]) -> str:
    return _ok(_req("POST", "/review",
                    {"repo": a["repo"], "seq": a["seq"],
                     "accept": True, "payer": a.get("payer")},
                    timeout=120.0))


def _t_ledger(a: Dict[str, Any]) -> str:
    try:
        from plugin_db import plugin_data_dir  # type: ignore
        path = os.path.join(plugin_data_dir(TOOLSET), "ledger.jsonl")
    except Exception:
        path = os.path.expanduser(
            "~/.hermes/plugin-data/widespread/ledger.jsonl")
    if not os.path.exists(path):
        return _ok({"entries": []})
    return _ok({"entries": [json.loads(l) for l in open(path) if l.strip()]})


def _log(entry: Dict[str, Any]) -> None:
    try:
        from plugin_db import plugin_data_dir  # type: ignore
        path = os.path.join(plugin_data_dir(TOOLSET), "ledger.jsonl")
    except Exception:
        path = os.path.expanduser(
            "~/.hermes/plugin-data/widespread/ledger.jsonl")
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a") as f:
            f.write(json.dumps({**entry, "ts": int(time.time())}) + "\n")
    except Exception:
        pass


# ---------- Intentional Hats — scoped authority + stance ----------

def _hat_id(a: Dict[str, Any]) -> str:
    return a.get("hat_id") or _load_agent().get("hat_id", "")


def _t_hat_list(a: Dict[str, Any]) -> str:
    org = a.get("org") or "2"
    return _ok(_req("GET", f"/api/hats?org={org}"))


def _t_hat_stance(a: Dict[str, Any]) -> str:
    hat = _hat_id(a)
    if not hat:
        return _ok({"error": "no hat_id — set hat_id on the agent or pass it"})
    if a.get("spec"):
        return _ok(_req("POST", f"/api/hats/{hat}/stance-check",
                        {"spec": a["spec"]}))
    return _ok(_req("GET", f"/api/hats/{hat}"))


def _t_hat_work(a: Dict[str, Any]) -> str:
    """rankOpportunities — funded markets ranked by stance alignment ×
    reward / estCost. The sim's answer to 'what should I work on?'"""
    hat = _hat_id(a)
    if not hat:
        return _ok({"error": "no hat_id — set hat_id on the agent or pass it"})
    return _ok(_req("GET", f"/api/hats/{hat}/opportunities"))


# ---------- unified forge feed + client-side execution ----------

def _t_feed(a: Dict[str, Any]) -> str:
    """Query the cross-forge bounty feed — every funded work item on every
    connected forge, normalized with escrow/verification/trust/competition
    metadata. Filter by forge/source/repo/q/min_usd/currency/escrow/
    max_competition; sort by reward|newest|trust."""
    params = []
    for k in ("forge", "source", "repo", "q", "min_usd", "currency",
              "escrow", "sort", "limit", "cursor", "max_competition"):
        if a.get(k) is not None:
            params.append(f"{k}={urllib.parse.quote(str(a[k]))}")
    path = "/api/feed" + ("?" + "&".join(params) if params else "")
    return _ok(_req("GET", path, timeout=45.0))


def _t_runners(a: Dict[str, Any]) -> str:
    """List client-side sealed execution environments — browser sandbox
    (default) or self-hosted sealed runners. Run repo code ONLY inside one
    of these; never on a bare host."""
    return _ok(_req("GET", "/api/runners"))


# ---------- registration ----------

def _s(props: Dict[str, Any], req: list[str], desc: str) -> Dict[str, Any]:
    return {"type": "object", "properties": props, "required": req,
            "description": desc}


_SCHEMAS: Dict[str, Dict[str, Any]] = {
    "wide_bounties": _s({}, [], "List open, funded bounty markets on the "
                        "widespread bridge (repo, amount, spec)."),
    "wide_post": _s({
        "repo": {"type": "string"}, "amount_usd": {"type": "number"},
        "spec": {"type": "string"}, "email": {"type": "string"}},
        ["repo", "amount_usd", "spec"],
        "Post a funded bounty market: @widespread $N for <spec>."),
    "wide_agent": _s({}, [], "Create/rotate the ephemeral did:key agent "
                           "identity and register it with the bridge."),
    "wide_claim": _s({
        "repo": {"type": "string"}, "seq": {"type": "integer"},
        "bounty_id": {"type": "string"}, "eta": {"type": "string"}},
        ["repo", "seq", "bounty_id"],
        "Bind intent to work a funded bounty (did:key-signed claim op)."),
    "wide_ship": _s({
        "repo": {"type": "string"},
        "commits": {"type": "array", "items": {"type": "string"}},
        "session_id": {"type": "string"}, "files": {"type": "integer"}},
        ["repo", "commits"],
        "Emit a signed dg-ship-1 attestation binding work commits to the "
        "forge op-log — the proof of work."),
    "wide_verdict": _s({
        "repo": {"type": "string"}, "seq": {"type": "integer"}},
        ["repo", "seq"],
        "Trigger/poll bridge adjudication: hash-chain replay → evidence "
        "recompute → verdict."),
    "wide_payout": _s({
        "repo": {"type": "string"}, "seq": {"type": "integer"},
        "claim_id": {"type": "string"}}, [],
        "Look up the payout/receipt for a claim (batch id, status)."),
    "wide_fund": _s({"repo": {"type": "string"}}, ["repo"],
                    "Show escrow/funding status of markets on a repo."),
    "wide_accept": _s({
        "repo": {"type": "string"}, "seq": {"type": "integer"},
        "payer": {"type": "string"}}, ["repo", "seq"],
        "Payer side: accept a claim → triggers adjudication + payout."),
    "wide_ledger": _s({}, [], "Read the local claims→verdicts→receipts ledger."),
    "hat_list": _s({"org": {"type": "string"}}, [],
                   "List hats in an Intentional Hats org (role tree, "
                   "wearers, permissions, stance)."),
    "hat_stance": _s({
        "hat_id": {"type": "string"}, "spec": {"type": "string"}}, [],
        "Show a hat's stance profile, or stance-check a spec: would this "
        "agent support this work?"),
    "hat_work": _s({"hat_id": {"type": "string"}}, [],
                   "Ranked opportunities: funded markets scored by stance "
                   "alignment × reward / estCost — what this agent should "
                   "work on first."),
    "wide_feed": _s({
        "forge": {"type": "string"}, "source": {"type": "string"},
        "repo": {"type": "string"}, "q": {"type": "string"},
        "min_usd": {"type": "number"}, "currency": {"type": "string"},
        "escrow": {"type": "string"},
        "sort": {"type": "string", "enum": ["reward", "newest", "trust"]},
        "limit": {"type": "integer"}, "cursor": {"type": "string"},
        "max_competition": {"type": "integer"}}, [],
        "Search the unified cross-forge bounty feed (JSON+MCP+RSS behind "
        "it). Every funded work item on every connected forge with "
        "escrow/verification/trust/competition metadata — pick the best "
        "bounty, not the first."),
    "wide_runners": _s({}, [],
                       "List client-side sealed execution environments "
                       "(browser sandbox default, self-hosted runners). "
                       "Run repo code only inside one — never a bare host."),
}

_BINDINGS = {
    "wide_bounties": _t_bounties, "wide_post": _t_post,
    "wide_agent": _t_agent, "wide_claim": _t_claim, "wide_ship": _t_ship,
    "wide_verdict": _t_verdict, "wide_payout": _t_payout,
    "wide_fund": _t_fund, "wide_accept": _t_accept, "wide_ledger": _t_ledger,
    "hat_list": _t_hat_list, "hat_stance": _t_hat_stance,
    "hat_work": _t_hat_work,
    "wide_feed": _t_feed, "wide_runners": _t_runners,
}

# log side-effects for the local ledger
_WRAP = {"wide_ship": "ship", "wide_claim": "claim", "wide_accept": "accept",
         "wide_post": "post"}


def register_tools(ctx) -> None:
    for name, fn in _BINDINGS.items():
        def handler(args, _fn=fn, _name=name, **kw):
            resp = _fn(args or {})
            if _name in _WRAP:
                _log({"op": _WRAP[_name], "args": args or {},
                      "ok": '"success": true' in resp or '"success":true' in resp})
            return resp
        ctx.register_tool(
            name=name, toolset=TOOLSET, schema=_SCHEMAS[name],
            handler=handler, check_fn=bridge_alive,
            description=_SCHEMAS[name]["description"],
        )
