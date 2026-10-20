"""This agent's Wayza address: a key from the caller, WAYZA_KEY, or a file; signed up on first use.

The account is wayza_human's (``wayza_human.tools.WayzaAccount``), so LangChain agents follow the same
rules as the other frameworks: the claim link is told once, a key that can't be saved is kept for the
run, and on a hosted server the agent asks for ``WAYZA_KEY`` instead of signing up again at every start.
"""

from __future__ import annotations

import os

from wayza_human.tools import WayzaAccount as _Account

DEFAULT_KEY_FILE = "~/.wayza/langchain.json"


class WayzaAccount(_Account):
    """Finds this agent's key, or signs it up the first time a tool needs an address.

    The key is looked for in this order: ``key``, the ``WAYZA_KEY`` environment variable, then
    ``key_file`` (default ``~/.wayza/langchain.json``).
    """

    def __init__(
        self,
        key: str | None = None,
        *,
        name: str = "LangChain agent",
        home: str | None = None,
        key_file: str | os.PathLike | None = None,
        sign_up: bool = True,
        insecure: bool = False,
    ):
        super().__init__(key, name=name, platform="langchain", home=home, key_file=key_file or DEFAULT_KEY_FILE,
                         sign_up=sign_up, insecure=insecure)
