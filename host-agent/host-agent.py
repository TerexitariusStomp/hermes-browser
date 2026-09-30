#!/usr/bin/env python3
"""hermes-host-agent — opt-in local substrate for the browser Hermes gateway.

Run this on the machine you want the in-browser agent to drive:

    python3 host-agent.py            # prints the pairing token once
    python3 host-agent.py --port 8788

It serves a tiny fixed-op HTTP API on 127.0.0.1 ONLY (no LAN exposure):

    GET  /status   -> {ok, platform, version}        (X-Host-Token required)
    POST /exec     -> {command,cwd,env,stdin,timeout_s} => {stdout,stderr,exit_code}

The browser page running the in-browser Hermes gateway pairs by prompting
for the token; the token is stored in the vault worker (AES-GCM IndexedDB,
non-extractable device key) and resolved page-side at fetch time — the
Pyodide agent heap never holds it. Every request is authenticated,
CORS-restricted to configured origins, and Chrome Private-Network-Access
preflights are answered explicitly.

Exec runs `bash -c` (falls back to `sh`) with the agent user's environment.
Pairing grants real shell on this host — treat the token like a password;
stop the agent (or `local_host_unpair` / vault revoke) to cut access.

The token is persisted at ~/.hermes/host-agent.json (mode 600) so restarts
stay paired. Delete that file to rotate.
"""

import json
import os
import secrets
import shutil
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = 8788
MAX_TIMEOUT_S = 900
MAX_OUTPUT = 4 * 1024 * 1024
STATE_PATH = os.path.expanduser("~/.hermes/host-agent.json")
# Origins allowed to call this agent. Set HERMES_HOST_ORIGINS to a
# comma-separated list of the HTTPS origins serving your Hermes page, e.g.
#   HERMES_HOST_ORIGINS="https://hermes.example.com" python3 host-agent.py
ALLOWED_ORIGINS = {
    o.strip() for o in os.environ.get("HERMES_HOST_ORIGINS", "").split(",") if o.strip()
}
ALLOWED_ORIGIN_PREFIXES = ("http://localhost:", "http://127.0.0.1:")


def load_or_create_token():
    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            tok = json.load(f).get("token")
            if tok:
                return tok
    except Exception:
        pass
    tok = secrets.token_urlsafe(32)
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    fd = os.open(STATE_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"token": tok}, f)
    return tok


def origin_allowed(origin):
    if origin in ALLOWED_ORIGINS:
        return True
    return any(origin.startswith(p) for p in ALLOWED_ORIGIN_PREFIXES)


class Handler(BaseHTTPRequestHandler):
    server_version = "hermes-host-agent/0.1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet; stderr flag only on errors
        if args and isinstance(args[1], str) and args[1].startswith("4"):
            sys.stderr.write("[host-agent] " + fmt % args + "\n")

    def _cors(self):
        origin = self.headers.get("Origin") or ""
        if origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _send(self, code, obj=None):
        body = json.dumps(obj or {}).encode() if obj is not None else b""
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _authed(self):
        tok = self.headers.get("X-Host-Token") or ""
        return secrets.compare_digest(tok, self.server.token)

    def do_OPTIONS(self):
        # Chrome Private Network Access + CORS preflight.
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type, x-host-token")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path != "/status":
            return self._send(404, {"error": "unknown path"})
        if not self._authed():
            return self._send(401, {"error": "bad token"})
        import platform
        self._send(200, {"ok": True, "platform": platform.platform(),
                         "version": self.server_version, "cwd": os.path.expanduser("~")})

    def do_POST(self):
        if self.path != "/exec":
            return self._send(404, {"error": "unknown path"})
        if not self._authed():
            return self._send(401, {"error": "bad token"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            args = json.loads(self.rfile.read(min(n, MAX_OUTPUT)) or b"{}")
        except Exception:
            return self._send(400, {"error": "bad json"})
        command = str(args.get("command") or "")
        if not command.strip():
            return self._send(400, {"error": "empty command"})
        cwd = str(args.get("cwd") or "") or os.path.expanduser("~")
        if not os.path.isdir(cwd):
            return self._send(400, {"error": f"cwd not found: {cwd}"})
        timeout = min(int(args.get("timeout_s") or 120), MAX_TIMEOUT_S)
        env = dict(os.environ)
        extra = args.get("env")
        if isinstance(extra, dict):
            env.update({str(k): str(v) for k, v in extra.items()})
        shell = shutil.which("bash") or shutil.which("sh") or os.environ.get("COMSPEC")
        if not shell:
            return self._send(500, {"error": "no shell found"})
        argv = [shell, "-c", command] if not shell.lower().endswith(".exe") else command
        try:
            p = subprocess.run(
                argv, cwd=cwd, env=env, input=(args.get("stdin") or "").encode(),
                capture_output=True, timeout=timeout)
            out, err, rc = p.stdout, p.stderr, p.returncode
        except subprocess.TimeoutExpired as e:
            out, err, rc = e.stdout or b"", (e.stderr or b"") + b"\n[host-agent: timeout]", 124
        except Exception as e:
            return self._send(500, {"error": str(e)[:300]})
        trunc = lambda b: b[-MAX_OUTPUT:] + b"\n[host-agent: output truncated]" if len(b) > MAX_OUTPUT else b
        self._send(200, {"stdout": trunc(out).decode("utf-8", "replace"),
                         "stderr": trunc(err).decode("utf-8", "replace"),
                         "exit_code": rc})


class Server(ThreadingHTTPServer):
    daemon_threads = True


def main():
    import argparse
    ap = argparse.ArgumentParser(description="Hermes browser-gateway local host substrate")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--token", help="explicit pairing token (else generated/persisted)")
    args = ap.parse_args()

    srv = Server(("127.0.0.1", args.port), Handler)
    srv.token = args.token or load_or_create_token()
    print(f"[hermes-host-agent] listening on http://127.0.0.1:{args.port}")
    print(f"[hermes-host-agent] pairing token: {srv.token}")
    print("[hermes-host-agent] paste it into the Hermes page's Local Host pairing prompt")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
