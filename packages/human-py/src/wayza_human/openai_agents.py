"""OpenAI Agents SDK (Python) adapter: approve tool calls with a person's Wayza answer.

Targets the SDK's human-in-the-loop API (checked against openai-agents 0.22):

* A tool is marked ``@function_tool(needs_approval=True)`` (or a callable
  ``async (ctx, params, call_id) -> bool``).
* ``result = await Runner.run(agent, input)`` stops with ``result.interruptions``, a list of
  ``ToolApprovalItem`` with ``.name``, ``.arguments`` (a JSON string) and ``.call_id``.
* ``state = result.to_state()``, then ``state.approve(item)`` or
  ``state.reject(item, rejection_message=...)``, then ``await Runner.run(agent, state)``.
* The state serialises with ``state.to_string()`` and reloads with
  ``await RunState.from_string(agent, s)``. ``state.get_interruptions()`` lists the
  pending items again.

Blocking: ``state = approve_interruptions(wz, result, to=...)``, or the whole loop with
``await run_with_approvals(agent, input, wz, to=...)``.
Durable: ``asks = ask_interruptions(wz, result, to=..., callback=url)``. Store
``result.to_state().to_string()`` together with ``asks`` (each entry has the call id and
the ask's ``id``, ``request`` and ``asked_by``). When the answers arrive, reload the state
and call ``apply_answers(state, answers, pending=asks)``. Each answer must verify against
the client's home and answer its saved ask, or WayzaVerifyError is raised.

A tool call is approved only when the answer is "approved" and, with
``require_person=True`` (the default), was given by a person: an AI's approval ("ai",
"ai-on-behalf", "ai-unclaimed") rejects the call with the reason.

The SDK is never imported at module load. ``Runner`` is imported lazily only by
``run_with_approvals`` when no runner is passed.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Callable

from ._client import AsyncWayza, Result, Wayza
from ._common import answer_approval_id, client, clip, gate, pending_entry, verified_answer

_REQUEST_ID_PREFIX = "openai-agents:"


def _interruptions(source: Any) -> list:
    if isinstance(source, (list, tuple)):
        return list(source)
    items = getattr(source, "interruptions", None)
    if items is None and hasattr(source, "get_interruptions"):
        items = source.get_interruptions()
    return list(items or [])


def _state(source: Any) -> Any:
    if hasattr(source, "approve") and hasattr(source, "reject"):
        return source
    to_state = getattr(source, "to_state", None)
    if to_state is None:
        raise TypeError("pass a RunResult (with to_state()) or a RunState")
    return to_state()


def _title_details(item: Any) -> tuple[str, str]:
    name = getattr(item, "name", None) or getattr(item, "tool_name", None) or "a tool"
    args = getattr(item, "arguments", None)
    try:
        parsed = json.loads(args) if isinstance(args, str) else args
    except ValueError:
        parsed = args
    return clip(f"Allow {name}?", 200), clip({"tool": name, "arguments": parsed}, 2000)


def ask_interruption(
    wayza: Wayza | AsyncWayza | None,
    item: Any,
    *,
    to: Any = None,
    timeout: Any = "24h",
    callback: str | None = None,
    wait: bool = True,
    title: Callable[[Any], str] | None = None,
) -> Result:
    """Ask about one ToolApprovalItem. ``wait=False`` returns at once (durable)."""
    wz = client(wayza)
    t, details = _title_details(item)
    if title:
        t = clip(title(item), 200)
    call_id = getattr(item, "call_id", None)
    kwargs = dict(to=to, details=details, free_text=True, callback=callback,
                  request_id=_REQUEST_ID_PREFIX + str(call_id) if call_id else None)
    return wz.ask_and_wait(t, timeout=timeout, **kwargs) if wait else wz.ask(t, timeout=timeout, **kwargs)


def apply_answer(state: Any, item: Any, result: Result, *, always: bool = False, require_person: bool = True) -> None:
    """``state.approve(item)`` when approved, otherwise ``state.reject(item, rejection_message=...)``.

    With ``require_person`` (the default) an approval given by an AI rejects the call.
    """
    result = gate(result, require_person)
    if result.approved:
        state.approve(item, always_approve=always)
        return
    who = f" by {result.answered_by}" if result.answered_by else ""
    why = f": {result.text}" if result.text else ""
    message = result.reason or f"A human did not approve this tool call ({result.status}{who}){why}"
    try:
        state.reject(item, rejection_message=message)
    except TypeError:  # older SDKs without rejection_message
        state.reject(item)


def approve_interruptions(
    wayza: Wayza | AsyncWayza | None,
    result_or_state: Any,
    *,
    to: Any = None,
    timeout: Any = "24h",
    title: Callable[[Any], str] | None = None,
    require_person: bool = True,
) -> Any:
    """Ask about every pending tool call, apply the answers, and return the RunState
    to pass back to ``Runner.run(agent, state)``. Blocks until answered."""
    state = _state(result_or_state)
    for item in _interruptions(result_or_state):
        apply_answer(state, item, ask_interruption(wayza, item, to=to, timeout=timeout, title=title),
                     require_person=require_person)
    return state


async def aapprove_interruptions(wayza: Wayza | AsyncWayza | None, result_or_state: Any, **kwargs: Any) -> Any:
    """Async approve_interruptions (the waits run in a thread)."""
    return await asyncio.to_thread(approve_interruptions, wayza, result_or_state, **kwargs)


def ask_interruptions(
    wayza: Wayza | AsyncWayza | None,
    result_or_state: Any,
    *,
    to: Any = None,
    timeout: Any = "24h",
    callback: str | None = None,
) -> list[dict]:
    """Durable: send one ask per pending tool call and return
    ``[{"call_id", "wayza_id", "id", "request", "asked_by"}]`` to store next to
    ``state.to_string()``."""
    out = []
    for item in _interruptions(result_or_state):
        r = ask_interruption(wayza, item, to=to, timeout=timeout, callback=callback, wait=False)
        out.append({"call_id": getattr(item, "call_id", None), "wayza_id": r.id, **pending_entry(r)})
    return out


def call_id_from(result: Result) -> str | None:
    """The tool call id an ask was made for (from its request id)."""
    rid = (result.approval or {}).get("request_id") or ""
    return rid[len(_REQUEST_ID_PREFIX):] if rid.startswith(_REQUEST_ID_PREFIX) else None


def apply_answers(state: Any, answers: Any, *, pending: list[dict], wayza: Wayza | AsyncWayza | None = None,
                  require_person: bool = True) -> list:
    """Apply answers to a (reloaded) RunState.

    ``pending`` is the list ``ask_interruptions`` returned. ``answers`` maps call_id ->
    callback body / Result / Result dict (carrying the signed answer), or is a list of those
    (matched to the pending asks by approval id). Every answer is verified against the
    client's home and checked against its saved ask (id, request fingerprint, asked_by);
    WayzaVerifyError otherwise, and nothing is applied. Returns the items still unanswered.
    """
    by_call = {p["call_id"]: p for p in pending}
    by_id = {str(p["id"]): p for p in pending}
    if not isinstance(answers, dict) or "signed_answer" in answers or "approved" in answers:
        items = [answers] if not isinstance(answers, (list, tuple)) else answers
        mapped = {}
        for a in items:
            entry = by_id.get(str(answer_approval_id(a)))
            if entry is None:
                raise ValueError("an answer matches no pending tool call")
            mapped[entry["call_id"]] = a
        answers = mapped
    checked = {}
    for cid, a in answers.items():
        if cid not in by_call:
            raise ValueError(f"no pending ask for tool call {cid!r}")
        checked[cid] = verified_answer(a, wayza, by_call[cid])
    left = []
    for item in _interruptions(state):
        cid = getattr(item, "call_id", None)
        if cid in checked:
            apply_answer(state, item, checked[cid], require_person=require_person)
        else:
            left.append(item)
    return left



async def run_with_approvals(
    agent: Any,
    input: Any,
    wayza: Wayza | AsyncWayza | None = None,
    *,
    to: Any = None,
    timeout: Any = "24h",
    runner: Any = None,
    max_rounds: int = 20,
    require_person: bool = True,
    **run_kwargs: Any,
) -> Any:
    """``Runner.run`` that sends every approval to a person through Wayza and carries on."""
    if runner is None:
        from agents import Runner as runner  # lazy
    result = await runner.run(agent, input, **run_kwargs)
    for _ in range(max_rounds):
        if not getattr(result, "interruptions", None):
            return result
        state = await aapprove_interruptions(wayza, result, to=to, timeout=timeout, require_person=require_person)
        result = await runner.run(agent, state, **run_kwargs)
    return result


__all__ = [
    "ask_interruption",
    "apply_answer",
    "approve_interruptions",
    "aapprove_interruptions",
    "ask_interruptions",
    "apply_answers",
    "call_id_from",
    "run_with_approvals",
]
