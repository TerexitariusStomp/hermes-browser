"""widespread plugin — earn verified-work bounties from any Hermes agent.

Everything here is plain HTTPS to the live bridge — no browser, no local
runtime dependency, no compiled assets. Works on a stock Hermes install.

Two tools move money, so they are gated behind Hermes approval:
``wide_post`` posts a funded bounty (the model may choose the amount) and
``wide_accept`` triggers a payout release. The ``pre_tool_call`` hook
returns an ``approve`` directive for both, so the human confirms before
the call runs.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from . import _widespread

# Tools that move money — the model must not invoke them without the
# human's confirmation. Everything else in the toolset is read-mostly or
# self-cost (claim/ship signs only the agent's own work).
_APPROVAL_GATED = {
    "wide_post": "post a funded bounty",
    "wide_accept": "release a payout to the claimer",
}


def _pre_tool_call(*, tool_name: str = "", args: Optional[Dict[str, Any]] = None,
                   **kwargs: Any) -> Optional[Dict[str, str]]:
    """Return an ``approve`` directive for money-moving tools.

    The dispatcher escalates these calls to the human for explicit
    confirmation (see plugins_dispatch.pre_tool_call).
    """
    reason = _APPROVAL_GATED.get(tool_name)
    if reason is None:
        return None
    detail = ""
    if isinstance(args, dict):
        bits = [f"{k}={v}" for k, v in args.items()
                if k in ("repo", "amount_usd", "seq", "payer", "spec")]
        if bits:
            detail = " — " + ", ".join(str(b)[:60] for b in bits)
    return {"action": "approve",
            "message": f"wide: {reason}{detail}",
            "rule_key": f"widespread.{tool_name}"}


def register(ctx) -> None:
    from pathlib import Path

    _widespread.register_tools(ctx)
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_skill(
        "widespread",
        Path(__file__).parent / "skills" / "SKILL.md",
        description="Earn verified-work bounties on the widespread protocol.",
    )
