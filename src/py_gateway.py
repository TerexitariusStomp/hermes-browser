"""py_gateway.py — in-browser Hermes gateway host.

Runs inside the Pyodide worker. Owns:

- one logical WebSocket per page shim, each served by the REAL upstream
  ``tui_gateway.ws.handle_ws`` coroutine over a queue-backed socket object
  (the exact accept/ready/dispatch/transport path the dashboard uses)
- the full upstream REST surface by invoking the real
  ``hermes_cli.web_server.app`` ASGI app in-process on the cooperative
  asyncio loop (browser_runtime) — every dashboard route, unchanged
- vault-mediated outbound fetches (httpx transport asks the page, which
  resolves vault: grant handles and performs the fetch — key material
  never enters this interpreter)

JS contract (js.hermesBridge):
  emit(wsId, text)            — outbound text frame to a socket
  wsAccepted(wsId)            — socket is open on the wire
  wsClosed(wsId, code, reason)
  pump(ms) -> [str]           — Atomics.wait + drain inbound ring
  fetchRequest(...)           — enqueue a network request to the page
  restReply(id, status, headersDict, bodyB64)
  log(level, msg)
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import time
import urllib.parse


def _js():
    import js  # type: ignore

    return js.hermesBridge


_sockets: dict[int, "_FakeWS"] = {}
_pending_net: dict[int, dict] = {}
_pending_sub: dict[int, dict] = {}
_pending_wasi: dict[int, dict] = {}
_pending_pwa: dict[int, dict] = {}
_pending_host: dict[int, dict] = {}
# Broker-grant bindings minted page-side at session.create; fetches on a
# `prompt-turn-<sid>` thread carry that session's grant so the vault worker
# enforces its scope (remote sub-grants resolve a strict subset of handles).
_session_grants: dict[str, str] = {}
_net_id = 0
_sub_id = 0
_wasi_id = 0
_pwa_id = 0
_host_id = 0
_app = None
_lifespan_cm = None
_session_token = ""
_public_host = ""


class _Client:
    host = "127.0.0.1"
    port = 0


class _FakeWS:
    """Duck-typed WebSocket for tui_gateway.ws.handle_ws.

    Implements the exact surface handle_ws/WSTransport touch:
    accept(), receive_text() (raises WebSocketDisconnect on close),
    send_text(), close(), .client/.scope/.app attributes — plus the
    headers/query_params/url reads the upstream pre-accept guard
    (_close_unless_sidecar_allowed) performs.
    """

    def __init__(self, ws_id: int, path: str = "/", headers: dict | None = None):
        self.ws_id = ws_id
        self.client = _Client()
        self.scope = {"type": "websocket", "extensions": {}}
        self.app = _app
        parsed = urllib.parse.urlsplit(path)
        self.url = parsed
        self.query_params = {
            k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()
        }
        self.headers = {str(k).lower(): str(v) for k, v in (headers or {}).items()}
        self._inq: asyncio.Queue = asyncio.Queue()
        self._accepted = False
        self._closed = False

    async def accept(self, subprotocol=None):
        self._accepted = True
        _js().wsAccepted(self.ws_id)

    async def receive_text(self) -> str:
        item = await self._inq.get()
        if isinstance(item, BaseException):
            raise item
        return item

    async def send_text(self, text: str) -> None:
        if self._closed:
            raise RuntimeError("socket closed")
        _js().emit(self.ws_id, text)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        if self._closed:
            return
        self._closed = True
        _js().wsClosed(self.ws_id, code, reason)

    # feed side (sync callers)
    def feed_text(self, text: str) -> None:
        self._inq.put_nowait(text)

    def feed_disconnect(self, code: int = 1000, reason: str = "") -> None:
        from starlette.websockets import WebSocketDisconnect

        self._closed = True
        self._inq.put_nowait(WebSocketDisconnect(code=code, reason=reason))


# --------------------------------------------------------------- socket glue


def ws_open(ws_id: int, path: str, headers: dict | None = None) -> None:
    ws = _FakeWS(ws_id, path, headers)
    _sockets[ws_id] = ws
    import browser_runtime

    async def _run():
        from tui_gateway.ws import handle_ws

        try:
            # The real upstream pre-accept guard chain: chat-enabled check,
            # credential check (token vs _SESSION_TOKEN in legacy mode), and
            # the Host/Origin/peer DNS-rebinding gates.
            from hermes_cli.web_routers.chat_ws import (
                _close_unless_sidecar_allowed)

            if not await _close_unless_sidecar_allowed(
                    ws, allow_internal=True):
                return
            # Mirror gateway_ws's prelude: first chat client arms deferred
            # MCP discovery.
            try:
                from hermes_cli.mcp_startup import start_deferred_mcp_discovery_now

                await asyncio.to_thread(start_deferred_mcp_discovery_now)
            except Exception:
                pass
            await handle_ws(
                ws,
                auth_identity=getattr(ws, "_hermes_auth_identity", None),
                subprotocol=getattr(ws, "_hermes_ws_subprotocol", None),
            )
        except Exception:
            import traceback

            traceback.print_exc()
            try:
                await ws.close(code=1011)
            except Exception:
                pass

    try:
        asyncio.Task(_run(), loop=browser_runtime.get_loop())
    except Exception:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        _js().log("err", f"ws_open task creation failed: {sys.exc_info()[1]!r}")


def ws_close(ws_id: int) -> None:
    ws = _sockets.pop(ws_id, None)
    if ws is not None:
        ws.feed_disconnect()


def ws_send(ws_id: int, data: str) -> None:
    ws = _sockets.get(ws_id)
    if ws is None:
        return
    ws.feed_text(data)


def _route_pump_frame(frame: dict) -> None:
    """Frames arriving while a handler is blocked in pump()."""
    t = frame.get("t")
    if t == "ws-send":
        ws_send(frame["id"], frame["data"])
    elif t == "ws-open":
        ws_open(frame["id"], frame.get("path", ""), frame.get("headers"))
    elif t == "ws-close":
        ws_close(frame["id"])
    elif t == "net-resp":
        _pending_net[frame["id"]] = frame
    elif t == "substrate-resp":
        _pending_sub[frame["id"]] = frame
    elif t == "wasi-resp":
        _pending_wasi[frame["id"]] = frame
    elif t == "pwa-resp":
        _pending_pwa[frame["id"]] = frame
    elif t == "host-resp":
        _pending_host[frame["id"]] = frame
    elif t == "grant-bind":
        sid = frame.get("session") or ""
        grant = frame.get("grant") or ""
        if sid and grant:
            _session_grants[sid] = grant
        else:
            _session_grants.pop(sid, None)
    elif t == "rest":
        _handle_rest(frame)


def handle(raw: str) -> None:
    """JS pump entry: one raw JSON frame from the ring buffer."""
    try:
        frame = json.loads(raw)
    except Exception:
        return
    _route_pump_frame(frame)


# ------------------------------------------------------------------- REST


def _handle_rest(frame: dict) -> None:
    """Route a page REST request through the real FastAPI app.

    The scope mimics uvicorn's: http.request delivers the buffered body once,
    send() collects response.start + body chunks. Headers pass through
    verbatim — the renderer already attaches X-Hermes-Session-Token.
    """
    rid = frame["id"]
    method = frame.get("method", "GET")
    raw_path = frame.get("path", "/")
    parsed = urllib.parse.urlsplit(raw_path)
    headers = frame.get("headers") or {}
    body = frame.get("body") or {}
    if "b64" in body:
        body_bytes = base64.b64decode(body["b64"])
    else:
        body_bytes = (body.get("text") or "").encode()

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": parsed.path,
        "raw_path": parsed.path.encode(),
        "query_string": parsed.query.encode(),
        "root_path": "",
        "headers": [
            (str(k).lower().encode(), str(v).encode()) for k, v in headers.items()
        ],
        "client": ("127.0.0.1", 0),
        "server": ("127.0.0.1", 0),
        "app": _app,
    }

    state = {"sent": False}
    status_headers: dict = {}
    chunks: list[bytes] = []

    async def receive():
        if not state["sent"]:
            state["sent"] = True
            return {"type": "http.request", "body": body_bytes, "more_body": False}
        return {"type": "http.disconnect"}

    async def send(msg):
        t = msg["type"]
        if t == "http.response.start":
            status_headers["status"] = msg["status"]
            status_headers["headers"] = dict(msg.get("headers") or [])
        elif t == "http.response.body":
            chunks.append(msg.get("body", b""))
        elif t == "http.response.debug":
            pass

    async def _invoke():
        await _app(scope, receive, send)

    def _reply():
        body_out = b"".join(chunks)
        # postMessage can't structured-clone a PyProxy — headers cross as
        # JSON. ASGI delivers them as (bytes, bytes) pairs — decode first.
        hdrs = {}
        for k, v in (status_headers.get("headers") or {}).items():
            kk = k.decode() if isinstance(k, bytes) else str(k)
            hdrs[kk] = v.decode() if isinstance(v, bytes) else str(v)
        _js().restReply(
            rid,
            status_headers.get("status", 500),
            json.dumps(hdrs),
            base64.b64encode(body_out).decode(),
        )

    import browser_runtime

    def _done(task):
        import traceback

        exc = task.exception()
        if exc is not None:
            traceback.print_exception(exc)
            _js().restReply(
                rid, 500, json.dumps({"content-type": "application/json"}),
                base64.b64encode(json.dumps(
                    {"detail": f"internal error: {exc}"}).encode()).decode())
            return
        try:
            _reply()
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    # No run_sync here: pump is reentrant, so a synchronous wait inside
    # _route_pump_frame lets every new REST frame nest one stack level deeper
    # and the in-flight requests starve — the observed boot wedge. REST is
    # queued on the loop like a real server: the task steps during pump and
    # the reply goes out from its done-callback.
    try:
        _loop = browser_runtime.get_loop()
        t = asyncio.Task(_invoke(), loop=_loop)
        t.add_done_callback(_done)
    except Exception:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        _js().log("err", f"rest task creation failed: {sys.exc_info()[1]!r}")


# ------------------------------------------------------------- net (vault)


def fetch_blocking(url: str, method: str, headers: dict, body_b64: str | None,
                   timeout_s: float = 120.0) -> dict:
    """Synchronous-over-SAB fetch. Enqueues to the page; the page resolves
    vault: grant handles against the key-vault worker and performs the
    real fetch. The response arrives through the pump's ring drain."""
    global _net_id
    import browser_runtime
    import threading

    _net_id += 1
    req_id = _net_id
    # Turn threads are named `prompt-turn-<sid>`; the session's broker grant
    # travels with the request so vault enforces its handle scope.
    grant = ""
    tname = threading.current_thread().name or ""
    if tname.startswith("prompt-turn-"):
        grant = _session_grants.get(tname[len("prompt-turn-"):], "")
    _js().fetchRequest(req_id, url, method, json.dumps(headers), body_b64 or "", grant)
    deadline = __import__("time").monotonic() + timeout_s
    while True:
        if req_id in _pending_net:
            resp = _pending_net.pop(req_id)
            return resp
        if __import__("time").monotonic() >= deadline:
            return {"status": 599, "headers": {}, "body": "", "error": "fetch timeout"}
        browser_runtime.pump(deadline)


def substrate_call(op: str, args: dict | None = None,
                   timeout_s: float = 60.0) -> dict:
    """Synchronous-over-SAB extension substrate op. Enqueues a fixed-op
    request to the page, which relays it to the Hermes substrate extension's
    content-script bridge (grant-gated, audited, revocable there). The
    response arrives through the pump's ring drain like net-resp."""
    global _sub_id
    import browser_runtime

    _sub_id += 1
    req_id = _sub_id
    _js().substrateRequest(req_id, op, json.dumps(args or {}))
    deadline = __import__("time").monotonic() + timeout_s
    while True:
        if req_id in _pending_sub:
            resp = _pending_sub.pop(req_id)
            inner = resp.get("result")
            return inner if isinstance(inner, dict) else resp
        if __import__("time").monotonic() >= deadline:
            return {"error": "substrate timeout"}
        browser_runtime.pump(deadline)


def wasi_call(op: str, args: dict | None = None,
              timeout_s: float = 60.0) -> dict:
    """Synchronous-over-SAB WASI-runner op (in-page, no extension needed).

    Runs the plugin env's commands in the WASI userspace shipped with the
    page (cowasm kernel + dash/coreutils wasm). `status`/`exec` are the ops;
    the page answers `wasi-resp` through the pump's ring drain like net-resp.
    """
    global _wasi_id
    import browser_runtime

    _wasi_id += 1
    req_id = _wasi_id
    _js().wasiRequest(req_id, op, json.dumps(args or {}))
    deadline = __import__("time").monotonic() + timeout_s
    while True:
        if req_id in _pending_wasi:
            resp = _pending_wasi.pop(req_id)
            inner = resp.get("result")
            return inner if isinstance(inner, dict) else resp
        if __import__("time").monotonic() >= deadline:
            return {"error": "wasi timeout"}
        browser_runtime.pump(deadline)


def pwa_call(op: str, args: dict | None = None,
             timeout_s: float = 60.0) -> dict:
    """Synchronous-over-SAB PWA-grant op (in-page browser APIs).

    Notifications, File System Access handles, mic/camera capture, wake lock
    and periodic-sync registration live in the page (pwa-bridge.js), gated
    by the browser's own permission model. Answers arrive as `pwa-resp`
    through the pump's ring drain like the other substrate channels.
    """
    global _pwa_id
    import browser_runtime

    _pwa_id += 1
    req_id = _pwa_id
    _js().pwaRequest(req_id, op, json.dumps(args or {}))
    deadline = __import__("time").monotonic() + timeout_s
    while True:
        if req_id in _pending_pwa:
            resp = _pending_pwa.pop(req_id)
            inner = resp.get("result")
            return inner if isinstance(inner, dict) else resp
        if __import__("time").monotonic() >= deadline:
            return {"error": "pwa timeout"}
        browser_runtime.pump(deadline)


def host_call(op: str, args: dict | None = None,
              timeout_s: float = 60.0) -> dict:
    """Synchronous-over-SAB local-host substrate op (opt-in T3).

    Drives the companion host-agent.py the user runs on their own machine;
    the page performs the localhost fetch with the vault-resolved pairing
    token (host-bridge.js). Answers arrive as `host-resp` through the
    pump's ring drain like the other substrate channels.
    """
    global _host_id
    import browser_runtime

    _host_id += 1
    req_id = _host_id
    _js().hostRequest(req_id, op, json.dumps(args or {}))
    deadline = __import__("time").monotonic() + timeout_s
    while True:
        if req_id in _pending_host:
            resp = _pending_host.pop(req_id)
            inner = resp.get("result")
            return inner if isinstance(inner, dict) else resp
        if __import__("time").monotonic() >= deadline:
            return {"error": "host timeout"}
        browser_runtime.pump(deadline)


def install() -> None:
    """Bind the pump router so frames arriving mid-wait get routed."""
    import browser_runtime

    browser_runtime.set_frame_router(lambda f: _route_pump_frame(
        json.loads(f) if isinstance(f, str) else f))


def _boot_web_app() -> None:
    """Import the real FastAPI app, set serve-mode state, run ASGI lifespan."""
    global _app, _lifespan_cm
    import browser_runtime

    browser_runtime.get_loop()

    import os

    os.environ.setdefault("HERMES_SERVE_HEADLESS", "1")
    # The private-session token the page mints doubles as the dashboard
    # session token — same credential model as upstream serve.
    if _session_token:
        os.environ["HERMES_DASHBOARD_SESSION_TOKEN"] = _session_token

    sys.stderr.write("py_gateway: importing web_server\n")
    from hermes_cli import web_server

    sys.stderr.write("py_gateway: web_server imported\n")
    _app = web_server.app
    state = _app.state
    state.ui_surface = "serve"
    state.auth_required = False
    # Host/Origin validation accepts loopback aliases automatically; the
    # page's real hostname is the operator-declared public host — upstream's
    # `dashboard.public_url` → trusted_public_hosts path.
    state.trusted_public_hosts = (
        frozenset({_public_host.lower()}) if _public_host else frozenset())
    state.bound_host = "127.0.0.1"
    state.bound_port = 0
    state.initial_profile = "default"
    state.web_dist = None
    state.ssh_isolated_clients = set()

    import contextlib

    sys.stderr.write("py_gateway: entering lifespan\n")
    _lifespan_cm = _app.router.lifespan_context(_app)
    browser_runtime.run_sync(_lifespan_cm.__aenter__(), timeout=600)
    sys.stderr.write("py_gateway boot: web_server app + lifespan up\n")


def _install_browser_plugin() -> None:
    """Install the hermes-browser plugin into HERMES_HOME/plugins and
    enable it via the one sanctioned config writer — plugin discovery scans
    ~/.hermes/plugins on first ``model_tools`` import, so this must run
    before the web app is imported."""
    import shutil

    src = "/hermes-py/plugins/hermes_browser"
    if not os.path.isdir(src):
        return
    plugins_dir = os.path.join(os.environ.get("HERMES_HOME", "/hermes-home"), "plugins")
    os.makedirs(plugins_dir, exist_ok=True)
    shutil.copytree(src, os.path.join(plugins_dir, "hermes_browser"),
                    dirs_exist_ok=True)
    try:
        from hermes_cli.config import (atomic_config_write, get_config_path,
                                       read_user_config_raw)
        cfg_path = get_config_path()
        data = read_user_config_raw(cfg_path)
        if not isinstance(data, dict):
            data = {}
        plugins = data.setdefault("plugins", {})
        enabled = plugins.get("enabled")
        if not isinstance(enabled, list):
            enabled = []
        merged = list(dict.fromkeys(
            list(enabled) + ["hermes_browser", "hermes-browser"]))
        plugins["enabled"] = merged
        # Named provider for the in-page wllama endpoint — keyless local
        # server shape (omitted api_key reads as "no-key-required"). The
        # `local-llm.hermes` host never reaches the network; the page's net
        # bridge routes it to local-llm.js.
        providers = data.setdefault("providers", {})
        providers.setdefault("local-llm", {
            "name": "Local (in-browser)",
            "api": "https://local-llm.hermes/v1",
            "default_model": "qwen2.5-0.5b-instruct-q4_k_m",
            "models": {
                "qwen2.5-0.5b-instruct-q4_k_m": {"context_length": 4096},
            },
        })
        terminal = data.setdefault("terminal", {})
        if not terminal.get("backend"):
            terminal["backend"] = "wasi"
        # HERMES_EXTRA_CONFIG_JSON: JSON object deep-merged into config at
        # boot. Used by smoke tests (mock provider) and deployments that want
        # to ship non-secret defaults.
        extra = os.environ.get("HERMES_EXTRA_CONFIG_JSON")
        if extra:
            try:
                import json as _json
                data = _deep_merge(data, _json.loads(extra))
            except Exception as e:
                sys.stderr.write(f"py_gateway: bad HERMES_EXTRA_CONFIG_JSON: {e}\n")
        atomic_config_write(cfg_path, data)
    except Exception as err:
        sys.stderr.write(f"py_gateway: plugin enable failed: {err}\n")


def _seed_models_dev_cache() -> None:
    """Seed ~/.hermes/models_dev_cache.json from the shipped models.dev
    snapshot when no real cache exists yet. Upstream's fetch_models_dev
    serves a disk snapshot of any age instantly and refreshes in the
    background — seeding removes the one blocking cold fetch that made
    model.save_key crawl on first use. The file is backdated past the
    registry TTL so the first read also kicks a live refresh."""
    import gzip

    home = os.environ.get("HERMES_HOME", "/hermes-home")
    cache_path = os.path.join(home, "models_dev_cache.json")
    seed = "/hermes-py/models-dev-seed.json.gz"
    if os.path.exists(cache_path) or not os.path.exists(seed):
        return
    try:
        payload = gzip.decompress(open(seed, "rb").read())
        with open(cache_path, "wb") as fh:
            fh.write(payload)
        etag_seed = "/hermes-py/models-dev-seed.etag"
        if os.path.exists(etag_seed):
            with open(etag_seed, encoding="utf-8") as fh:
                etag = fh.read().strip()
            if etag:
                with open(os.path.join(home, "models_dev_cache.etag"), "w", encoding="utf-8") as fh:
                    fh.write(etag)
        # Backdate past _MODELS_DEV_CACHE_TTL (4h): stage-3 disk reads serve
        # it instantly AND arm the background refresh on first use.
        stale = time.time() - (4 * 3600 + 60)
        os.utime(cache_path, (stale, stale))
        sys.stderr.write("py_gateway: models.dev cache seeded from snapshot\n")
    except Exception as err:
        sys.stderr.write(f"py_gateway: models.dev seed failed: {err}\n")


def _deep_merge(dst: dict, src: dict) -> dict:
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            dst[k] = _deep_merge(dst[k], v)
        else:
            dst[k] = v
    return dst


def boot(session_token: str = "", public_host: str = "") -> None:
    """Entry called by the worker once the FS is populated."""
    global _session_token, _public_host
    import browser_runtime
    import browser_bootstrap

    _session_token = session_token
    _public_host = public_host
    browser_runtime.install()
    browser_bootstrap.install()
    install()
    browser_runtime.get_loop()
    _install_browser_plugin()
    _seed_models_dev_cache()
    import tui_gateway.server as _server  # noqa: F401 — import sanity

    _boot_web_app()
    sys.stderr.write("py_gateway boot: tui_gateway loaded\n")
