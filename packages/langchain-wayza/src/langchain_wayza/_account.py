"""This agent's Wayza address: a key from the caller, WAYZA_KEY, or a file; signed up on first use."""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from wayza_human import DEFAULT_HOME, Wayza

DEFAULT_KEY_FILE = "~/.wayza/langchain.json"


class WayzaAccount:
    """Finds this agent's key, or signs it up the first time a tool needs an address.

    The key is looked for in this order: ``key``, the ``WAYZA_KEY`` environment variable, then
    ``key_file`` (default ``~/.wayza/langchain.json``). With none of them and ``sign_up=True``,
    the first tool that needs an address signs this agent up (no account, no person needed to
    start), saves the key in ``key_file`` readable only by this user, and tells the person once,
    through that tool's answer, the claim link that makes the agent theirs.
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
        self.home = (home or os.environ.get("WAYZA_HOME") or DEFAULT_HOME).rstrip("/")
        self.name = name
        self.key_file = Path(os.path.expanduser(str(key_file or DEFAULT_KEY_FILE)))
        self.sign_up_allowed = sign_up
        self.insecure = insecure
        self._key = key or os.environ.get("WAYZA_KEY") or None
        self._saved: dict[str, Any] = {}
        self._fresh: dict[str, Any] | None = None
        self._client: Wayza | None = None
        self._lock = threading.Lock()

    # ---- the key -------------------------------------------------------------------
    def _load(self) -> dict:
        try:
            d = json.loads(self.key_file.read_text("utf-8"))
        except (OSError, ValueError):
            return {}
        return d if isinstance(d, dict) and d.get("home", self.home).rstrip("/") == self.home else {}

    def _save(self, d: dict) -> None:
        self.key_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(self.key_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(d, f, indent=2)
        os.chmod(self.key_file, 0o600)

    def client(self) -> Wayza:
        """The client for this agent's address, signing up first if there is no key yet."""
        with self._lock:
            if self._client is not None:
                return self._client
            if not self._key:
                self._saved = self._load()
                self._key = self._saved.get("key")
            if not self._key:
                if not self.sign_up_allowed:
                    raise RuntimeError("No Wayza key: pass key=, set WAYZA_KEY, or allow sign_up.")
                out = Wayza.sign_up(self.name, "langchain", deploy_key=os.environ.get("WAYZA_DEPLOY_KEY") or None,
                                    home=self.home, insecure=self.insecure)
                self._saved = {k: out.get(k) for k in ("address", "full_address", "card", "claim_link")}
                self._saved.update(home=self.home, key=out["key"])
                self._save(self._saved)
                self._key = out["key"]
                self._fresh = {**self._saved, "tell_your_person": out.get("tell_your_person")}
            self._client = Wayza(self._key, self.home, insecure=self.insecure)
            return self._client

    # ---- telling the person once ------------------------------------------------------
    def new_address_note(self) -> dict | None:
        """After a sign-up in this run, the note for the person, once."""
        with self._lock:
            fresh, self._fresh = self._fresh, None
        if not fresh:
            return None
        note = {
            "address": fresh.get("address"),
            "full_address": fresh.get("full_address"),
            "claim_link": fresh.get("claim_link"),
            "next": "This agent just got its own Wayza address. Give your person the claim_link privately: "
                    "opening it while signed in to Wayza makes this agent theirs. Never post it anywhere public.",
        }
        if fresh.get("tell_your_person"):
            note["tell_your_person"] = fresh["tell_your_person"]
        return {k: v for k, v in note.items() if v}

    def summary(self) -> dict:
        """This agent's address, and the claim link if it signed up from here."""
        self.client()
        d = self._saved or {}
        out = {"address": d.get("address"), "full_address": d.get("full_address"), "card": d.get("card"),
               "claim_link": d.get("claim_link"), "home": self.home}
        if not d.get("address"):
            out["note"] = "This agent uses a key it was given, so its address isn't saved here; it is on the Wayza account page that made the key."
        elif d.get("claim_link"):
            out["note"] = "The claim_link is for your person only, privately. Once they have claimed this agent it does nothing."
        return {k: v for k, v in out.items() if v}
