"""Google ADK adapter: answer ADK tool confirmations with a person's Wayza answer.

Targets ADK's tool confirmation flow (checked against google-adk 2.11):

* A tool needs confirmation when it is wrapped with ``FunctionTool(func, require_confirmation=True)``
  (or a callable), or when it calls ``tool_context.request_confirmation(hint=..., payload=...)``
  itself and then checks ``tool_context.tool_confirmation.confirmed`` on the re-run.
* The run then emits an event whose content has a function call named
  ``adk_request_confirmation`` with ``args = {"originalFunctionCall": {name, args, id},
  "toolConfirmation": {hint, confirmed, payload}}``. Its id is in ``long_running_tool_ids``.
* The client resumes by sending a user message with a function response of the same
  name and id and ``response = {"confirmed": bool, "payload": ...}``.

``answer_confirmations(events, wayza, to=...)`` does the whole round trip (blocking).
For durable runs, ``pending = ask_confirmations(events, wayza, to=..., callback=url)`` sends
the asks; save ``pending`` (each entry has the confirmation id and the ask's ``id``,
``request`` and ``asked_by``). Later ``resume_confirmations(answers, pending, wayza)``
verifies each answer against the client's home, checks it answers its saved ask, and
builds the reply ``Content``.

A confirmation counts as confirmed only when the answer is "approved" and, with
``require_person=True`` (the default), was given by a person: an AI's approval ("ai",
"ai-on-behalf", "ai-unclaimed") is sent as ``confirmed: False`` with the reason.

ADK is not imported at module load. Events are read by duck typing (objects or dicts).
``google.genai.types`` is imported lazily only to build the reply ``Content``. Use
``confirmation_response`` for a plain dict if you build it yourself.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

from ._client import AsyncWayza, Result, Wayza
from ._common import answer_approval_id, client, clip, gate, pending_entry, verified_answer

REQUEST_CONFIRMATION = "adk_request_confirmation"
_REQUEST_ID_PREFIX = "adk-confirm:"


def _get(obj: Any, *names: str) -> Any:
    for n in names:
        if isinstance(obj, dict):
            if n in obj:
                return obj[n]
        elif hasattr(obj, n):
            return getattr(obj, n)
    return None


@dataclass
class ConfirmationRequest:
    id: str
    tool_name: str | None
    tool_args: dict = field(default_factory=dict)
    tool_call_id: str | None = None
    hint: str = ""
    payload: Any = None


def confirmation_requests(events: Any) -> list[ConfirmationRequest]:
    """Find pending ``adk_request_confirmation`` calls in one event or a list of events."""
    if events is None:
        return []
    if not isinstance(events, (list, tuple)):
        events = [events]
    out: list[ConfirmationRequest] = []
    for ev in events:
        calls = []
        get_calls = getattr(ev, "get_function_calls", None)
        if callable(get_calls):
            calls = list(get_calls() or [])
        else:
            content = _get(ev, "content")
            for part in _get(content, "parts") or []:
                fc = _get(part, "function_call", "functionCall")
                if fc is not None:
                    calls.append(fc)
        for fc in calls:
            if _get(fc, "name") != REQUEST_CONFIRMATION:
                continue
            args = _get(fc, "args") or {}
            orig = _get(args, "originalFunctionCall", "original_function_call") or {}
            conf = _get(args, "toolConfirmation", "tool_confirmation") or {}
            out.append(ConfirmationRequest(
                id=_get(fc, "id"),
                tool_name=_get(orig, "name"),
                tool_args=dict(_get(orig, "args") or {}),
                tool_call_id=_get(orig, "id"),
                hint=_get(conf, "hint") or "",
                payload=_get(conf, "payload"),
            ))
    return out


def ask_for_confirmation(
    wayza: Wayza | AsyncWayza | None,
    request: ConfirmationRequest,
    *,
    to: Any = None,
    timeout: Any = "24h",
    callback: str | None = None,
    wait: bool = True,
    free_text: bool = True,
) -> Result:
    """Ask a person to confirm one tool call. ``wait=False`` returns at once (durable mode)."""
    wz = client(wayza)
    title = clip(request.hint or f"Allow {request.tool_name}?", 200)
    details = clip({"tool": request.tool_name, "args": request.tool_args}, 2000)
    kwargs = dict(to=to, details=details, free_text=free_text, callback=callback,
                  request_id=_REQUEST_ID_PREFIX + str(request.id))
    if wait:
        return wz.ask_and_wait(title, timeout=timeout, **kwargs)
    return wz.ask(title, timeout=timeout, **kwargs)


def confirmation_id_from(result: Result) -> str | None:
    """The ``adk_request_confirmation`` call id an ask was made for."""
    rid = (result.approval or {}).get("request_id") or ""
    return rid[len(_REQUEST_ID_PREFIX):] if rid.startswith(_REQUEST_ID_PREFIX) else None


def confirmation_response(request: ConfirmationRequest | str, result: Any,
                          wayza: Wayza | AsyncWayza | None = None, *, sent: Any = None,
                          require_person: bool = True) -> dict:
    """``{"name": "adk_request_confirmation", "id": ..., "response": {"confirmed", "payload"}}``.

    ``payload`` carries the answer details (choice, text, who answered and how) so a tool
    using ``tool_context.tool_confirmation.payload`` can read them. Pass ``sent`` (the saved
    pending entry) when ``result`` came from outside this process, e.g. a callback body: the
    answer must then verify against the client's home and answer that ask. Anything but a
    Result needs ``sent``.
    """
    if sent is not None:
        r = verified_answer(result, wayza, sent)
    elif isinstance(result, Result):
        r = result
    else:
        raise ValueError("pass sent= (the saved pending entry) to check an answer from outside this process")
    r = gate(r, require_person)
    rid = request.id if isinstance(request, ConfirmationRequest) else request
    return {
        "name": REQUEST_CONFIRMATION,
        "id": rid,
        "response": {
            "confirmed": bool(r.approved),
            "payload": {
                "status": r.status,
                "choice": r.choice,
                "text": r.text,
                "answered_by": r.answered_by,
                "as": r.as_,
                "wayza_id": r.id,
                "reason": r.reason,
            },
        },
    }


def confirmation_message(responses: Iterable[dict] | dict | ConfirmationRequest | str,
                         result: Any = None, *, types_module: Any = None) -> Any:
    """Build the ``google.genai.types.Content`` (role "user") to send back to the runner.

    Pass response dicts from ``confirmation_response``, or ``(request, result)``.
    """
    if result is not None:
        responses = [confirmation_response(responses, result)]  # type: ignore[arg-type]
    elif isinstance(responses, dict):
        responses = [responses]
    if types_module is None:
        from google.genai import types as types_module  # lazy
    parts = [
        types_module.Part(function_response=types_module.FunctionResponse(
            name=r["name"], id=r["id"], response=r["response"]))
        for r in responses
    ]
    return types_module.Content(role="user", parts=parts)


def answer_confirmations(
    events: Any,
    wayza: Wayza | AsyncWayza | None = None,
    *,
    to: Any = None,
    timeout: Any = "24h",
    types_module: Any = None,
    require_person: bool = True,
) -> Any:
    """Ask about every pending confirmation in ``events`` and return the reply ``Content``,
    or None when nothing is pending. With ``require_person`` (the default) an AI's approval
    is sent back as not confirmed.

        events = [e async for e in runner.run_async(user_id=u, session_id=s, new_message=msg)]
        reply = answer_confirmations(events, wz, to="you@example.com")
        if reply: events = [e async for e in runner.run_async(user_id=u, session_id=s, new_message=reply)]
    """
    reqs = confirmation_requests(events)
    if not reqs:
        return None
    responses = [confirmation_response(r, ask_for_confirmation(wayza, r, to=to, timeout=timeout),
                                       require_person=require_person) for r in reqs]
    return confirmation_message(responses, types_module=types_module)


def ask_confirmations(
    events: Any,
    wayza: Wayza | AsyncWayza | None = None,
    *,
    to: Any = None,
    timeout: Any = "24h",
    callback: str | None = None,
) -> list[dict]:
    """Durable: ask about every pending confirmation without waiting.

    Returns ``[{"confirmation_id", "wayza_id", "id", "request", "asked_by"}]`` to save
    with the session; pass it to ``resume_confirmations`` when the answers arrive.
    """
    out = []
    for req in confirmation_requests(events):
        asked = ask_for_confirmation(wayza, req, to=to, timeout=timeout, callback=callback, wait=False)
        out.append({"confirmation_id": req.id, "wayza_id": asked.id, **pending_entry(asked)})
    return out


def resume_confirmations(
    answers: Any,
    pending: list[dict],
    wayza: Wayza | AsyncWayza | None = None,
    *,
    types_module: Any = None,
    require_person: bool = True,
) -> Any:
    """Durable: build the reply ``Content`` from answers to the saved ``pending`` asks.

    ``answers`` is one answer or a list (callback bodies, Results or Result dicts with the
    signed answer), or a map ``{confirmation_id: answer}``. Each must verify against the
    client's home and answer its saved ask (WayzaVerifyError otherwise). Returns None when
    none of the answers matched a pending confirmation.
    """
    by_conf = {p["confirmation_id"]: p for p in pending}
    if isinstance(answers, dict) and all(k in by_conf for k in answers):
        pairs = [(by_conf[k], v) for k, v in answers.items()]
    else:
        items = answers if isinstance(answers, (list, tuple)) else [answers]
        by_id = {str(p["id"]): p for p in pending}
        pairs = []
        for a in items:
            aid = answer_approval_id(a)
            if str(aid) not in by_id:
                raise ValueError(f"answer for approval {aid!r} matches no pending confirmation")
            pairs.append((by_id[str(aid)], a))
    responses = [confirmation_response(p["confirmation_id"], a, wayza, sent=p, require_person=require_person)
                 for p, a in pairs]
    return confirmation_message(responses, types_module=types_module) if responses else None


__all__ = [
    "REQUEST_CONFIRMATION",
    "ConfirmationRequest",
    "confirmation_requests",
    "ask_for_confirmation",
    "confirmation_id_from",
    "confirmation_response",
    "confirmation_message",
    "answer_confirmations",
    "ask_confirmations",
    "resume_confirmations",
]
