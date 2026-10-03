"""Helpers shared by the framework adapters."""

from __future__ import annotations

import json
from typing import Any

from ._answer import expectation, require_person
from ._client import AsyncWayza, Result, Wayza
from ._errors import WayzaVerifyError
from ._util import stable_request_id


def client(wayza: Wayza | AsyncWayza | None) -> Wayza:
    """The sync client to use (creates one from WAYZA_KEY when none is given)."""
    if wayza is None:
        return Wayza()
    if isinstance(wayza, AsyncWayza):
        return wayza.sync
    return wayza


def coerce_result(value: Any, wayza: Wayza | AsyncWayza | None = None) -> Result:
    """Turn a resume value into a Result.

    Accepts a Result, a Result.to_dict(), a raw callback body
    `{"approval": ..., "signed_answer": ...}` (verified against the client's home),
    or a plain approval object.
    """
    if isinstance(value, Result):
        return value
    if isinstance(value, (bytes, bytearray, str)):
        try:
            value = json.loads(value)
        except ValueError:
            # A bare string: treat it as a typed answer from whoever resumed the run.
            return Result(approved=False, status="answered", text=str(value))
    if isinstance(value, bool):
        return Result(approved=value, status="approved" if value else "declined")
    if not isinstance(value, dict):
        raise TypeError(f"cannot read a Wayza result from {type(value).__name__}")
    if "signed_answer" in value and "approval" in value and "status" not in value:
        return client(wayza).parse_callback(value)
    if "approved" in value and "status" in value:
        return Result.from_dict(value)
    if "status" in value and ("people" in value or "id" in value):
        return Result.from_approval(value)
    raise TypeError("cannot read a Wayza result from this dict")


def gate(result: Result, person_required: bool) -> Result:
    """Apply ``require_person`` when asked to."""
    return require_person(result) if person_required else result


def pending_entry(asked: Result | dict) -> dict:
    """What to save for a durable ask: ``{"id", "request", "asked_by"}``."""
    return expectation(asked)


def verified_answer(value: Any, wayza: Wayza | AsyncWayza | None, sent: Any) -> Result:
    """A durable resume value as a Result, refused unless it is genuine and answers ``sent``.

    ``value`` is a callback body, a Result, a Result dict or an approval object; it must carry
    the signed answer. The signature is checked against the client's home, then the record
    is checked against ``sent`` (the approval from ask(), or a saved pending entry).
    """
    if sent is None:
        raise ValueError("resuming needs the saved ask ({id, request, asked_by}) to check the answer against")
    if isinstance(value, Result):
        approval, signed = value.approval, value.signed_answer
    else:
        if isinstance(value, (bytes, bytearray, str)):
            try:
                value = json.loads(value)
            except ValueError as e:
                raise WayzaVerifyError("the answer to resume with is not a signed Wayza answer") from e
        if not isinstance(value, dict):
            raise WayzaVerifyError("the answer to resume with is not a signed Wayza answer")
        signed = value.get("signed_answer")
        inner = value.get("approval")
        if isinstance(inner, dict):
            approval = inner
        elif "people" in value or "title" in value:
            approval = value
        else:
            approval = {}
    if not signed:
        raise WayzaVerifyError("the answer to resume with has no signed answer")
    return client(wayza).parse_callback({"approval": approval or {}, "signed_answer": signed}, expect=sent)


def answer_approval_id(answer: Any) -> str | None:
    """The approval id an answer names, from its signed record (only to match it to a saved
    ask; the answer is verified and checked afterwards)."""
    if isinstance(answer, Result):
        answer = answer.to_dict()
    if isinstance(answer, (bytes, bytearray, str)):
        try:
            answer = json.loads(answer)
        except ValueError:
            return None
    if not isinstance(answer, dict):
        return None
    rec = answer.get("signed_answer")
    url = rec.get("approval") if isinstance(rec, dict) else None
    return url.rstrip("/").rsplit("/", 1)[-1] if isinstance(url, str) else None


def scoped_request_id(scope: str, **fields: Any) -> str:
    return stable_request_id({"scope": scope, **fields})


def clip(text: Any, limit: int) -> str:
    s = text if isinstance(text, str) else json.dumps(text, ensure_ascii=False, default=str)
    return s if len(s) <= limit else s[: limit - 1] + "…"


def feedback_text(result: Result, approve_word: str = "approved", decline_word: str = "declined") -> str:
    """A one-string answer for frameworks that take feedback text."""
    if result.status == "approved":
        return approve_word if not result.text else f"{approve_word}\n\n{result.text}"
    if result.status == "declined":
        return decline_word if not result.text else f"{decline_word}\n\n{result.text}"
    if result.status == "answered":
        if result.choice and result.text:
            return f"{result.choice}\n\n{result.text}"
        return result.choice or result.text or ""
    return ""
