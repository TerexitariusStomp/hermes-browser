"""WASI terminal environment — real Linux/POSIX userspace inside the browser tab.

The provider registers a ``wasi`` terminal backend (plugin registry slot, never
shadowing built-ins). Its environment runs commands in a WASI userspace shipped
with the page (cowasm kernel + dash/coreutils wasm binaries), bridged through
``py_gateway.wasi_call`` → the page's WASI runner. No host access, no network
egress inside the sandbox beyond what the page grants.
"""

from __future__ import annotations

import io
import logging
from typing import Any, Dict, Optional

from agent.terminal_env_provider import TerminalEnvironmentProvider

logger = logging.getLogger(__name__)


def _wasi_call(op: str, args: Optional[Dict[str, Any]] = None,
               timeout_s: float = 60.0) -> Dict[str, Any]:
    import py_gateway

    return py_gateway.wasi_call(op, args, timeout_s=timeout_s)


def _wasi_status() -> Dict[str, Any]:
    try:
        resp = _wasi_call("status", timeout_s=5.0)
    except Exception:
        return {"available": False, "reason": "bridge_unreachable"}
    if not isinstance(resp, dict):
        return {"available": False, "reason": "bad_response"}
    return resp


class _DoneProcessHandle:
    """ProcessHandle for an exec that already completed (single-shot WASI run)."""

    def __init__(self, output: str, returncode: int):
        self._stdout = io.StringIO(output or "")
        self._rc = returncode

    @property
    def stdout(self):
        return self._stdout

    @property
    def returncode(self):
        return self._rc

    def poll(self):
        return self._rc

    def wait(self, timeout=None):
        return self._rc

    def kill(self):
        pass


class BrowserWasiEnvironment:
    """Duck-typed BaseEnvironment: blocking wasi exec → completed handle.

    Deliberately not a BaseEnvironment subclass: upstream execute() wraps
    commands with snapshot-sourcing and login-shell flags meant for bash on a
    real host. The WASI runner owns shell semantics page-side (``dash -c``);
    overriding execute() keeps the command verbatim.
    """

    is_local = False

    def __init__(self, cwd: str = "/", timeout: int = 120, env: Optional[dict] = None,
                 task_id: str = "default"):
        self.cwd = cwd or "/"
        self.timeout = timeout or 120
        self.env = env or {}
        self.task_id = task_id

    def get_temp_dir(self) -> str:
        return "/tmp"

    def execute(self, command: str, cwd: str = "", *, timeout=None,
                stdin_data=None, **_kw) -> dict:
        resp = _wasi_call("exec", {
            "command": command,
            "cwd": cwd or self.cwd,
            "stdin": stdin_data or "",
            "timeout_s": timeout or self.timeout,
            "env": self.env,
        }, timeout_s=(timeout or self.timeout) + 15.0)
        if not isinstance(resp, dict):
            return {"output": "[wasi: bad response]", "returncode": 127}
        if resp.get("error"):
            return {"output": f"[wasi unavailable: {resp['error']}]", "returncode": 127}
        out = str(resp.get("stdout") or "")
        err = str(resp.get("stderr") or "")
        return {"output": out + ("\n" + err if err else ""),
                "returncode": int(resp.get("exit_code", 1) or 0)}

    def init_session(self):
        # Snapshot/login-shell bootstrapping is a host-bash concept; the WASI
        # runner has its own env. Kept for duck-type parity.
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


class BrowserWasiProvider(TerminalEnvironmentProvider):
    """TerminalEnvironmentProvider for the in-browser WASI backend."""

    name = "wasi"
    display_name = "Browser WASI (cowasm)"
    is_remote = False
    is_container = True

    def is_available(self) -> bool:
        return bool(_wasi_status().get("available"))

    def check_requirements(self, config: Dict[str, Any]) -> bool:
        status = _wasi_status()
        if status.get("available"):
            return True
        logger.warning(
            "wasi terminal backend unavailable: %s",
            status.get("reason") or "runtime not loaded")
        return False

    def probe(self):
        status = _wasi_status()
        if status.get("available"):
            return "ready", status.get("detail") or "WASI userspace loaded"
        return "needs_setup", status.get("reason") or "WASI runtime not installed"

    def setup_instructions(self):
        return [
            "The browser WASI userspace ships with the hermes-web build.",
            "If unavailable, rebuild the web assets (scripts/assemble.mjs vendors cowasm).",
        ]

    def create_environment(self, *, cwd="/", timeout=120, task_id="default",
                           image=None, container_config=None, **_kw):
        return BrowserWasiEnvironment(cwd=cwd, timeout=timeout, task_id=task_id)
