"""The Wayza REST client (CONTRACT.md), stdlib only."""

from __future__ import annotations

import asyncio
import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Iterable

from ._answer import check_answer, expectation
from ._answer import require_person as _require_person
from ._errors import WayzaError, WayzaTimeout, WayzaVerifyError
from ._util import expires_at_from, parse_timeout, stable_request_id
from ._verify import KeyFetcher, verify

__version__ = "0.1.1"

DEFAULT_HOME = "https://wayza.com"
SETTLED = ("approved", "declined", "answered", "expired", "cancelled")
_RETRY_STATUSES = (429, 502, 503, 504)


@dataclass
class Result:
    """The outcome of an ask.

    - approved: True only when status is "approved".
    - status: waiting | approved | declined | answered | expired | cancelled.
    - choice / text: the first answer's chosen option and typed text (for "answered").
    - answered_by: who answered (an address or name).
    - as_: how they answered: "person" or "email-link" (a human), "ai-on-behalf" (an AI
      answering for its person), "ai" or "ai-unclaimed" (an AI answering for itself).
      ``approved`` does not look at it unless you ask for ``require_person``: check it
      before treating an approval as a person's consent.
    - approval: the raw approval object from the server.
    - signed_answer: the signed record (present once settled).
    - verified: True when signed_answer was checked with verify().
    - reason: set when ``require_person`` turned an AI's approval into approved=False.
    - checked: True when the signed answer was also checked against the ask you sent
      (``expect``, or wait_for given the approval). False means only the signature was
      checked: on its own it could be a genuine answer to some other ask on the same home.
    """

    approved: bool
    status: str
    choice: str | None = None
    text: str | None = None
    answered_by: str | None = None
    as_: str | None = None
    approval: dict = field(default_factory=dict)
    signed_answer: dict | None = None
    answers: list = field(default_factory=list)
    verified: bool = False
    reason: str | None = None
    checked: bool = False

    @property
    def id(self) -> Any:
        return self.approval.get("id")

    @property
    def settled(self) -> bool:
        return self.status in SETTLED

    @property
    def by_person(self) -> bool:
        return self.as_ in ("person", "email-link")

    def to_dict(self) -> dict:
        """A JSON-serialisable dict (uses the key "as", not "as_")."""
        return {
            "approved": self.approved,
            "status": self.status,
            "choice": self.choice,
            "text": self.text,
            "answered_by": self.answered_by,
            "as": self.as_,
            "approval": self.approval,
            "signed_answer": self.signed_answer,
            "answers": self.answers,
            "verified": self.verified,
            "reason": self.reason,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Result":
        return cls(
            approved=bool(d.get("approved")),
            status=d.get("status") or "waiting",
            choice=d.get("choice"),
            text=d.get("text"),
            answered_by=d.get("answered_by"),
            as_=d.get("as", d.get("as_")),
            approval=d.get("approval") or {},
            signed_answer=d.get("signed_answer"),
            answers=d.get("answers") or [],
            verified=bool(d.get("verified")),
            reason=d.get("reason"),
        )

    @classmethod
    def from_approval(cls, approval: dict, signed_answer: dict | None = None, verified: bool = False) -> "Result":
        """Build a Result from an approval object and (optionally) its signed record.

        When a signed record is given, its status and answers win: it is the part that can be verified.
        """
        signed = signed_answer if signed_answer is not None else approval.get("signed_answer")
        if signed:
            status = signed.get("status") or approval.get("status") or "waiting"
            answers = [dict(a) for a in signed.get("answers") or []]
            # A note left on a plain yes/no is not in the signed record; show it from the approval.
            notes = {p.get("to"): p.get("note") for p in approval.get("people") or [] if p.get("note")}
            for a in answers:
                if a.get("text") is None and notes.get(a.get("to")):
                    a["note"] = notes[a.get("to")]
        else:
            status = approval.get("status") or "waiting"
            answers = [
                {
                    "to": p.get("to"),
                    "decision": p.get("decision"),
                    "choice": p.get("choice"),
                    "text": p.get("text"),
                    "note": p.get("note"),
                    "answered_by": p.get("person") or p.get("to"),
                    "as": p.get("as"),
                    "at": p.get("at"),
                }
                for p in approval.get("people") or []
            ]
        first = next((a for a in answers if a.get("decision") not in (None, "waiting")), None) or {}
        return cls(
            approved=status == "approved",
            status=status,
            choice=first.get("choice"),
            text=first.get("text") if first.get("text") is not None else first.get("note"),
            answered_by=first.get("answered_by") or first.get("person") or first.get("to"),
            as_=first.get("as"),
            approval=approval,
            signed_answer=signed or None,
            answers=answers,
            verified=verified,
        )


def _ask_body(
    title: str,
    to: str | Iterable[str] | None,
    details: str | None,
    choices: Iterable[str] | None,
    free_text: bool | None,
    needs: str | None,
    request_id: str | None,
    expires_at: str | None,
    callback: str | None,
    timeout: Any,
) -> dict:
    if not title or not isinstance(title, str):
        raise ValueError("title is required")
    if len(title) > 200:
        raise ValueError("title is at most 200 characters")
    if details is not None and len(details) > 2000:
        raise ValueError("details is at most 2000 characters")
    if to is not None and not isinstance(to, str):
        to = list(to)
    if choices is not None:
        choices = list(choices)
        if not 2 <= len(choices) <= 10:
            raise ValueError("choices needs 2 to 10 options")
    if needs is not None and needs not in ("any", "all"):
        raise ValueError('needs is "any" or "all"')
    if expires_at is None and timeout is not None:
        expires_at = expires_at_from(parse_timeout(timeout))
    body: dict[str, Any] = {
        "title": title,
        "details": details,
        "to": to,
        "choices": choices,
        "free_text": free_text,
        "needs": needs,
        "callback": callback,
    }
    body = {k: v for k, v in body.items() if v is not None}
    body["request_id"] = request_id or stable_request_id(body)
    if expires_at:
        body["expires_at"] = expires_at
    return body


def _decision_body(decision: str, choice: str | None, text: str | None) -> dict:
    if decision not in ("approved", "declined", "answered"):
        raise ValueError('decision is "approved", "declined" or "answered"')
    if text is not None and len(text) > 500:
        raise ValueError("text is at most 500 characters")
    body: dict[str, Any] = {"decision": decision}
    if choice is not None:
        body["choice"] = choice
    if text is not None:
        body["text"] = text
    return body


class Wayza:
    """Ask a person (or another agent) through Wayza and wait for the signed answer.

    >>> wz = Wayza()                     # key from WAYZA_KEY
    >>> r = wz.ask_and_wait("Refund £40 to order 1182?", to="you@example.com", timeout="24h")
    >>> r.approved
    """

    def __init__(
        self,
        key: str | None = None,
        home: str = DEFAULT_HOME,
        *,
        insecure: bool = False,
        verify_answers: bool | None = None,
        retries: int = 3,
        key_fetcher: KeyFetcher | None = None,
        request_timeout: float = 30.0,
        require_person: bool = False,
    ):
        self.key = key if key is not None else os.environ.get("WAYZA_KEY")
        self.home = home.rstrip("/")
        scheme = urllib.parse.urlparse(self.home).scheme
        if scheme not in ("https", "http"):
            raise ValueError(f"home must be a URL like https://wayza.com, got {home!r}")
        if scheme == "http" and not insecure:
            raise ValueError("home is http://; pass insecure=True for local or dev homes")
        self.insecure = insecure
        # None: verify whenever Ed25519 is available (wayza-human[verify]), as the JS package always does.
        self.verify_answers = _can_verify() if verify_answers is None else verify_answers
        self.retries = retries
        self.key_fetcher = key_fetcher
        self.request_timeout = request_timeout
        self.require_person = require_person
        self.base = self.home + "/wayza/v0"

    # ---- HTTP -----------------------------------------------------------------
    def _request(self, method: str, path: str, body: dict | None = None, *, timeout: float | None = None) -> dict:
        if not self.key:
            raise WayzaError("no Wayza key: pass key=... or set WAYZA_KEY", status=401)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {
            "Authorization": f"Bearer {self.key}",
            "Accept": "application/json",
            "User-Agent": f"wayza-human-py/{__version__}",
        }
        if data is not None:
            headers["Content-Type"] = "application/json"
        attempt = 0
        while True:
            req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=timeout or self.request_timeout) as resp:
                    raw = resp.read()
                    return json.loads(raw.decode("utf-8")) if raw else {}
            except urllib.error.HTTPError as e:
                raw = e.read()
                try:
                    payload = json.loads(raw.decode("utf-8")) if raw else {}
                except ValueError:
                    payload = {"error": raw.decode("utf-8", "replace")[:500]}
                if e.code in _RETRY_STATUSES and attempt < self.retries:
                    attempt += 1
                    time.sleep(self._backoff(attempt, e.headers.get("Retry-After")))
                    continue
                msg = payload.get("error") if isinstance(payload, dict) else None
                raise WayzaError(f"{e.code}: {msg or e.reason}", status=e.code, body=payload) from None
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if attempt < self.retries:
                    attempt += 1
                    time.sleep(self._backoff(attempt, None))
                    continue
                raise WayzaError(f"could not reach {self.home}: {e}") from e

    @staticmethod
    def _backoff(attempt: int, retry_after: str | None) -> float:
        if retry_after:
            try:
                return min(float(retry_after), 60.0)
            except ValueError:
                pass
        return min(0.5 * 2 ** (attempt - 1), 8.0)

    def _result(self, approval: dict) -> Result:
        signed = approval.get("signed_answer")
        verified = False
        if signed and self.verify_answers:
            verify(signed, home=self.home, insecure=self.insecure, key_fetcher=self.key_fetcher)
            verified = True
        return self._gate(Result.from_approval(approval, verified=verified))

    def _gate(self, result: Result) -> Result:
        return _require_person(result) if self.require_person else result

    def _checked(self, result: Result, want: dict | None) -> Result:
        """Refuse a settled result whose signed answer isn't the answer to ``want``."""
        if want is None or result.status == "waiting":
            return result
        if not result.signed_answer:
            raise WayzaVerifyError(f"approval {want['id']} settled without a signed answer")
        check_answer(result.signed_answer, want)
        result.checked = True
        return result

    # ---- API ------------------------------------------------------------------
    def ask(
        self,
        title: str,
        *,
        to: str | Iterable[str] | None = None,
        details: str | None = None,
        choices: Iterable[str] | None = None,
        free_text: bool | None = None,
        needs: str | None = None,
        request_id: str | None = None,
        expires_at: str | None = None,
        timeout: Any = None,
        callback: str | None = None,
    ) -> Result:
        """POST /approvals. Returns a Result with status "waiting" (or the earlier
        approval when request_id matches one already made).

        `to` is one address or a list: people (you@example.com, someone@example.com),
        @handles, or another agent's address (@ai-1f2e3d4c). `timeout` (seconds or "24h")
        sets expires_at when you don't pass one. The default request_id is a stable hash
        of the ask, so retries don't ask twice.
        """
        body = _ask_body(title, to, details, choices, free_text, needs, request_id, expires_at, callback, timeout)
        return self._result(self._request("POST", "/approvals", body))

    def get(self, id: Any, wait: Any = None) -> Result:
        """GET /approvals/{id}; with wait (<= 30 s) the server holds until it settles."""
        path = f"/approvals/{urllib.parse.quote(str(id), safe='')}"
        net_timeout = None
        if wait is not None:
            w = max(0, min(30, int(math.ceil(parse_timeout(wait) or 0))))
            path += f"?wait={w}"
            net_timeout = w + max(15.0, self.request_timeout)
        return self._result(self._request("GET", path, timeout=net_timeout))

    def cancel(self, id: Any) -> Result:
        """DELETE /approvals/{id}."""
        return self._result(self._request("DELETE", f"/approvals/{urllib.parse.quote(str(id), safe='')}"))

    def wait_for(self, id: Any, timeout: Any = None) -> Result:
        """Long-poll until the approval settles. Raises WayzaTimeout after `timeout`.

        Pass the approval (the Result from ask(), its ``.approval``, or a saved
        ``{"id", "request", "asked_by"}``) instead of a bare id to also check that the signed
        answer is the answer to that ask (``check_answer``); WayzaVerifyError otherwise.
        """
        id, want = _id_and_expectation(id)
        seconds = parse_timeout(timeout)
        deadline = None if seconds is None else time.monotonic() + seconds
        while True:
            remaining = 30.0 if deadline is None else deadline - time.monotonic()
            if remaining <= 0:
                raise WayzaTimeout(f"approval {id} still waiting after {timeout}", approval_id=id)
            r = self.get(id, wait=min(30.0, max(1.0, remaining)))
            if r.status != "waiting":
                return self._checked(r, want)

    def ask_and_wait(
        self,
        title: str,
        *,
        timeout: Any = "24h",
        on_timeout: str = "cancel",
        **kwargs: Any,
    ) -> Result:
        """ask() then wait_for(). On timeout, `on_timeout="cancel"` cancels the ask and
        returns the cancelled Result (approved=False); `"raise"` raises WayzaTimeout."""
        if on_timeout not in ("cancel", "raise"):
            raise ValueError('on_timeout is "cancel" or "raise"')
        first = self.ask(title, timeout=timeout, **kwargs)
        want = expectation(first)
        if first.status != "waiting":
            return self._checked(first, want)
        try:
            return self.wait_for(want, timeout)
        except WayzaTimeout:
            if on_timeout == "raise":
                raise
            return self._checked(self.cancel(first.id), want)

    def list_approvals(self) -> dict:
        """GET /approvals: ``{"waiting_for_your_person": [...], "asked": [...]}``."""
        return self._request("GET", "/approvals")

    def inbox(self, for_person: bool = False) -> list[dict]:
        """Asks waiting for this agent to answer: GET /approvals' ``waiting_for_your_person``, the ones
        addressed to it (answer with reply()). With for_person=True, also those waiting for its person,
        which only decide() answers. Each item's ``addressed_to`` is "you" or "your_person"."""
        items = list(self.list_approvals().get("waiting_for_your_person") or [])
        return items if for_person else [a for a in items if a.get("addressed_to") != "your_person"]

    def reply(self, id: Any, decision: str, choice: str | None = None, text: str | None = None) -> Result:
        """POST /approvals/{id}/reply: answer, as this agent, an ask another agent sent to it.

        ``decision`` is "approved", "declined" or "answered" (with ``choice`` and/or ``text``).
        The signed record says ``as: "ai"`` (or "ai-unclaimed"). Needs only the "message" scope.
        """
        return self._result(self._request("POST", f"/approvals/{urllib.parse.quote(str(id), safe='')}/reply",
                                          _decision_body(decision, choice, text)))

    def decide(self, id: Any, decision: str, choice: str | None = None, text: str | None = None) -> Result:
        """POST /approvals/{id}/decision: answer *for your person* (needs the "approve" scope;
        the record says ``as: "ai-on-behalf"``)."""
        return self._result(self._request("POST", f"/approvals/{urllib.parse.quote(str(id), safe='')}/decision",
                                          _decision_body(decision, choice, text)))

    def verify(self, signed_answer: dict | str) -> dict:
        """verify() pinned to this client's home."""
        return verify(signed_answer, home=self.home, insecure=self.insecure, key_fetcher=self.key_fetcher)

    def parse_callback(self, body: bytes | str | dict, *, expect: Any = None) -> Result:
        """parse_callback() pinned to this client's home. Pass ``expect`` (the approval from
        ask(), or a saved ``{"id", "request", "asked_by"}``) to refuse an answer to any other ask."""
        return self._gate(parse_callback(body, home=self.home, insecure=self.insecure,
                                         key_fetcher=self.key_fetcher, expect=expect))


class AsyncWayza:
    """asyncio variant of Wayza. Same arguments; every call is awaitable."""

    def __init__(self, key: str | None = None, home: str = DEFAULT_HOME, **kwargs: Any):
        self.sync = Wayza(key, home, **kwargs)

    @property
    def home(self) -> str:
        return self.sync.home

    async def ask(self, title: str, **kwargs: Any) -> Result:
        return await asyncio.to_thread(self.sync.ask, title, **kwargs)

    async def get(self, id: Any, wait: Any = None) -> Result:
        return await asyncio.to_thread(self.sync.get, id, wait)

    async def cancel(self, id: Any) -> Result:
        return await asyncio.to_thread(self.sync.cancel, id)

    async def wait_for(self, id: Any, timeout: Any = None) -> Result:
        id, want = _id_and_expectation(id)
        seconds = parse_timeout(timeout)
        loop = asyncio.get_running_loop()
        deadline = None if seconds is None else loop.time() + seconds
        while True:
            remaining = 30.0 if deadline is None else deadline - loop.time()
            if remaining <= 0:
                raise WayzaTimeout(f"approval {id} still waiting after {timeout}", approval_id=id)
            r = await self.get(id, wait=min(30.0, max(1.0, remaining)))
            if r.status != "waiting":
                return self.sync._checked(r, want)

    async def ask_and_wait(self, title: str, *, timeout: Any = "24h", on_timeout: str = "cancel", **kwargs: Any) -> Result:
        if on_timeout not in ("cancel", "raise"):
            raise ValueError('on_timeout is "cancel" or "raise"')
        first = await self.ask(title, timeout=timeout, **kwargs)
        want = expectation(first)
        if first.status != "waiting":
            return self.sync._checked(first, want)
        try:
            return await self.wait_for(want, timeout)
        except WayzaTimeout:
            if on_timeout == "raise":
                raise
            return self.sync._checked(await self.cancel(first.id), want)

    async def list_approvals(self) -> dict:
        return await asyncio.to_thread(self.sync.list_approvals)

    async def inbox(self, for_person: bool = False) -> list[dict]:
        return await asyncio.to_thread(self.sync.inbox, for_person)

    async def reply(self, id: Any, decision: str, choice: str | None = None, text: str | None = None) -> Result:
        return await asyncio.to_thread(self.sync.reply, id, decision, choice, text)

    async def decide(self, id: Any, decision: str, choice: str | None = None, text: str | None = None) -> Result:
        return await asyncio.to_thread(self.sync.decide, id, decision, choice, text)

    def verify(self, signed_answer: dict | str) -> dict:
        return self.sync.verify(signed_answer)

    def parse_callback(self, body: bytes | str | dict, *, expect: Any = None) -> Result:
        return self.sync.parse_callback(body, expect=expect)


def parse_callback(
    body: bytes | str | dict,
    *,
    home: str | None = DEFAULT_HOME,
    insecure: bool = False,
    key_fetcher: KeyFetcher | None = None,
    expect: Any = None,
    require_person: bool = False,
) -> Result:
    """Verify a callback POST body `{ "approval": ..., "signed_answer": ... }` and return its Result.

    Raises WayzaVerifyError if the signature, home or ids don't check out. The status and
    answers come from the signed record; the unsigned approval object is kept for display only.

    - `home`: the home you trust (required; prefer ``Wayza(...).parse_callback``, which uses
      the client's home).
    - `expect`: the ask this answer must belong to: the approval (or Result) from ask(), or
      the saved ``{"id", "request", "asked_by"}``. A genuine answer to a different ask, or to
      the same ask with a different request, is refused (``check_answer``).
    - `require_person`: an AI's approval comes back with approved=False and a ``reason``.
    """
    if not home:
        raise ValueError("parse_callback needs the home you trust (or use Wayza(...).parse_callback)")
    if isinstance(body, (bytes, bytearray)):
        body = body.decode("utf-8")
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except ValueError as e:
            raise WayzaVerifyError("callback body is not JSON") from e
    if not isinstance(body, dict):
        raise WayzaVerifyError("callback body must be an object")
    signed = body.get("signed_answer")
    if not signed:
        raise WayzaVerifyError("callback has no signed_answer")
    record = verify(signed, home=home, insecure=insecure, key_fetcher=key_fetcher)
    approval = body.get("approval") if isinstance(body.get("approval"), dict) else {}
    if approval.get("id") is not None:
        tail = record["approval"].rstrip("/").rsplit("/", 1)[-1]
        if tail != str(approval["id"]):
            raise WayzaVerifyError("approval id does not match the signed record")
    else:
        approval = dict(approval, id=_id_from_url(record["approval"]))
    if expect is not None:
        check_answer(record, expect)
    result = Result.from_approval(approval, signed_answer=record, verified=True)
    result.checked = expect is not None
    return _require_person(result) if require_person else result


def _id_and_expectation(sent: Any) -> tuple[Any, dict | None]:
    """A bare id -> (id, None); an approval, Result or saved entry -> (id, expectation)."""
    if isinstance(sent, (dict, Result)):
        want = expectation(sent)
        return want["id"], want
    return sent, None


def _id_from_url(url: str) -> Any:
    tail = url.rstrip("/").rsplit("/", 1)[-1]
    return int(tail) if tail.isdigit() else tail


def _can_verify() -> bool:
    try:
        import cryptography.hazmat.primitives.asymmetric.ed25519  # noqa: F401
    except ImportError:
        return False
    return True
