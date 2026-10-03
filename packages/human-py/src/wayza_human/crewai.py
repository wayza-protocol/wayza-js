"""CrewAI adapter: send CrewAI's human-in-the-loop moments to a person through Wayza.

Targets three CrewAI surfaces (checked against crewai 1.15):

1. Flows, ``@human_feedback(message=..., emit=[...], provider=...)`` from
   ``crewai.flow.human_feedback``. A provider implements
   ``request_feedback(context: PendingFeedbackContext, flow) -> str``. It either returns
   the feedback (blocking) or raises ``HumanFeedbackPending(context=..., callback_info=...)``
   (from ``crewai.flow.async_feedback``) to pause. A paused flow resumes with
   ``FlowClass.from_pending(flow_id).resume(feedback)``. ``WayzaFeedbackProvider`` does
   both; ``resume_flow`` does the resume.

2. Tasks, ``Task(..., human_input=True)``. After the agent's final answer, the executor
   calls the current ``HumanInputProvider`` (``crewai.core.providers.human_input``,
   ``set_provider(...)``): ``handle_feedback(formatted_answer, context)``. Empty feedback
   accepts the answer; anything else is fed back to the agent for another round.
   ``WayzaHumanInputProvider`` asks the reviewer through Wayza instead of stdin. Install
   it with ``use_for_human_input(provider)``.

3. CrewAI AMP (enterprise) webhook HITL: a deployed crew pauses and is resumed by
   ``POST {crew_url}/resume`` with ``{execution_id, task_id, human_feedback, is_approve}``.
   ``amp_resume_payload`` and ``amp_resume`` turn a Wayza result into that call.

Durable resumes are checked: the answer must verify against the client's home and answer
the very ask that was sent (its id, ``request`` fingerprint and ``asked_by``, saved in
``callback_info`` and in the pending context's ``metadata["wayza"]``).

Every gate here defaults to ``require_person=True``: an approval given by an AI ("ai",
"ai-on-behalf", "ai-unclaimed") is treated as a rejection, with the reason in the feedback.

CrewAI is never imported at module load. ``HumanFeedbackPending`` and ``set_provider``
are imported lazily, only by the code paths that need them.
"""

from __future__ import annotations

import asyncio
import json
import urllib.request
from typing import Any

from ._client import AsyncWayza, Result, Wayza
from ._answer import person_denial
from ._common import client, clip, feedback_text, gate, pending_entry, scoped_request_id, verified_answer


def _not_by_person(result: Result) -> str | None:
    """Why a settled answer doesn't count as a person's (for gates where any answer acts)."""
    if result.status in ("waiting", "expired", "cancelled"):
        return None
    return person_denial(Result(approved=True, status=result.status, as_=result.as_, answers=result.answers))


def flow_feedback(result: Result, emit: list[str] | None = None, *, require_person: bool = True) -> str:
    """The feedback string CrewAI's flow expects for a Wayza result.

    With ``emit`` outcomes offered as choices, the chosen outcome comes back verbatim, so
    CrewAI's outcome matching picks it exactly. Expired or cancelled gives "" (CrewAI then
    uses ``default_outcome``). With ``require_person`` (the default), any answer an AI gave
    comes back as "rejected" with the reason.
    """
    why = _not_by_person(result) if require_person else None
    if why:
        rejected = next((e for e in emit or [] if e.lower() in ("rejected", "reject", "declined", "no")), "rejected")
        return f"{rejected}\n\n{why}"
    if emit and result.choice in emit:
        return result.choice if not result.text else f"{result.choice}\n\n{result.text}"
    return feedback_text(result, approve_word="approved", decline_word="rejected")


class WayzaFeedbackProvider:
    """A CrewAI ``HumanFeedbackProvider`` that asks through Wayza.

    Blocking (default): waits for the answer and returns it as feedback text.
    Durable (``durable=True``): sends the ask (with ``callback`` if given) and raises
    ``HumanFeedbackPending``, so ``flow.kickoff()`` returns the pending object.
    ``callback_info`` holds ``wayza_id`` and ``flow_id``. Resume later with
    ``resume_flow(MyFlow, callback_body)``.
    """

    def __init__(
        self,
        wayza: Wayza | AsyncWayza | None = None,
        *,
        to: Any = None,
        timeout: Any = "24h",
        durable: bool = False,
        callback: str | None = None,
        free_text: bool = True,
        require_person: bool = True,
    ):
        self.wayza = client(wayza)
        self.to = to
        self.timeout = timeout
        self.durable = durable
        self.callback = callback
        self.free_text = free_text
        self.require_person = require_person

    def _ask_kwargs(self, context: Any) -> tuple[str, dict]:
        emit = list(getattr(context, "emit", None) or [])
        flow_id = getattr(context, "flow_id", None)
        method = getattr(context, "method_name", None)
        title = clip(getattr(context, "message", None) or f"Review {method}", 200)
        kwargs = dict(
            to=self.to,
            details=clip(getattr(context, "method_output", ""), 2000),
            choices=emit if 2 <= len(emit) <= 10 else None,
            free_text=self.free_text,
            request_id=f"crewai:{flow_id}:{method}:"
            + scoped_request_id("crewai-flow", flow_id=flow_id, method=method, title=title)[3:19],
            callback=self.callback,
        )
        return title, kwargs

    def request_feedback(self, context: Any, flow: Any) -> str:
        title, kwargs = self._ask_kwargs(context)
        emit = list(getattr(context, "emit", None) or [])
        rp = self.require_person
        if not self.durable:
            return flow_feedback(self.wayza.ask_and_wait(title, timeout=self.timeout, **kwargs), emit, require_person=rp)
        asked = self.wayza.ask(title, timeout=self.timeout, **kwargs)
        sent = pending_entry(asked)
        if asked.settled:  # already answered (a repeat of an earlier ask)
            return flow_feedback(verified_answer(asked, self.wayza, sent), emit, require_person=rp)
        from crewai.flow.async_feedback import HumanFeedbackPending  # lazy

        metadata = getattr(context, "metadata", None)
        if isinstance(metadata, dict):  # persisted with the pending context, read back by resume_flow
            metadata["wayza"] = dict(sent, home=self.wayza.home)
        raise HumanFeedbackPending(
            context=context,
            callback_info={
                "wayza_id": asked.id,
                **sent,
                "wayza_home": self.wayza.home,
                "flow_id": getattr(context, "flow_id", None),
            },
        )


def flow_id_from(result: Result) -> str | None:
    """Recover the flow id from a Wayza result made by WayzaFeedbackProvider."""
    rid = (result.approval or {}).get("request_id") or ""
    parts = rid.split(":")
    return parts[1] if len(parts) >= 4 and parts[0] == "crewai" else None


def resume_flow(
    flow_cls: Any,
    answer: Any,
    *,
    wayza: Wayza | AsyncWayza | None = None,
    flow_id: str | None = None,
    emit: list[str] | None = None,
    persistence: Any = None,
    expect: dict | None = None,
    require_person: bool = True,
    **flow_kwargs: Any,
) -> Any:
    """Resume a paused flow with a Wayza answer.

    ``answer`` is a callback body, a Result or a Result dict carrying the signed answer.
    It must verify against the client's home and answer the ask the flow is waiting on:
    ``expect`` (``HumanFeedbackPending.callback_info``) or, by default, the ask saved in the
    pending context's ``metadata["wayza"]``. Otherwise WayzaVerifyError and the flow stays
    paused. ``flow_id`` defaults to ``expect["flow_id"]``, then to the one in the ask's request id.
    """
    fid = flow_id or (expect or {}).get("flow_id")
    if not fid:
        fid = flow_id_from(answer if isinstance(answer, Result) else _peek_result(answer))
    if not fid:
        raise ValueError("pass flow_id (from HumanFeedbackPending.callback_info)")
    flow = flow_cls.from_pending(fid, persistence, **flow_kwargs)
    pending = getattr(flow, "pending_feedback", None)
    if expect is None:
        saved = getattr(pending, "metadata", None)
        expect = saved.get("wayza") if isinstance(saved, dict) else None
    if not expect:
        raise ValueError("pass expect= (HumanFeedbackPending.callback_info): the saved ask to check the answer against")
    result = verified_answer(answer, wayza, {k: expect.get(k) for k in ("id", "request", "asked_by")})
    if emit is None:
        emit = list(getattr(pending, "emit", None) or []) or None
    return flow.resume(flow_feedback(result, emit, require_person=require_person))


def _peek_result(answer: Any) -> Result:
    """An unverified look at an answer, only to find which flow it names."""
    try:
        if isinstance(answer, (bytes, bytearray, str)):
            answer = json.loads(answer)
        if isinstance(answer, dict):
            ap = answer.get("approval") if isinstance(answer.get("approval"), dict) else answer
            return Result(approved=False, status="waiting", approval=ap)
    except ValueError:
        pass
    return Result(approved=False, status="waiting")


class WayzaHumanInputProvider:
    """A CrewAI ``HumanInputProvider`` for ``Task(human_input=True)`` that asks through Wayza.

    The reviewer approves (the answer stands) or declines/answers with text (sent back to
    the agent as feedback for another round), up to ``max_rounds``.
    """

    def __init__(
        self,
        wayza: Wayza | AsyncWayza | None = None,
        *,
        to: Any = None,
        timeout: Any = "24h",
        max_rounds: int = 3,
        require_person: bool = True,
    ):
        self.wayza = client(wayza)
        self.to = to
        self.timeout = timeout
        self.max_rounds = max_rounds
        self.require_person = require_person

    # The protocol's set-up hooks: use CrewAI's standard messages.
    def setup_messages(self, context: Any) -> bool:
        return False

    def post_setup_messages(self, context: Any) -> None:
        return None

    @staticmethod
    def _get_output_string(answer: Any) -> str:
        """Part of CrewAI's HumanInputProvider protocol."""
        return WayzaHumanInputProvider._output(answer)

    @staticmethod
    def _output(answer: Any) -> str:
        out = getattr(answer, "output", answer)
        if isinstance(out, str):
            return out
        dump = getattr(out, "model_dump_json", None)
        return dump() if dump else json.dumps(out, default=str)

    def _ask(self, answer: Any, context: Any, round_no: int) -> Result:
        task = getattr(context, "task", None)
        desc = getattr(task, "description", None) or "the agent's answer"
        output = self._output(answer)
        title = clip(f"Review: {desc}", 200)
        rid = scoped_request_id("crewai-task", task=getattr(task, "id", None) and str(task.id),
                                desc=desc, output=output, round=round_no)
        return self.wayza.ask_and_wait(
            title,
            to=self.to,
            details=clip(output, 2000),
            free_text=True,
            request_id=rid,
            timeout=self.timeout,
        )

    def _feedback(self, r: Result) -> str:
        """'' accepts the answer; anything else goes back to the agent."""
        why = _not_by_person(r) if self.require_person else None
        if why:
            return f"The answer was not accepted. {why}"
        if r.status == "approved" or r.status in ("expired", "cancelled"):
            return ""
        if r.status == "declined":
            return r.text or "The reviewer rejected this answer. Please revise it."
        return r.text or r.choice or ""

    def handle_feedback(self, formatted_answer: Any, context: Any) -> Any:
        answer = formatted_answer
        for round_no in range(self.max_rounds):
            feedback = self._feedback(self._ask(answer, context, round_no))
            if not feedback.strip():
                break
            context.messages.append(context._format_feedback_message(feedback))
            answer = context._invoke_loop()
        context.ask_for_human_input = False
        return answer

    async def handle_feedback_async(self, formatted_answer: Any, context: Any) -> Any:
        answer = formatted_answer
        for round_no in range(self.max_rounds):
            r = await asyncio.to_thread(self._ask, answer, context, round_no)
            feedback = self._feedback(r)
            if not feedback.strip():
                break
            context.messages.append(context._format_feedback_message(feedback))
            answer = await context._ainvoke_loop()
        context.ask_for_human_input = False
        return answer


def use_for_human_input(provider: WayzaHumanInputProvider) -> Any:
    """Make ``provider`` CrewAI's human input provider for the current context.

    Returns the token for ``crewai.core.providers.human_input.reset_provider``.
    """
    from crewai.core.providers.human_input import set_provider  # lazy

    return set_provider(provider)


def amp_resume_payload(result: Result, *, execution_id: str, task_id: str, require_person: bool = True) -> dict:
    """Body for CrewAI AMP's ``POST /resume`` from a Wayza result.

    With ``require_person`` (the default) an AI's approval is sent as ``is_approve: false``.
    """
    result = gate(result, require_person)
    return {
        "execution_id": execution_id,
        "task_id": task_id,
        "human_feedback": result.reason or feedback_text(result) or result.status,
        "is_approve": bool(result.approved),
    }


def amp_resume(crew_url: str, token: str, result: Result, *, execution_id: str, task_id: str,
               timeout: float = 30.0, require_person: bool = True) -> dict:
    """POST the Wayza answer to a deployed crew's ``/resume`` endpoint."""
    body = json.dumps(amp_resume_payload(result, execution_id=execution_id, task_id=task_id,
                                         require_person=require_person)).encode()
    req = urllib.request.Request(
        crew_url.rstrip("/") + "/resume", data=body, method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else {}


__all__ = [
    "WayzaFeedbackProvider",
    "WayzaHumanInputProvider",
    "resume_flow",
    "flow_feedback",
    "flow_id_from",
    "use_for_human_input",
    "amp_resume_payload",
    "amp_resume",
]
