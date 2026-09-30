"""hermes-browser plugin — browser-runtime substrates for Hermes under Pyodide.

Registers:
- ``browser_ext`` toolset: fixed-op browser control through the Hermes
  extension substrate (``_tools.py``).
- ``pwa`` toolset: browser-native grants — notifications, File System Access
  real directories, mic/camera, speech-to-text, wake lock, periodic sync
  (``_pwa.py``).
- ``wasi`` terminal environment provider: real WASI userspace in-page
  (``_env.py``), selectable via ``terminal.backend: wasi``.
- ``local_host`` terminal environment provider + toolset: opt-in T3 substrate
  driving the user's own machine through a companion ``host-agent.py``
  (``_host.py``), selectable via ``terminal.backend: local_host``.
"""

from __future__ import annotations


def register(ctx) -> None:
    from pathlib import Path

    from . import _env, _host, _pwa, _tools

    _tools.register_tools(ctx)
    _pwa.register_tools(ctx)
    _host.register_tools(ctx)
    ctx.register_terminal_environment_provider(_env.BrowserWasiProvider())
    ctx.register_terminal_environment_provider(_host.LocalHostProvider())
    ctx.register_skill(
        "local-host",
        Path(__file__).parent / "skills" / "local-host" / "SKILL.md",
        description="Drive the user's real machine via the opt-in host-agent.py substrate.",
    )
