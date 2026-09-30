"""Local host substrate — opt-in T3 terminal backend driving the user's machine.

The provider registers a ``local_host`` terminal backend (plugin registry slot,
never shadowing built-ins). Commands run on the user's real OS via a companion
``host-agent.py`` they start themselves (127.0.0.1 only, token-paired); calls
go through ``py_gateway.host_call`` → the page's host-bridge → localhost fetch
with the vault-resolved token. The token never enters the Pyodide heap —
``local_host_pair`` collects it in page UI and vaults it; this module only ever
sees the non-secret vault handle persisted in HERMES_HOME.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, Optional

from agent.terminal_env_provider import TerminalEnvironmentProvider

logger = logging.getLogger(__name__)

_STATE_NAME = "local-host.json"


def _state_path() -> str:
    try:
        from hermes_constants import get_hermes_home
        base = str(get_hermes_home())
    except Exception:
        base = os.environ.get("HERMES_HOME") or os.path.expanduser("~")
    return os.path.join(base, _STATE_NAME)


def _load_state() -> Dict[str, Any]:
    try:
        with open(_state_path(), encoding="utf-8") as f:
            st = json.load(f)
            return st if isinstance(st, dict) else {}
    except Exception:
        return {}


def _save_state(st: Dict[str, Any]) -> None:
    try:
        with open(_state_path(), "w", encoding="utf-8") as f:
            json.dump(st, f)
    except Exception as exc:
        logger.warning("local_host: state write failed: %s", exc)


def _host_call(op: str, args: Optional[Dict[str, Any]] = None,
               timeout_s: float = 60.0) -> Dict[str, Any]:
    import py_gateway

    return py_gateway.host_call(op, args, timeout_s=timeout_s)


def _paired_args() -> Optional[Dict[str, Any]]:
    st = _load_state()
    if not st.get("handle"):
        return None
    return {"handle": st["handle"], "base": st.get("base") or None}


def _live_status() -> Dict[str, Any]:
    args = _paired_args()
    if args is None:
        return {"available": False, "reason": "not_paired"}
    try:
        resp = _host_call("status", args, timeout_s=8.0)
    except Exception:
        return {"available": False, "reason": "bridge_unreachable"}
    if not isinstance(resp, dict):
        return {"available": False, "reason": "bad_response"}
    if resp.get("error"):
        return {"available": False, "reason": resp["error"]}
    return {"available": True, "status": resp}


class BrowserHostEnvironment:
    """Duck-typed BaseEnvironment: blocking host exec → result dict.

    Same shape as BrowserWasiEnvironment: the agent's command lands verbatim
    in host-agent.py's `bash -c` on the user's machine — the upstream
    remote-environment contract, pointed at a user-attached host.
    """

    is_local = False

    def __init__(self, cwd: str = "", timeout: int = 120, env: Optional[dict] = None,
                 task_id: str = "default"):
        self.cwd = cwd or ""
        self.timeout = timeout or 120
        self.env = env or {}
        self.task_id = task_id

    def get_temp_dir(self) -> str:
        return "/tmp"

    def execute(self, command: str, cwd: str = "", *, timeout=None,
                stdin_data=None, **_kw) -> dict:
        args = _paired_args() or {}
        args.update({
            "command": command,
            "cwd": cwd or self.cwd,
            "stdin": stdin_data or "",
            "timeout_s": timeout or self.timeout,
            "env": self.env,
        })
        resp = _host_call("exec", args, timeout_s=(timeout or self.timeout) + 15.0)
        if not isinstance(resp, dict):
            return {"output": "[local_host: bad response]", "returncode": 127}
        if resp.get("error"):
            return {"output": f"[local_host unavailable: {resp['error']}]", "returncode": 127}
        out = str(resp.get("stdout") or "")
        err = str(resp.get("stderr") or "")
        return {"output": out + ("\n" + err if err else ""),
                "returncode": int(resp.get("exit_code", 1) or 0)}

    def init_session(self):
        return None

    def fetch_realpath(self, remote_path: str):
        result = self.execute(f"readlink -f {remote_path!r} 2>/dev/null")
        if int(result.get("returncode") or 0) != 0:
            return None
        for ln in reversed((result.get("output") or "").splitlines()):
            if ln.strip().startswith("/"):
                return ln.strip()
        return None

    def cleanup(self):
        pass


class LocalHostProvider(TerminalEnvironmentProvider):
    """TerminalEnvironmentProvider for the user-attached local host agent."""

    name = "local_host"
    display_name = "Local host agent"
    is_remote = True
    is_container = False  # the user's real machine — keep dangerous-command guards

    def is_available(self) -> bool:
        # Cheap paint-time check only: a persisted handle means paired once;
        # liveness is probed in check_requirements/probe.
        return bool(_load_state().get("handle"))

    def check_requirements(self, config: Dict[str, Any]) -> bool:
        status = _live_status()
        if status.get("available"):
            return True
        logger.warning(
            "local_host backend unavailable: %s",
            status.get("reason") or "not paired")
        return False

    def probe(self):
        if not _load_state().get("handle"):
            return "needs_setup", "not paired — run host-agent.py and pair"
        status = _live_status()
        if status.get("available"):
            st = status.get("status") or {}
            return "ready", st.get("platform") or "host reachable"
        return "needs_setup", status.get("reason") or "host unreachable"

    def setup_instructions(self):
        return [
            "Copy host-agent.py from your Hermes deployment onto the machine",
            "the agent should drive, then run: python3 host-agent.py",
            "Pair with the printed token via the `local_host_pair` tool — the",
            "token is vaulted in browser vault, never sent anywhere else.",
        ]

    def create_environment(self, *, cwd="/", timeout=120, task_id="default",
                           image=None, container_config=None, **_kw):
        return BrowserHostEnvironment(cwd=cwd, timeout=timeout, task_id=task_id)


# ------------------------------------------------------------------- tools

TOOLSET = "local_host"


def _tool_pair(args):
    resp = _host_call("pair", {"base": (args or {}).get("base")}, timeout_s=120.0)
    if not isinstance(resp, dict):
        return {"error": "bad response"}
    if resp.get("error"):
        return {"error": resp["error"]}
    _save_state({"handle": resp["handle"], "base": (args or {}).get("base") or "",
                 "paired_platform": (resp.get("status") or {}).get("platform")})
    return {"ok": True, "platform": (resp.get("status") or {}).get("platform"),
            "note": "token vaulted in browser vault; backend name: local_host"}


def _tool_status(_args):
    st = _load_state()
    live = _live_status()
    return {"paired": bool(st.get("handle")),
            "base": st.get("base") or "http://127.0.0.1:8788",
            "available": live.get("available", False),
            "status": live.get("status") or live.get("reason")}


def _tool_unpair(_args):
    st = _load_state()
    if st.get("handle"):
        _host_call("unpair", {"handle": st["handle"]}, timeout_s=15.0)
    try:
        os.remove(_state_path())
    except OSError:
        pass
    return {"ok": True, "note": "vault token revoked and pairing cleared"}


def _page_bridge_present() -> bool:
    """check_fn: the page's host-bridge must answer ping; pairing state is
    separate — the tools show even unpaired so the user can pair."""
    try:
        resp = _host_call("ping", {}, timeout_s=5.0)
    except Exception:
        return False
    return bool((resp or {}).get("ok"))


def register_tools(ctx) -> None:
    ctx.register_tool(
        name="local_host_pair",
        toolset=TOOLSET,
        schema={
            "type": "object",
            "description": "Pair with a local host agent (host-agent.py running on the "
                           "user's machine). Opens a page-side prompt for the pairing "
                           "token, vaults it in vault, and verifies connectivity. "
                           "Required before the 'local_host' terminal backend is usable.",
            "properties": {
                "base": {"type": "string",
                         "description": "Host agent URL (default http://127.0.0.1:8788)"},
            },
        },
        handler=_tool_pair,
        check_fn=_page_bridge_present,
    )
    ctx.register_tool(
        name="local_host_status",
        toolset=TOOLSET,
        schema={"type": "object",
                "description": "Report pairing state and reachability of the local host agent.",
                "properties": {}},
        handler=_tool_status,
        check_fn=_page_bridge_present,
    )
    ctx.register_tool(
        name="local_host_unpair",
        toolset=TOOLSET,
        schema={"type": "object",
                "description": "Revoke the pairing token in vault and forget the local "
                               "host pairing.",
                "properties": {}},
        handler=_tool_unpair,
        check_fn=_page_bridge_present,
    )
