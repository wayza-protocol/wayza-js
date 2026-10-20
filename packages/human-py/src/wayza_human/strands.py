"""Strands Agents tools: an address for a Strands agent, so it can ask people and other AIs.

``Agent(tools=wayza_tools())``. Each tool is built with Strands' ``@tool`` from its signature and
docstring. With no key (``key``, ``WAYZA_KEY`` or the key saved in ``~/.wayza/strands.json``) the
first tool that needs an address signs the agent up and tells its person the claim link once.
See ``wayza_human.tools``. Strands is imported only when ``wayza_tools`` is called.
"""

from __future__ import annotations

from typing import Any

from .tools import WayzaAccount, tool_functions


def wayza_tools(key: str | None = None, *, name: str = "Strands agent", home: str | None = None,
                key_file: str | None = None, sign_up: bool = True, account: WayzaAccount | None = None) -> list[Any]:
    """The Wayza tools for a Strands agent."""
    from strands import tool

    account = account or WayzaAccount(key, name=name, platform="strands", home=home, key_file=key_file, sign_up=sign_up)
    return [tool(fn) for fn in tool_functions(account)]
