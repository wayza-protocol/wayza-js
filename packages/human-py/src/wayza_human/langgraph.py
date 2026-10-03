"""LangGraph adapter: route `interrupt()` pauses to a person through Wayza.

Targets LangGraph's human-in-the-loop API (langgraph >= 0.4, checked against 1.2):
``from langgraph.types import interrupt, Command``. ``interrupt(value)`` pauses the
node and surfaces ``value`` under ``result["__interrupt__"]`` (a list of ``Interrupt``
objects with ``.value`` and ``.id``); the run resumes with
``graph.invoke(Command(resume=...), config)``, and ``interrupt()`` then returns the
resume value. Several pending interrupts resume at once with
``Command(resume={interrupt.id: value, ...})``.

Two modes:

* Blocking (default): ``ask_human(...)`` inside a node or tool asks through Wayza and
  long-polls for the answer, returning a ``Result``. No interrupt, no checkpointer needed.
* Durable (``durable=True``): ``ask_human`` sends the ask (idempotently) and calls
  ``interrupt({"type": "wayza.ask", "wayza_id": ..., ...})``. The graph pauses and the
  checkpointer saves it. Store ``wayza_id`` with your thread id (``pending_asks(result)``
  returns it, with the ask's ``request`` fingerprint and ``asked_by``). When the answer
  arrives, by callback or by polling, resume with ``resume_from_callback(body)`` or
  ``wait_and_resume(wz, result)``. On resume the node re-runs, the ask returns the same
  approval (same request id), and the resume value is accepted only if its signed answer
  verifies against the client's home *and* answers that very ask (``check_answer``);
  anything else raises WayzaVerifyError. Durable mode needs ``wayza-human[verify]``.

Gates default to ``require_person=True``: an approval given by an AI ("ai",
"ai-on-behalf", "ai-unclaimed") comes back as ``approved=False`` with a ``reason``.

LangGraph is not imported at module load. ``interrupt`` and ``Command`` are imported
lazily when used, and both can be injected (``interrupt_fn=``, ``command_cls=``).
"""

from __future__ import annotations

import functools
import inspect
from typing import Any, Callable, Iterable

from ._client import AsyncWayza, Result, Wayza
from ._answer import expectation
from ._common import client, clip, gate, scoped_request_id, verified_answer

ASK_TYPE = "wayza.ask"


def _interrupt_fn() -> Callable[[Any], Any]:
    from langgraph.types import interrupt  # lazy: only when durable mode is used

    return interrupt


def _command_cls() -> Any:
    from langgraph.types import Command  # lazy

    return Command


def _graph_scope() -> dict:
    """thread_id and checkpoint_ns of the running node, when inside LangGraph."""
    try:
        from langgraph.config import get_config  # lazy, optional

        cfg = get_config() or {}
    except Exception:  # noqa: BLE001 - not inside a graph, or langgraph missing
        return {}
    conf = cfg.get("configurable") or {}
    return {"thread_id": conf.get("thread_id"), "checkpoint_ns": conf.get("checkpoint_ns")}


def ask_human(
    title: str,
    *,
    wayza: Wayza | AsyncWayza | None = None,
    to: Any = None,
    details: str | None = None,
    choices: Iterable[str] | None = None,
    free_text: bool | None = None,
    needs: str | None = None,
    timeout: Any = "24h",
    callback: str | None = None,
    request_id: str | None = None,
    durable: bool = False,
    interrupt_fn: Callable[[Any], Any] | None = None,
    scope: dict | None = None,
    require_person: bool = True,
) -> Result:
    """Ask a person (or another agent) from inside a LangGraph node or tool.

    The default request id hashes the ask together with the graph's thread_id and
    checkpoint_ns, so a node replayed on resume gets the same approval back.
    With ``require_person`` (the default) an AI's approval counts as not approved.
    """
    wz = client(wayza)
    if request_id is None:
        sc = scope if scope is not None else _graph_scope()
        request_id = scoped_request_id(
            "langgraph", title=title, details=details, to=to,
            choices=list(choices) if choices is not None else None, **{k: v for k, v in sc.items() if v},
        )
    kwargs = dict(to=to, details=details, choices=choices, free_text=free_text, needs=needs,
                  request_id=request_id, callback=callback)
    if not durable:
        return gate(wz.ask_and_wait(title, timeout=timeout, **kwargs), require_person)
    asked = wz.ask(title, timeout=timeout, **kwargs)
    sent = expectation(asked)
    payload = {
        "type": ASK_TYPE,
        "wayza_id": asked.id,
        "id": sent["id"],
        "request": sent["request"],
        "asked_by": sent["asked_by"],
        "home": wz.home,
        "title": title,
        "to": to,
        "request_id": request_id,
        "status": asked.status,
    }
    value = (interrupt_fn or _interrupt_fn())(payload)
    return gate(verified_answer(value, wz, sent), require_person)


def pending_asks(graph_result: Any) -> list[dict]:
    """Wayza asks waiting in a paused run:
    ``[{"interrupt_id", "wayza_id", "id", "request", "asked_by", "value"}]``.

    Pass ``graph.invoke(...)``'s return value (with ``"__interrupt__"``), a list of
    Interrupt objects (e.g. ``stream.interrupts``), or a state snapshot with ``.interrupts``.
    Store these with the thread id so a callback can find the run to resume.
    """
    if isinstance(graph_result, dict):
        items = graph_result.get("__interrupt__") or []
    elif hasattr(graph_result, "interrupts"):
        items = graph_result.interrupts or []
    else:
        items = graph_result or []
    out = []
    for it in items:
        value = getattr(it, "value", it.get("value") if isinstance(it, dict) else None)
        iid = getattr(it, "id", it.get("id") if isinstance(it, dict) else None)
        if isinstance(value, dict) and value.get("type") == ASK_TYPE:
            out.append({"interrupt_id": iid, "wayza_id": value.get("wayza_id"), "id": value.get("id"),
                        "request": value.get("request"), "asked_by": value.get("asked_by"), "value": value})
    return out


def _command(resume: Any, command_cls: Any) -> Any:
    return (command_cls or _command_cls())(resume=resume)


def wait_and_resume(
    wayza: Wayza | AsyncWayza | None,
    graph_result: Any,
    *,
    timeout: Any = None,
    command_cls: Any = None,
) -> Any:
    """Wait for every pending Wayza ask in a paused run, then return the ``Command`` to resume it.

    ``graph.invoke(wait_and_resume(wz, result), config)``. Each answer is checked against
    its saved ask (id, request fingerprint, asked_by) before it is handed back.
    """
    wz = client(wayza)
    asks = pending_asks(graph_result)
    if not asks:
        raise ValueError("no pending Wayza asks in this result")
    answers = {a["interrupt_id"]: wz.wait_for(_saved(a), timeout).to_dict() for a in asks}
    if len(answers) == 1:
        return _command(next(iter(answers.values())), command_cls)
    return _command(answers, command_cls)


def _saved(entry: dict) -> Any:
    """The saved {id, request, asked_by} of a pending ask (refused later if any is missing)."""
    return {"id": entry.get("id") or entry.get("wayza_id"), "request": entry.get("request"),
            "asked_by": entry.get("asked_by")}


def resume_from_callback(
    body: bytes | str | dict,
    *,
    wayza: Wayza | AsyncWayza | None = None,
    interrupt_id: str | None = None,
    command_cls: Any = None,
    expect: Any = None,
) -> Any:
    """Verify a Wayza callback body (against the client's home) and return
    ``Command(resume=<verified result>)``.

    Pass ``interrupt_id`` (from ``pending_asks``) when several interrupts are pending, and
    ``expect`` (that pending entry) to refuse an answer to any other ask here already. The
    node checks the answer against its own ask again when it resumes.
    """
    result = client(wayza).parse_callback(body, expect=expect)
    resume = result.to_dict()
    return _command({interrupt_id: resume} if interrupt_id else resume, command_cls)


def approval_node(
    make_ask: Callable[[Any], dict],
    *,
    wayza: Wayza | AsyncWayza | None = None,
    key: str = "approval",
    durable: bool = True,
    require_person: bool = True,
    **defaults: Any,
) -> Callable[[Any], dict]:
    """Build a graph node that asks and writes the result into state[key] (as a dict).

    ``make_ask(state)`` returns ask_human keyword arguments, at least ``title``.

        builder.add_node("approve", approval_node(lambda s: {"title": f"Refund {s['amount']}?"},
                                                  to="you@example.com"))
    """

    def node(state: Any) -> dict:
        ask = {**defaults, **make_ask(state)}
        title = ask.pop("title")
        ask.setdefault("durable", durable)
        ask.setdefault("require_person", require_person)
        return {key: ask_human(title, wayza=wayza, **ask).to_dict()}

    return node


def require_approval(
    *,
    wayza: Wayza | AsyncWayza | None = None,
    to: Any = None,
    title: str | Callable[..., str] | None = None,
    durable: bool = False,
    timeout: Any = "24h",
    on_decline: Callable[[Result], Any] | None = None,
    require_person: bool = True,
    **ask_kwargs: Any,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Decorator for a tool function: ask before running it.

    Put it under ``@tool`` (or pass the wrapped function to ``ToolNode``). If the answer
    isn't "approved", the tool returns ``on_decline(result)`` (default: a short message
    for the model) instead of running. With ``require_person`` (the default) an approval
    given by an AI doesn't count.

        @tool
        @require_approval(to="you@example.com")
        def refund(order_id: int, amount: float) -> str: ...
    """

    fixed_details = ask_kwargs.pop("details", None)

    def decorate(fn: Callable[..., Any]) -> Callable[..., Any]:
        def _ask(args: tuple, kwargs: dict) -> Result:
            if callable(title):
                t = title(*args, **kwargs)
            elif title:
                t = title
            else:
                t = f"Allow {fn.__name__}?"
            details = clip({"tool": fn.__name__, "args": list(args), "kwargs": kwargs}, 2000)
            return ask_human(clip(t, 200), wayza=wayza, to=to, details=fixed_details or details,
                             timeout=timeout, durable=durable, require_person=require_person, **ask_kwargs)

        def _declined(r: Result) -> Any:
            if on_decline:
                return on_decline(r)
            if r.reason:
                return f"Not run: {fn.__name__}. {r.reason}"
            who = f" by {r.answered_by}" if r.answered_by else ""
            why = f": {r.text}" if r.text else ""
            return f"Not run: {fn.__name__} was {r.status}{who}{why}"

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def awrapper(*args: Any, **kwargs: Any) -> Any:
                import asyncio

                if durable:
                    r = _ask(args, kwargs)  # interrupt() must run in the node's context
                else:
                    r = await asyncio.to_thread(_ask, args, kwargs)
                return await fn(*args, **kwargs) if r.approved else _declined(r)

            return awrapper

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            r = _ask(args, kwargs)
            return fn(*args, **kwargs) if r.approved else _declined(r)

        return wrapper

    return decorate


__all__ = [
    "ask_human",
    "pending_asks",
    "wait_and_resume",
    "resume_from_callback",
    "approval_node",
    "require_approval",
    "ASK_TYPE",
]
