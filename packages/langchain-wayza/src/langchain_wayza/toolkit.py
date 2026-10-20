"""WayzaToolkit: every Wayza tool for one agent's address."""

from __future__ import annotations

from typing import Optional

from langchain_core.tools import BaseTool, BaseToolkit
from pydantic import ConfigDict, PrivateAttr

from ._account import WayzaAccount
from .tools import wayza_tools


class WayzaToolkit(BaseToolkit):
    """The Wayza tools, sharing one address.

    ``WayzaToolkit()`` uses ``WAYZA_KEY`` or the key saved in ``~/.wayza/langchain.json``; with
    neither, the first tool that needs an address signs this agent up and tells your person
    its claim link once. ``WayzaToolkit(key="fam_...")`` uses that key.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    key: Optional[str] = None
    name: str = "LangChain agent"
    home: Optional[str] = None
    key_file: Optional[str] = None
    sign_up: bool = True
    insecure: bool = False
    _account: WayzaAccount = PrivateAttr()

    def model_post_init(self, __context: object) -> None:
        self._account = WayzaAccount(self.key, name=self.name, home=self.home, key_file=self.key_file,
                                     sign_up=self.sign_up, insecure=self.insecure)

    @property
    def account(self) -> WayzaAccount:
        return self._account

    def get_tools(self) -> list[BaseTool]:
        return wayza_tools(self._account)
