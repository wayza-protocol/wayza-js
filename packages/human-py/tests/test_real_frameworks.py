"""The adapters against the real frameworks, when they are installed.

Each class skips cleanly when its framework is missing, so the core suite stays stdlib-only.
To run these: pip install langgraph crewai google-adk openai-agents cryptography
(openai-agents >= 0.21 for agents.testing.ScriptedModel). No network or API keys are
used: models are scripted and Wayza is the in-process mock home.
"""

import asyncio
import importlib.util
import os
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))

from mock_server import MockHome  # noqa: E402

from wayza_human import Wayza  # noqa: E402


def has(mod):
    try:
        return importlib.util.find_spec(mod) is not None
    except (ImportError, ValueError):
        return False


class Answerer:
    def __init__(self, home, policy):
        self.home, self.policy, self.stop, self.seen = home, policy, threading.Event(), set()
        self.t = threading.Thread(target=self.run, daemon=True)

    def run(self):
        while not self.stop.is_set():
            for ap in list(self.home.approvals.values()):
                if ap["status"] == "waiting" and ap["id"] not in self.seen:
                    d = self.policy(ap)
                    if d:
                        self.seen.add(ap["id"])
                        self.home.settle(ap["id"], d[0], **d[1])
            time.sleep(0.03)

    def __enter__(self):
        self.t.start()
        return self

    def __exit__(self, *a):
        self.stop.set()


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = MockHome().start()
        cls.wz = Wayza("fam_bot", cls.home.home, insecure=True)

    @classmethod
    def tearDownClass(cls):
        cls.home.stop()

    def count(self, title):
        return len([a for a in self.home.approvals.values() if a["title"] == title])


@unittest.skipUnless(has("langgraph"), "langgraph not installed")
class RealLangGraph(Base):
    def build(self, durable=True):
        from typing import TypedDict

        from langgraph.checkpoint.memory import InMemorySaver
        from langgraph.graph import END, START, StateGraph

        from wayza_human.langgraph import ask_human

        wz = self.wz

        class State(TypedDict, total=False):
            amount: int
            approved: bool
            by: str

        def approve(state):
            r = ask_human(f"Refund £{state['amount']}?", wayza=wz, to="graham@wayza.com", durable=durable, timeout="10s")
            return {"approved": r.approved, "by": r.as_ or ""}

        g = StateGraph(State)
        g.add_node("approve", approve)
        g.add_edge(START, "approve")
        g.add_edge("approve", END)
        return g.compile(checkpointer=InMemorySaver())

    def test_durable_interrupt_resume(self):
        from wayza_human.langgraph import pending_asks, wait_and_resume

        graph = self.build()
        config = {"configurable": {"thread_id": "real-1"}}
        first = graph.invoke({"amount": 41}, config)
        asks = pending_asks(first)
        self.assertEqual(len(asks), 1, first)
        self.assertEqual(self.count("Refund £41?"), 1)
        threading.Timer(0.2, self.home.settle, (asks[0]["wayza_id"], "approved")).start()
        final = graph.invoke(wait_and_resume(self.wz, first, timeout="10s"), config)
        self.assertEqual(final["approved"], True)
        self.assertEqual(final["by"], "person")
        self.assertEqual(self.count("Refund £41?"), 1, "resume must not ask again")
        # Another thread asking the same question gets its own ask (thread_id is in the request id).
        other = graph.invoke({"amount": 41}, {"configurable": {"thread_id": "real-2"}})
        self.assertNotEqual(pending_asks(other)[0]["wayza_id"], asks[0]["wayza_id"])

    def test_resume_from_callback(self):
        from wayza_human.langgraph import pending_asks, resume_from_callback

        graph = self.build()
        config = {"configurable": {"thread_id": "real-cb"}}
        first = graph.invoke({"amount": 42}, config)
        ap = self.home.settle(pending_asks(first)[0]["wayza_id"], "declined", text="no", deliver=False)
        cmd = resume_from_callback({"approval": ap, "signed_answer": ap["signed_answer"]}, wayza=self.wz)
        final = graph.invoke(cmd, config)
        self.assertEqual(final["approved"], False)

    def test_blocking(self):
        graph = self.build(durable=False)
        with Answerer(self.home, lambda ap: ("approved", {}) if ap["title"] == "Refund £43?" else None):
            final = graph.invoke({"amount": 43}, {"configurable": {"thread_id": "real-b"}})
        self.assertTrue(final["approved"])


@unittest.skipUnless(has("agents") and has("agents.testing"), "openai-agents >= 0.21 not installed")
class RealOpenAIAgents(Base):
    def make(self, call_id):
        from agents import Agent, function_tool
        from agents.testing import ScriptedModel, assistant_message, function_call

        ran = []

        @function_tool(needs_approval=True)
        def cancel_order(order_id: int) -> str:
            """Cancel an order."""
            ran.append(order_id)
            return f"Cancelled order {order_id}"

        model = ScriptedModel([
            [function_call("cancel_order", {"order_id": 7}, call_id=call_id)],
            [assistant_message("Done.")],
        ])
        agent = Agent(name="Support", instructions="x", tools=[cancel_order], model=model)
        return agent, ran

    def test_run_with_approvals(self):
        from wayza_human.openai_agents import run_with_approvals

        agent, ran = self.make("call-real-1")
        with Answerer(self.home, lambda ap: ("approved", {}) if ap["title"] == "Allow cancel_order?" else None):
            result = asyncio.run(run_with_approvals(agent, "cancel 7", self.wz, to="@zoe", timeout="10s"))
        self.assertEqual(ran, [7])
        self.assertEqual(result.final_output, "Done.")
        sent = [a for a in self.home.approvals.values() if a["request_id"] == "openai-agents:call-real-1"]
        self.assertEqual(len(sent), 1)
        self.assertIn('"order_id": 7', sent[0]["details"])

    def test_durable_reject_through_saved_state(self):
        from agents import Runner, RunState

        from wayza_human import Result
        from wayza_human.openai_agents import apply_answers, ask_interruptions

        agent, ran = self.make("call-real-2")

        async def main():
            first = await Runner.run(agent, "cancel 7")
            self.assertEqual(len(first.interruptions), 1)
            asks = ask_interruptions(self.wz, first, to="@zoe", callback="https://agent.example.com/hook")
            saved = first.to_state().to_string()
            ap = self.home.settle(asks[0]["wayza_id"], "declined", text="customer changed mind", deliver=False)
            state = await RunState.from_string(agent, saved)
            left = apply_answers(state, [Result.from_approval(ap)], pending=asks, wayza=self.wz)
            self.assertEqual(left, [])
            return await Runner.run(agent, state)

        result = asyncio.run(main())
        self.assertEqual(ran, [])
        self.assertEqual(result.final_output, "Done.")


@unittest.skipUnless(has("google.adk"), "google-adk not installed")
class RealADK(Base):
    def test_tool_confirmation_round_trip(self):
        from google.adk.agents import LlmAgent
        from google.adk.models.base_llm import BaseLlm
        from google.adk.models.llm_response import LlmResponse
        from google.adk.runners import InMemoryRunner
        from google.adk.tools.function_tool import FunctionTool
        from google.genai import types

        from wayza_human.adk import answer_confirmations

        ran = []

        def close_account(account_id: str) -> dict:
            """Close an account."""
            ran.append(account_id)
            return {"result": f"Account {account_id} closed."}

        class ScriptLlm(BaseLlm):
            model: str = "script"

            async def generate_content_async(self, llm_request, stream=False):
                last = llm_request.contents[-1] if llm_request.contents else None
                has_tool_result = any(
                    getattr(p, "function_response", None) is not None and p.function_response.name == "close_account"
                    for p in (last.parts if last and last.parts else [])
                )
                if has_tool_result:
                    yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text="All done.")]))
                else:
                    yield LlmResponse(content=types.Content(role="model", parts=[types.Part(
                        function_call=types.FunctionCall(name="close_account", args={"account_id": "A-1"}))]))

        agent = LlmAgent(name="bank", model=ScriptLlm(), instruction="x",
                         tools=[FunctionTool(func=close_account, require_confirmation=True)])
        runner = InMemoryRunner(agent=agent, app_name="t")

        async def main():
            session = await runner.session_service.create_session(app_name="t", user_id="u")
            msg = types.Content(role="user", parts=[types.Part(text="close A-1")])
            events = [e async for e in runner.run_async(user_id="u", session_id=session.id, new_message=msg)]
            self.assertEqual(ran, [])
            reply = await asyncio.to_thread(answer_confirmations, events, self.wz, to="@zoe", timeout="10s")
            self.assertIsNotNone(reply, [e.model_dump(exclude_none=True) for e in events])
            return [e async for e in runner.run_async(user_id="u", session_id=session.id, new_message=reply)]

        with Answerer(self.home, lambda ap: ("approved", {}) if "close_account" in (ap["details"] or "") else None):
            later = asyncio.run(main())
        self.assertEqual(ran, ["A-1"])
        texts = [p.text for e in later if e.content and e.content.parts for p in e.content.parts if p.text]
        self.assertIn("All done.", texts)


@unittest.skipUnless(has("crewai"), "crewai not installed")
class RealCrewAI(Base):
    def test_flow_human_feedback_blocking_and_durable(self):
        from crewai.flow.flow import Flow, start
        from crewai.flow.human_feedback import human_feedback
        from crewai.flow.persistence import SQLiteFlowPersistence

        from wayza_human.crewai import WayzaFeedbackProvider, resume_flow

        db = os.path.join(tempfile.mkdtemp(), "flows.db")
        persistence = SQLiteFlowPersistence(db)
        blocking = WayzaFeedbackProvider(self.wz, to="@zoe", timeout="10s")
        durable = WayzaFeedbackProvider(self.wz, to="@zoe", durable=True, callback="https://agent.example.com/hook")

        class Blocking(Flow):
            @start()
            @human_feedback(message="Publish draft A?", provider=blocking)
            def draft(self):
                return "draft A"

        with Answerer(self.home, lambda ap: ("declined", {"text": "tighten it"}) if ap["title"] == "Publish draft A?" else None):
            f = Blocking()
            f.kickoff()
        self.assertEqual(f.last_human_feedback.feedback, "rejected\n\ntighten it")

        class Durable(Flow):
            @start()
            @human_feedback(message="Publish draft B?", provider=durable)
            def draft(self):
                return "draft B"

        from crewai.flow.async_feedback import HumanFeedbackPending

        d = Durable(persistence=persistence)
        pending = d.kickoff()
        self.assertIsInstance(pending, HumanFeedbackPending)
        wid = pending.callback_info["wayza_id"]
        ap = self.home.settle(wid, "approved", text="ship it", deliver=False)
        body = {"approval": ap, "signed_answer": ap["signed_answer"]}
        # A genuine answer to another ask is refused: the saved ask comes back from persistence.
        from wayza_human import WayzaVerifyError

        r2 = self.wz.ask("Something else?", to="@zoe")
        ap2 = self.home.settle(r2.id, "approved", deliver=False)
        with self.assertRaises(WayzaVerifyError):
            resume_flow(Durable, {"approval": ap2, "signed_answer": ap2["signed_answer"]}, wayza=self.wz,
                        persistence=persistence, flow_id=pending.callback_info["flow_id"])
        resume_flow(Durable, body, wayza=self.wz, persistence=persistence)
        self.assertEqual(self.count("Publish draft B?"), 1)

    def test_human_input_provider_protocol(self):
        from crewai.core.providers.human_input import HumanInputProvider, get_provider, reset_provider

        from wayza_human.crewai import WayzaHumanInputProvider, use_for_human_input

        p = WayzaHumanInputProvider(self.wz, to="@zoe")
        self.assertIsInstance(p, HumanInputProvider)  # runtime_checkable Protocol
        tok = use_for_human_input(p)
        try:
            self.assertIs(get_provider(), p)
        finally:
            reset_provider(tok)


if __name__ == "__main__":
    unittest.main()
