"""browser_ext toolset — real browser control through the Hermes substrate extension substrate.

Every tool maps 1:1 to a fixed, hardcoded op in the extension background page
(``SUBSTRATE_OPS``). The page supplies data (URL, selector, text) — never code —
and the extension only acts on tabs the grant itself opened. Grants are
user-consented per origin, audited, and revocable in the extension popup.

Tools return JSON strings per upstream registry contract. ``check_fn`` answers
reachability only: is the extension bridge live for this profile's page.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Dict

TOOLSET = "browser_ext"


def _substrate() -> Callable[..., Dict[str, Any]]:
    import py_gateway

    return py_gateway.substrate_call


def extension_present() -> bool:
    """check_fn: True only when the Hermes substrate extension substrate answers."""
    try:
        resp = _substrate()("status", timeout_s=8.0)
        return isinstance(resp, dict) and not resp.get("error")
    except Exception:
        return False


def _call(op: str, args: Dict[str, Any], timeout_s: float = 90.0) -> str:
    try:
        resp = _substrate()(op, args, timeout_s=timeout_s)
    except Exception as err:
        return json.dumps({"success": False, "error": f"substrate_unreachable: {err}"})
    if not isinstance(resp, dict):
        return json.dumps({"success": False, "error": "substrate_bad_response"})
    if resp.get("error"):
        return json.dumps({"success": False, "error": resp["error"]})
    return json.dumps({"success": True, **resp})


def _tab_id(args: Dict[str, Any]) -> int:
    return int(args.get("tab_id") or args.get("tabId") or 0)


_SCHEMAS: Dict[str, Dict[str, Any]] = {
    "browser_ext_status": {
        "name": "browser_ext_status",
        "description": "Check whether the user's browser extension substrate is installed, "
                       "granted, and what browser ops are currently permitted.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "browser_ext_request_grant": {
        "name": "browser_ext_request_grant",
        "description": "Ask the user to grant browser-tab control. Opens the extension's "
                       "consent window; the grant covers only tabs this agent opens itself, "
                       "expires after a working session, and is revocable in the extension.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "browser_ext_open_tab": {
        "name": "browser_ext_open_tab",
        "description": "Open a new browser tab under the agent's grant. Returns the tab_id "
                       "all other browser_ext tools act on. The agent can only control tabs "
                       "it opened — never the user's own tabs.",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string", "description": "http(s) URL or about:blank"},
            "active": {"type": "boolean", "description": "Focus the tab (default false)"},
        }, "required": ["url"]},
    },
    "browser_ext_list_tabs": {
        "name": "browser_ext_list_tabs",
        "description": "List tabs currently owned by the agent's browser grant.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "browser_ext_close_tab": {
        "name": "browser_ext_close_tab",
        "description": "Close a grant-owned tab by tab_id.",
        "parameters": {"type": "object", "properties": {
            "tab_id": {"type": "integer", "description": "Grant-owned tab id"},
        }, "required": ["tab_id"]},
    },
    "browser_ext_navigate": {
        "name": "browser_ext_navigate",
        "description": "Navigate a grant-owned tab to an http(s) URL.",
        "parameters": {"type": "object", "properties": {
            "tab_id": {"type": "integer"},
            "url": {"type": "string", "description": "http(s) URL"},
        }, "required": ["tab_id", "url"]},
    },
    "browser_ext_click": {
        "name": "browser_ext_click",
        "description": "Click an element in a grant-owned tab, selected by CSS selector. "
                       "Use browser_ext_snapshot to discover selectors.",
        "parameters": {"type": "object", "properties": {
            "tab_id": {"type": "integer"},
            "selector": {"type": "string", "description": "CSS selector of the element"},
        }, "required": ["tab_id", "selector"]},
    },
    "browser_ext_type": {
        "name": "browser_ext_type",
        "description": "Type text into an input, textarea, or contenteditable element in a "
                       "grant-owned tab, selected by CSS selector.",
        "parameters": {"type": "object", "properties": {
            "tab_id": {"type": "integer"},
            "selector": {"type": "string"},
            "text": {"type": "string", "description": "Text to enter (max 4000 chars)"},
        }, "required": ["tab_id", "selector", "text"]},
    },
    "browser_ext_scroll": {
        "name": "browser_ext_scroll",
        "description": "Scroll a grant-owned tab by x/y pixels.",
        "parameters": {"type": "object", "properties": {
            "tab_id": {"type": "integer"},
            "x": {"type": "integer", "description": "Horizontal delta (default 0)"},
            "y": {"type": "integer", "description": "Vertical delta (default 600)"},
        }, "required": ["tab_id"]},
    },
    "browser_ext_snapshot": {
        "name": "browser_ext_snapshot",
        "description": "Serialize a grant-owned tab's DOM into a compact accessibility-like "
                       "text tree (interactive elements get CSS selectors for click/type). "
                       "This is how the agent reads pages.",
        "parameters": {"type": "object", "properties": {
            "tab_id": {"type": "integer"},
        }, "required": ["tab_id"]},
    },
    "browser_ext_screenshot": {
        "name": "browser_ext_screenshot",
        "description": "Capture a JPEG screenshot (data URL) of a grant-owned tab's viewport.",
        "parameters": {"type": "object", "properties": {
            "tab_id": {"type": "integer"},
        }, "required": ["tab_id"]},
    },
}


def _handler_for(op: str, args_mapper: Callable[[Dict[str, Any]], Dict[str, Any]],
                 timeout_s: float = 90.0) -> Callable:
    def handler(args: Dict[str, Any], **_kw: Any) -> str:
        return _call(op, args_mapper(args or {}), timeout_s=timeout_s)
    return handler


def _identity(args: Dict[str, Any]) -> Dict[str, Any]:
    return dict(args)


_BINDINGS = [
    ("browser_ext_status", "status", _identity, 15.0),
    ("browser_ext_request_grant", "grant.request", _identity, 180.0),
    ("browser_ext_open_tab", "tabs.create", _identity, 60.0),
    ("browser_ext_list_tabs", "tabs.list", _identity, 15.0),
    ("browser_ext_close_tab", "tabs.close",
     lambda a: {"tabId": _tab_id(a)}, 30.0),
    ("browser_ext_navigate", "navigate",
     lambda a: {"tabId": _tab_id(a), "url": a.get("url", "")}, 90.0),
    ("browser_ext_click", "click",
     lambda a: {"tabId": _tab_id(a), "selector": a.get("selector", "")}, 60.0),
    ("browser_ext_type", "type",
     lambda a: {"tabId": _tab_id(a), "selector": a.get("selector", ""),
                "text": a.get("text", "")}, 60.0),
    ("browser_ext_scroll", "scroll",
     lambda a: {"tabId": _tab_id(a), "x": int(a.get("x") or 0),
                "y": int(a.get("y") or 600)}, 30.0),
    ("browser_ext_snapshot", "snapshot",
     lambda a: {"tabId": _tab_id(a)}, 60.0),
    ("browser_ext_screenshot", "screenshot",
     lambda a: {"tabId": _tab_id(a)}, 60.0),
]


def register_tools(ctx) -> None:
    for name, op, mapper, timeout in _BINDINGS:
        ctx.register_tool(
            name=name, toolset=TOOLSET, schema=_SCHEMAS[name],
            handler=_handler_for(op, mapper, timeout),
            check_fn=extension_present,
            description=_SCHEMAS[name]["description"],
        )
