"""pwa toolset — browser-grant capabilities for the in-browser agent.

Fixed ops execute in the page against the browser's own APIs
(``py_gateway.pwa_call`` → pwa-bridge.js): Notification, File System
Access real directories, mic/camera capture, Web Speech STT, wake lock,
and periodic-sync registration. Grants flow through the browser's own
permission prompts; FSA pickers surface a click target for the required
user activation. Everything is auditable via ``pwa_status``.

Tools return JSON strings per upstream registry contract. ``check_fn``
answers reachability only: does the page bridge answer status.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict

TOOLSET = "pwa"


def _pwa() -> Callable[..., Dict[str, Any]]:
    import py_gateway

    return py_gateway.pwa_call


def pwa_bridge_present() -> bool:
    """check_fn: True only when the page's pwa-bridge answers status."""
    try:
        resp = _pwa()("status", timeout_s=8.0)
        return isinstance(resp, dict) and bool(resp.get("ok"))
    except Exception:
        return False


def _call(op: str, args: Dict[str, Any], timeout_s: float = 60.0) -> str:
    try:
        resp = _pwa()(op, args, timeout_s=timeout_s)
    except Exception as err:
        return json.dumps({"success": False, "error": f"pwa_unreachable: {err}"})
    if not isinstance(resp, dict):
        return json.dumps({"success": False, "error": "pwa_bad_response"})
    if resp.get("error"):
        return json.dumps({"success": False, **resp})
    return json.dumps({"success": True, **resp})


_SCHEMAS: Dict[str, Dict[str, Any]] = {
    "pwa_status": {
        "name": "pwa_status",
        "description": "Report which browser capabilities are available and the current "
                       "grant state (notifications, real-directory access, mic, camera, "
                       "speech-to-text, wake lock, periodic background sync, WebGPU).",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "pwa_notify": {
        "name": "pwa_notify",
        "description": "Show a browser notification to the user. Requests notification "
                       "permission on first use.",
        "parameters": {"type": "object", "properties": {
            "title": {"type": "string", "description": "Notification title"},
            "body": {"type": "string", "description": "Notification body text"},
            "tag": {"type": "string", "description": "Optional tag to replace a prior notification"},
        }, "required": ["title"]},
    },
    "pwa_fs_pick_dir": {
        "name": "pwa_fs_pick_dir",
        "description": "Ask the user to grant access to a real directory on their device "
                       "(Chromium File System Access). Surfaces a click target for the "
                       "required user activation; the granted handle persists across "
                       "reloads and returns a dir_id for the other pwa_fs_* tools.",
        "parameters": {"type": "object", "properties": {
            "mode": {"type": "string", "enum": ["read", "rw"],
                     "description": "read or read-write (default read)"},
        }, "required": []},
    },
    "pwa_fs_list": {
        "name": "pwa_fs_list",
        "description": "List entries of a previously granted directory (pwa_fs_pick_dir).",
        "parameters": {"type": "object", "properties": {
            "dir_id": {"type": "string", "description": "Handle id returned by pwa_fs_pick_dir"},
        }, "required": ["dir_id"]},
    },
    "pwa_fs_read": {
        "name": "pwa_fs_read",
        "description": "Read a file from a granted directory; returns body_b64 (max 8MB).",
        "parameters": {"type": "object", "properties": {
            "dir_id": {"type": "string"},
            "path": {"type": "string", "description": "File name within the directory"},
        }, "required": ["dir_id", "path"]},
    },
    "pwa_fs_write": {
        "name": "pwa_fs_write",
        "description": "Write a file into a granted directory (requires rw pick). "
                       "body_b64 is base64 file content.",
        "parameters": {"type": "object", "properties": {
            "dir_id": {"type": "string"},
            "path": {"type": "string"},
            "body_b64": {"type": "string", "description": "Base64-encoded file content"},
        }, "required": ["dir_id", "path", "body_b64"]},
    },
    "pwa_fs_forget": {
        "name": "pwa_fs_forget",
        "description": "Drop a granted directory handle (revoke agent access to it).",
        "parameters": {"type": "object", "properties": {
            "dir_id": {"type": "string"},
        }, "required": ["dir_id"]},
    },
    "pwa_mic_record": {
        "name": "pwa_mic_record",
        "description": "Record the microphone for up to 60 seconds (browser permission "
                       "prompt on first use). Returns audio_b64 (webm/opus).",
        "parameters": {"type": "object", "properties": {
            "seconds": {"type": "integer", "description": "Duration 1-60 (default 5)"},
        }, "required": []},
    },
    "pwa_stt_listen": {
        "name": "pwa_stt_listen",
        "description": "One-shot speech-to-text via the browser's SpeechRecognition. "
                       "Returns a transcript of what the user says.",
        "parameters": {"type": "object", "properties": {
            "lang": {"type": "string", "description": "BCP-47 tag (default en-US)"},
            "timeout_s": {"type": "integer", "description": "Max listen seconds (default 15)"},
        }, "required": []},
    },
    "pwa_vision_snap": {
        "name": "pwa_vision_snap",
        "description": "Capture one frame from the user's camera (browser permission "
                       "prompt on first use). Returns image_b64 (JPEG) for vision models.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "pwa_wakelock": {
        "name": "pwa_wakelock",
        "description": "Acquire or release a screen wake lock so long-running work isn't "
                       "suspended by the OS.",
        "parameters": {"type": "object", "properties": {
            "action": {"type": "string", "enum": ["acquire", "release"]},
        }, "required": ["action"]},
    },
    "pwa_periodic_sync": {
        "name": "pwa_periodic_sync",
        "description": "Register a periodic-background-sync tag (installed-PWA Chromium "
                       "feature) as a wake hint for scheduled work. While-online cron "
                       "itself is upstream's cronjob_manage.",
        "parameters": {"type": "object", "properties": {
            "tag": {"type": "string", "description": "Sync tag (default hermes-cron)"},
            "min_interval_ms": {"type": "integer",
                                "description": "Minimum interval; browsers enforce >= ~12h"},
        }, "required": []},
    },
    "pwa_periodic_list": {
        "name": "pwa_periodic_list",
        "description": "List registered periodic-sync tags.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
}


def _handler_for(op: str, args_mapper: Callable[[Dict[str, Any]], Dict[str, Any]],
                 timeout_s: float = 60.0) -> Callable:
    def handler(args: Dict[str, Any], **_kw: Any) -> str:
        return _call(op, args_mapper(args or {}), timeout_s=timeout_s)
    return handler


def _identity(args: Dict[str, Any]) -> Dict[str, Any]:
    return dict(args)


_BINDINGS = [
    ("pwa_status", "status", _identity, 15.0),
    ("pwa_notify", "notify", _identity, 60.0),
    ("pwa_fs_pick_dir", "fs.pick_dir", _identity, 150.0),
    ("pwa_fs_list", "fs.list", _identity, 60.0),
    ("pwa_fs_read", "fs.read", _identity, 90.0),
    ("pwa_fs_write", "fs.write", _identity, 90.0),
    ("pwa_fs_forget", "fs.forget", _identity, 30.0),
    ("pwa_mic_record", "mic.record", _identity, 90.0),
    ("pwa_stt_listen", "stt.listen", _identity, 90.0),
    ("pwa_vision_snap", "vision.snap", _identity, 90.0),
    ("pwa_wakelock", None, _identity, 30.0),  # op resolved from action
    ("pwa_periodic_sync", "periodic.register", _identity, 60.0),
    ("pwa_periodic_list", "periodic.list", _identity, 30.0),
]


def register_tools(ctx) -> None:
    for name, op, mapper, timeout in _BINDINGS:
        if name == "pwa_wakelock":
            def wl_handler(args: Dict[str, Any], **_kw: Any) -> str:
                action = (args or {}).get("action", "acquire")
                return _call("wakelock." + ("release" if action == "release" else "acquire"),
                             {}, timeout_s=30.0)
            handler = wl_handler
        else:
            handler = _handler_for(op, mapper, timeout)
        ctx.register_tool(
            name=name, toolset=TOOLSET, schema=_SCHEMAS[name],
            handler=handler,
            check_fn=pwa_bridge_present,
            description=_SCHEMAS[name]["description"],
        )
