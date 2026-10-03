"""Tie a signed answer to the ask that was sent, and tell a person's answer from an AI's."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from ._errors import WayzaVerifyError
from ._util import canonical

HUMAN_AS = ("person", "email-link")
AI_AS = ("ai", "ai-on-behalf", "ai-unclaimed")


def request_fingerprint(approval: dict) -> str:
    """The fingerprint of an ask, as the home signs it in the record's ``request`` field.

    ``approval`` is the approval object the server returned from POST /approvals. Returns
    the lowercase hex sha-256 of the UTF-8 canonical JSON of the request claims.
    """
    if not isinstance(approval, dict):
        raise TypeError("request_fingerprint takes the approval object returned by ask()")
    try:
        claims = {
            "title": approval["title"],
            "details": approval.get("details") or None,
            "choices": approval.get("choices") or None,
            "free_text": bool(approval.get("free_text")),
            "asked_by": approval["asked_by_address"],
            "to": sorted(p["to"] for p in approval["people"]),
            "request_id": approval.get("request_id") or None,
            "expires_at": approval.get("expires_at") or None,
        }
    except (KeyError, TypeError) as e:
        raise WayzaVerifyError(f"approval object is missing {e} needed for its fingerprint") from e
    return hashlib.sha256(canonical(claims).encode("utf-8")).hexdigest()


def expectation(sent: Any) -> dict:
    """``{"id", "request", "asked_by"}`` for an approval object, a Result, or such a dict."""
    approval = getattr(sent, "approval", sent)  # a Result carries the approval object
    if not isinstance(approval, dict):
        raise TypeError("sent must be the approval from ask(), a Result, or {id, request, asked_by}")
    if "request" in approval:
        missing = [k for k in ("id", "request", "asked_by") if approval.get(k) in (None, "")]
        if missing:
            raise WayzaVerifyError(f"the saved ask is missing {', '.join(missing)}")
        return {"id": approval["id"], "request": approval["request"], "asked_by": approval["asked_by"]}
    if approval.get("id") is None:
        raise WayzaVerifyError("the approval object has no id")
    return {"id": approval["id"], "request": request_fingerprint(approval), "asked_by": approval.get("asked_by_address")}


def check_answer(signed_answer: dict | str, sent: Any) -> dict:
    """Check that a signed answer is the answer to the ask that was sent. Returns the record.

    ``sent`` is the approval returned by ask() (or its Result), or a saved
    ``{"id", "request", "asked_by"}``. Raises WayzaVerifyError unless the record's approval
    id, ``asked_by`` and ``request`` fingerprint all match. This does not check the
    signature: verify the record first (``Wayza.verify`` or ``parse_callback``).
    """
    record = signed_answer
    if isinstance(record, (bytes, bytearray)):
        record = record.decode("utf-8")
    if isinstance(record, str):
        try:
            record = json.loads(record)
        except ValueError as e:
            raise WayzaVerifyError("signed answer is not JSON") from e
    if not isinstance(record, dict):
        raise WayzaVerifyError("no signed answer to check")
    want = expectation(sent)
    url = record.get("approval")
    tail = url.rstrip("/").rsplit("/", 1)[-1] if isinstance(url, str) else None
    if tail is None or tail != str(want["id"]):
        raise WayzaVerifyError(f"the signed answer is for approval {tail!r}, not {str(want['id'])!r}")
    if not want["asked_by"] or record.get("asked_by") != want["asked_by"]:
        raise WayzaVerifyError("the signed answer was asked by someone else")
    if record.get("request") != want["request"]:
        raise WayzaVerifyError("the signed answer is for a different request than the one sent")
    return record


def person_denial(result: Any) -> str | None:
    """Why ``result`` doesn't count as approved when a person's answer is required, or None."""
    if not getattr(result, "approved", False):
        return None
    decided = [a for a in getattr(result, "answers", None) or [] if a.get("decision") not in (None, "waiting")]
    kinds = [getattr(result, "as_", None)] + [a.get("as") for a in decided]
    bad = next((k for k in kinds if k not in HUMAN_AS), False)
    if bad is False:
        return None
    who = f"an AI ({bad})" if bad in AI_AS else f"an answer with no person behind it (as={bad!r})"
    return f"Not approved: a person's answer is required, but this one came from {who}."


def require_person(result: Any) -> Any:
    """The result itself when a person answered; otherwise a copy with ``approved=False``
    and ``reason`` saying why. Results that weren't approved are returned as they are."""
    why = person_denial(result)
    if why is None:
        return result
    from dataclasses import replace

    return replace(result, approved=False, reason=why)
