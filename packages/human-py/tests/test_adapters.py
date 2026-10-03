"""Adapters, tested against fake framework objects shaped like the real APIs."""

import asyncio
import os
import sys
import threading
import time
import types
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))

from mock_server import HAVE_CRYPTO, MockHome  # noqa: E402

from wayza_human import Result, Wayza, WayzaVerifyError  # noqa: E402
from wayza_human._common import pending_entry  # noqa: E402
from wayza_human import adk as wz_adk  # noqa: E402
from wayza_human import crewai as wz_crewai  # noqa: E402
from wayza_human import langgraph as wz_lg  # noqa: E402
from wayza_human import openai_agents as wz_oa  # noqa: E402


class Answerer:
    """Answers waiting asks on the mock home with `policy(approval) -> (decision, kwargs) | None`."""

    def __init__(self, home, policy):
        self.home, self.policy = home, policy
        self.stop = threading.Event()
        self.answered = []
        self.t = threading.Thread(target=self.run, daemon=True)
        self.t.start()

    def run(self):
        while not self.stop.is_set():
            for ap in list(self.home.approvals.values()):
                if ap["status"] == "waiting" and ap["id"] not in self.answered:
                    decided = self.policy(ap)
                    if decided:
                        self.answered.append(ap["id"])
                        self.home.settle(ap["id"], decided[0], **decided[1])
            time.sleep(0.03)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.stop.set()
        self.t.join(1)


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = MockHome().start()
        cls.wz = Wayza("fam_bot", cls.home.home, insecure=True)
        cls.helper = Wayza("fam_helper", cls.home.home, insecure=True)

    @classmethod
    def tearDownClass(cls):
        cls.home.stop()

    def body(self, title, decision="approved", **kw):
        """A genuine callback body for a fresh ask (an answer to some *other* ask)."""
        r = self.wz.ask(title, to="@zoe")
        ap = self.home.settle(r.id, decision, deliver=False, **kw)
        return {"approval": ap, "signed_answer": ap["signed_answer"]}

    def agent_answers(self, title, decision="approved"):
        """An AI (fam_helper) answers the first waiting ask with this title."""
        def go():
            for _ in range(200):
                for ap in list(self.home.approvals.values()):
                    if ap["title"] == title and ap["status"] == "waiting":
                        self.helper.reply(ap["id"], decision)
                        return
                time.sleep(0.03)
        t = threading.Thread(target=go, daemon=True)
        t.start()
        return t


# ---------------------------------------------------------------- LangGraph ----
class GraphInterrupt(Exception):
    def __init__(self, value):
        self.value = value


class FakeInterrupt:  # langgraph.types.Interrupt: .value and .id
    def __init__(self, value, id):
        self.value, self.id = value, id


class FakeCommand:  # langgraph.types.Command(resume=...)
    def __init__(self, resume=None):
        self.resume = resume


class FakeGraph:
    """Runs one node like LangGraph does: interrupt() raises on the first pass and returns
    the resume value on the replay after Command(resume=...)."""

    def __init__(self, node):
        self.node = node
        self.resume = None

    def interrupt(self, value):
        if self.resume is not None:
            return self.resume
        raise GraphInterrupt(value)

    def invoke(self, inp, config=None):
        if isinstance(inp, FakeCommand):
            self.resume = inp.resume
        try:
            return self.node({"amount": 40})
        except GraphInterrupt as gi:
            return {"__interrupt__": [FakeInterrupt(gi.value, "int-1")]}


class LangGraphTests(Base):
    def test_blocking(self):
        with Answerer(self.home, lambda ap: ("approved", {}) if ap["title"] == "LG blocking?" else None):
            r = wz_lg.ask_human("LG blocking?", wayza=self.wz, to="@zoe", timeout="10s", scope={"thread_id": "t1"})
        self.assertTrue(r.approved)

    @unittest.skipUnless(HAVE_CRYPTO, "cryptography not installed")
    def test_durable_interrupt_and_resume(self):
        calls = []

        def node(state):
            r = wz_lg.ask_human(f"Refund £{state['amount']}?", wayza=self.wz, to="graham@wayza.com", durable=True,
                                interrupt_fn=graph.interrupt, scope={"thread_id": "t-durable", "checkpoint_ns": "n:1"})
            calls.append(r)
            return {"approved": r.approved, "by": r.as_}

        graph = FakeGraph(node)
        first = graph.invoke({"amount": 40})
        asks = wz_lg.pending_asks(first)
        self.assertEqual(len(asks), 1)
        self.assertEqual(asks[0]["interrupt_id"], "int-1")
        wid = asks[0]["wayza_id"]
        self.assertEqual(first["__interrupt__"][0].value["type"], "wayza.ask")
        threading.Timer(0.2, self.home.settle, (wid, "approved")).start()
        cmd = wz_lg.wait_and_resume(self.wz, first, timeout="10s", command_cls=FakeCommand)
        self.assertEqual(cmd.resume["status"], "approved")
        before = len([a for a in self.home.approvals.values() if a["title"] == "Refund £40?"])
        out = graph.invoke(cmd)
        after = len([a for a in self.home.approvals.values() if a["title"] == "Refund £40?"])
        self.assertEqual(out, {"approved": True, "by": "person"})
        self.assertEqual(before, after, "the replayed node must not ask twice")
        self.assertEqual(set(asks[0]) >= {"id", "request", "asked_by"}, True)
        self.assertEqual(asks[0]["request"], self.home.approvals[wid]["signed_answer"]["request"])

    @unittest.skipUnless(HAVE_CRYPTO, "cryptography not installed")
    def test_durable_resume_refuses_replays_and_other_homes(self):
        def node(state):
            r = wz_lg.ask_human("LG replay?", wayza=self.wz, to="@zoe", durable=True,
                                interrupt_fn=graph.interrupt, scope={"thread_id": "t-replay"})
            return {"approved": r.approved}

        graph = FakeGraph(node)
        first = graph.invoke({})
        wid = wz_lg.pending_asks(first)[0]["wayza_id"]
        replay = self.body("LG something else?")  # genuine, but for another approval
        with self.assertRaisesRegex(WayzaVerifyError, "approval"):
            graph.invoke(FakeCommand(replay))
        # Genuinely signed by another home, with its own key served by the key fetcher.
        other = MockHome().start()
        try:
            wz_other = Wayza("fam_bot", other.home, insecure=True)
            o = wz_other.ask("LG replay?", to="@zoe")
            oap = other.settle(o.id, "approved", deliver=False)
            fetch = lambda origin: (other if origin == other.home else self.home).well_known()  # noqa: E731
            wz = Wayza("fam_bot", self.home.home, insecure=True, key_fetcher=fetch)

            def node2(state):
                r = wz_lg.ask_human("LG replay?", wayza=wz, to="@zoe", durable=True,
                                    interrupt_fn=graph2.interrupt, scope={"thread_id": "t-replay"})
                return {"approved": r.approved}

            graph2 = FakeGraph(node2)
            graph2.invoke({})
            with self.assertRaisesRegex(WayzaVerifyError, "expected"):
                graph2.invoke(FakeCommand({"approval": oap, "signed_answer": oap["signed_answer"]}))
        finally:
            other.stop()
        # The real answer, after all that, resumes the run.
        ap = self.home.settle(wid, "approved", deliver=False)
        self.assertEqual(graph.invoke(FakeCommand({"approval": ap, "signed_answer": ap["signed_answer"]})),
                         {"approved": True})
        # A bare value with no signed answer is refused too.
        with self.assertRaises(WayzaVerifyError):
            graph.invoke(FakeCommand(True))

    def test_multiple_interrupts_resume_map(self):
        a = self.wz.ask("LG multi a?", to="@zoe")
        b = self.wz.ask("LG multi b?", to="@zoe")
        result = {"__interrupt__": [
            FakeInterrupt({"type": "wayza.ask", "wayza_id": a.id, **pending_entry(a)}, "ia"),
            FakeInterrupt({"type": "wayza.ask", "wayza_id": b.id, **pending_entry(b)}, "ib"),
            FakeInterrupt("some other interrupt", "ic"),
        ]}
        self.assertEqual([x["interrupt_id"] for x in wz_lg.pending_asks(result)], ["ia", "ib"])
        self.home.settle(a.id, "approved")
        self.home.settle(b.id, "declined")
        cmd = wz_lg.wait_and_resume(self.wz, result, timeout=5, command_cls=FakeCommand)
        self.assertEqual(cmd.resume["ia"]["status"], "approved")
        self.assertEqual(cmd.resume["ib"]["status"], "declined")
        # A pending entry whose saved request doesn't match what was answered is refused.
        bad = {"__interrupt__": [FakeInterrupt({"type": "wayza.ask", "wayza_id": a.id,
                                                **dict(pending_entry(a), request="0" * 64)}, "ia")]}
        with self.assertRaisesRegex(WayzaVerifyError, "different request"):
            wz_lg.wait_and_resume(self.wz, bad, timeout=5, command_cls=FakeCommand)
        # So is an old entry without request / asked_by.
        with self.assertRaises(WayzaVerifyError):
            wz_lg.wait_and_resume(self.wz, {"__interrupt__": [FakeInterrupt({"type": "wayza.ask", "wayza_id": a.id}, "x")]},
                                  timeout=5, command_cls=FakeCommand)

    @unittest.skipUnless(HAVE_CRYPTO, "cryptography not installed")
    def test_resume_from_callback(self):
        r = self.wz.ask("LG callback?", to="@zoe")
        ap = self.home.settle(r.id, "approved", deliver=False)
        cmd = wz_lg.resume_from_callback({"approval": ap, "signed_answer": ap["signed_answer"]}, wayza=self.wz,
                                         command_cls=FakeCommand)
        self.assertTrue(cmd.resume["verified"])
        cmd2 = wz_lg.resume_from_callback({"approval": ap, "signed_answer": ap["signed_answer"]}, wayza=self.wz,
                                          interrupt_id="i9", command_cls=FakeCommand, expect=pending_entry(r))
        self.assertIn("i9", cmd2.resume)
        with self.assertRaisesRegex(WayzaVerifyError, "approval"):
            wz_lg.resume_from_callback(self.body("LG callback other?"), wayza=self.wz, command_cls=FakeCommand,
                                       expect=pending_entry(r))

    def test_require_approval_tool(self):
        ran = []

        @wz_lg.require_approval(wayza=self.wz, to="@zoe", timeout="10s",
                                title=lambda order_id, amount: f"Refund {amount} on {order_id}?")
        def refund(order_id, amount):
            ran.append(order_id)
            return "refunded"

        @wz_lg.require_approval(wayza=self.wz, to="@zoe", timeout="10s")
        async def delete_all():
            ran.append("all")
            return "deleted"

        def policy(ap):
            if ap["title"] == "Refund 5 on 1?":
                return ("approved", {})
            if ap["title"] in ("Refund 9 on 2?", "Allow delete_all?"):
                return ("declined", {"text": "no way"})
            return None

        with Answerer(self.home, policy):
            self.assertEqual(refund(1, 5), "refunded")
            msg = refund(2, 9)
            amsg = asyncio.run(delete_all())
        self.assertEqual(ran, [1])
        self.assertIn("declined", msg)
        self.assertIn("no way", amsg)
        self.assertEqual(refund.__name__, "refund")

    def test_require_person_is_on_for_gates(self):
        ran = []

        @wz_lg.require_approval(wayza=self.wz, to="@ai-helper", timeout="10s", title="LG agent gate?")
        def wipe():
            ran.append("strict")
            return "wiped"

        @wz_lg.require_approval(wayza=self.wz, to="@ai-helper", timeout="10s", title="LG agent gate off?",
                                require_person=False)
        def wipe_loose():
            ran.append("loose")
            return "wiped"

        self.agent_answers("LG agent gate?")
        msg = wipe()
        self.assertEqual(ran, [])
        self.assertIn("person's answer is required", msg)
        self.agent_answers("LG agent gate off?")
        self.assertEqual(wipe_loose(), "wiped")
        self.assertEqual(ran, ["loose"])
        self.agent_answers("LG agent ask?")
        r = wz_lg.ask_human("LG agent ask?", wayza=self.wz, to="@ai-helper", timeout="10s", scope={})
        self.assertFalse(r.approved)
        self.assertEqual((r.status, r.as_), ("approved", "ai-unclaimed"))

    def test_approval_node(self):
        node = wz_lg.approval_node(lambda s: {"title": f"Node {s['n']}?"}, wayza=self.wz, to="@zoe",
                                   durable=False, timeout="10s", scope={})
        with Answerer(self.home, lambda ap: ("answered", {"text": "ok"}) if ap["title"] == "Node 3?" else None):
            out = node({"n": 3})
        self.assertEqual(out["approval"]["text"], "ok")

    def test_coerce_values(self):
        from wayza_human._common import coerce_result

        self.assertTrue(coerce_result(True).approved)
        self.assertEqual(coerce_result("free words").text, "free words")
        self.assertEqual(coerce_result({"id": 1, "status": "declined", "people": []}).status, "declined")
        with self.assertRaises(TypeError):
            coerce_result({"what": 1})


# ------------------------------------------------------------------- CrewAI ----
class FakePending(Exception):  # crewai.flow.async_feedback.HumanFeedbackPending
    def __init__(self, context, callback_info=None, message=None):
        super().__init__(message or "pending")
        self.context, self.callback_info = context, callback_info or {}


def fake_crewai_modules(set_provider=None):
    flow_mod = types.ModuleType("crewai.flow.async_feedback")
    flow_mod.HumanFeedbackPending = FakePending
    hi = types.ModuleType("crewai.core.providers.human_input")
    hi.set_provider = set_provider or (lambda p: ("token", p))
    return {
        "crewai": types.ModuleType("crewai"),
        "crewai.flow": types.ModuleType("crewai.flow"),
        "crewai.flow.async_feedback": flow_mod,
        "crewai.core": types.ModuleType("crewai.core"),
        "crewai.core.providers": types.ModuleType("crewai.core.providers"),
        "crewai.core.providers.human_input": hi,
    }


def flow_context(flow_id="flow-1", emit=("approved", "rejected")):
    # Shaped like crewai.flow.async_feedback.PendingFeedbackContext
    return SimpleNamespace(flow_id=flow_id, flow_class="app.ReviewFlow", method_name="generate_content",
                           method_output={"title": "Draft", "body": "..."}, message="Approve this content?",
                           emit=list(emit) if emit else None, default_outcome=None, metadata={}, llm=None)


class CrewAITests(Base):
    def test_blocking_flow_feedback_returns_emit_label(self):
        p = wz_crewai.WayzaFeedbackProvider(self.wz, to="@zoe", timeout="10s")
        ctx = flow_context("flow-blocking")
        with Answerer(self.home, lambda ap: ("answered", {"choice": "approved"}) if ap["title"] == "Approve this content?"
                      and ap["request_id"].startswith("crewai:flow-blocking:") else None):
            fb = p.request_feedback(ctx, flow=None)
        self.assertEqual(fb, "approved")
        sent = [a for a in self.home.approvals.values() if a["request_id"].startswith("crewai:flow-blocking:")][0]
        self.assertEqual(sent["choices"], ["approved", "rejected"])

    @unittest.skipUnless(HAVE_CRYPTO, "cryptography not installed")
    def test_durable_flow_and_resume(self):
        p = wz_crewai.WayzaFeedbackProvider(self.wz, to="@zoe", durable=True, callback="https://agent.example.com/hook")
        ctx = flow_context("flow-durable")
        with mock.patch.dict(sys.modules, fake_crewai_modules()):
            with self.assertRaises(FakePending) as e:
                p.request_feedback(ctx, flow=None)
        info = e.exception.callback_info
        self.assertEqual(info["flow_id"], "flow-durable")
        self.assertEqual({k: info[k] for k in ("id", "request", "asked_by")},
                         {k: ctx.metadata["wayza"][k] for k in ("id", "request", "asked_by")})
        ap = self.home.settle(info["wayza_id"], "answered", choice="rejected", text="too long", deliver=False)

        class ReviewFlow:  # crewai Flow: from_pending(flow_id, persistence).resume(feedback)
            resumed = []

            def __init__(self, fid):
                self.fid = fid
                self.pending_feedback = ctx  # the persisted PendingFeedbackContext, metadata and all

            @classmethod
            def from_pending(cls, flow_id, persistence=None, **kw):
                return cls(flow_id)

            def resume(self, feedback=""):
                self.resumed.append((self.fid, feedback))
                return "done"

        res = Result.from_approval(ap)
        self.assertEqual(wz_crewai.flow_id_from(res), "flow-durable")
        self.assertEqual(wz_crewai.resume_flow(ReviewFlow, res, wayza=self.wz), "done")
        self.assertEqual(ReviewFlow.resumed, [("flow-durable", "rejected\n\ntoo long")])
        body = {"approval": ap, "signed_answer": ap["signed_answer"]}
        wz_crewai.resume_flow(ReviewFlow, body, wayza=self.wz, expect=info)
        self.assertEqual(ReviewFlow.resumed[-1][0], "flow-durable")
        # A genuine answer to another ask is refused, and the flow is not resumed.
        n = len(ReviewFlow.resumed)
        with self.assertRaisesRegex(WayzaVerifyError, "approval"):
            wz_crewai.resume_flow(ReviewFlow, self.body("Crew other?"), wayza=self.wz, flow_id="flow-durable")
        with self.assertRaisesRegex(WayzaVerifyError, "different request"):
            wz_crewai.resume_flow(ReviewFlow, body, wayza=self.wz, expect=dict(info, request="0" * 64))
        with self.assertRaises(WayzaVerifyError):
            wz_crewai.resume_flow(ReviewFlow, Result(approved=True, status="approved"), wayza=self.wz,
                                  flow_id="flow-durable")
        self.assertEqual(len(ReviewFlow.resumed), n)

    def test_flow_feedback_requires_a_person(self):
        ai = Result(approved=True, status="approved", as_="ai-on-behalf",
                    answers=[{"decision": "approved", "as": "ai-on-behalf"}])
        fb = wz_crewai.flow_feedback(ai, ["approved", "rejected"])
        self.assertTrue(fb.startswith("rejected\n\n"), fb)
        self.assertIn("ai-on-behalf", fb)
        chose = Result(approved=False, status="answered", choice="approved", as_="ai",
                       answers=[{"decision": "answered", "choice": "approved", "as": "ai"}])
        self.assertTrue(wz_crewai.flow_feedback(chose, ["approved", "rejected"]).startswith("rejected"))
        self.assertEqual(wz_crewai.flow_feedback(chose, ["approved", "rejected"], require_person=False), "approved")
        payload = wz_crewai.amp_resume_payload(ai, execution_id="e", task_id="t")
        self.assertFalse(payload["is_approve"])
        self.assertIn("person's answer is required", payload["human_feedback"])

    def test_task_human_input_provider(self):
        class Ctx:  # shaped like crewai's ExecutorContext
            def __init__(self):
                self.task = SimpleNamespace(id="task-1", description="Write a haiku about rain")
                self.crew = None
                self.messages = []
                self.ask_for_human_input = True
                self.rounds = 0

            def _format_feedback_message(self, feedback):
                return {"role": "user", "content": f"Feedback: {feedback}"}

            def _invoke_loop(self):
                self.rounds += 1
                return SimpleNamespace(output=f"haiku v{self.rounds + 1}")

        seen = []

        def policy(ap):
            if not ap["title"].startswith("Review: Write a haiku"):
                return None
            seen.append(ap["details"])
            return ("declined", {"text": "more rain"}) if ap["details"] == "haiku v1" else ("approved", {})

        provider = wz_crewai.WayzaHumanInputProvider(self.wz, to="@zoe", timeout="10s")
        self.assertFalse(provider.setup_messages(None))
        ctx = Ctx()
        with Answerer(self.home, policy):
            final = provider.handle_feedback(SimpleNamespace(output="haiku v1"), ctx)
        self.assertEqual(final.output, "haiku v2")
        self.assertEqual(seen, ["haiku v1", "haiku v2"])
        self.assertEqual(ctx.messages, [{"role": "user", "content": "Feedback: more rain"}])
        self.assertFalse(ctx.ask_for_human_input)

        captured = []
        with mock.patch.dict(sys.modules, fake_crewai_modules(set_provider=lambda p: captured.append(p) or "tok")):
            self.assertEqual(wz_crewai.use_for_human_input(provider), "tok")
        self.assertIs(captured[0], provider)

    def test_amp_payload(self):
        r = Result(approved=False, status="declined", text="redo the intro")
        self.assertEqual(wz_crewai.amp_resume_payload(r, execution_id="e1", task_id="research_task"), {
            "execution_id": "e1", "task_id": "research_task",
            "human_feedback": "declined\n\nredo the intro", "is_approve": False})


# ---------------------------------------------------------------------- ADK ----
def adk_events(call_id="adk-123"):
    # The event ADK yields: a function call named adk_request_confirmation
    fc = SimpleNamespace(name="adk_request_confirmation", id=call_id, args={
        "originalFunctionCall": {"name": "transfer_funds", "args": {"amount": 250, "recipient": "Bob"}, "id": "fc-9"},
        "toolConfirmation": {"hint": "Confirm transfer of $250 to Bob.", "confirmed": False},
    })
    other = SimpleNamespace(name="transfer_funds", id="fc-9", args={})
    ev1 = SimpleNamespace(content=SimpleNamespace(parts=[SimpleNamespace(function_call=other, text=None)]))
    ev2 = SimpleNamespace(content=SimpleNamespace(parts=[SimpleNamespace(function_call=fc, text=None)]))
    ev3 = {"content": {"parts": [{"text": "hi"}]}}
    return [ev1, ev2, ev3]


fake_genai_types = SimpleNamespace(
    Content=lambda role, parts: SimpleNamespace(role=role, parts=parts),
    Part=lambda function_response: SimpleNamespace(function_response=function_response),
    FunctionResponse=lambda name, id, response: SimpleNamespace(name=name, id=id, response=response),
)


class ADKTests(Base):
    def test_find_requests(self):
        reqs = wz_adk.confirmation_requests(adk_events())
        self.assertEqual(len(reqs), 1)
        r = reqs[0]
        self.assertEqual((r.id, r.tool_name, r.tool_call_id, r.hint), ("adk-123", "transfer_funds", "fc-9",
                                                                       "Confirm transfer of $250 to Bob."))
        self.assertEqual(r.tool_args, {"amount": 250, "recipient": "Bob"})
        # Events with get_function_calls() (the real Event API) work too.
        ev = SimpleNamespace(get_function_calls=lambda: [SimpleNamespace(name="adk_request_confirmation", id="x",
                                                                         args={"originalFunctionCall": {"name": "t"}})])
        self.assertEqual(wz_adk.confirmation_requests(ev)[0].tool_name, "t")

    def test_answer_confirmations(self):
        with Answerer(self.home, lambda ap: ("approved", {}) if ap["title"] == "Confirm transfer of $250 to Bob." else None):
            msg = wz_adk.answer_confirmations(adk_events("adk-777"), self.wz, to="@zoe", timeout="10s",
                                              types_module=fake_genai_types)
        self.assertEqual(msg.role, "user")
        fr = msg.parts[0].function_response
        self.assertEqual((fr.name, fr.id), ("adk_request_confirmation", "adk-777"))
        self.assertTrue(fr.response["confirmed"])
        self.assertEqual(fr.response["payload"]["as"], "person")
        self.assertIsNone(wz_adk.answer_confirmations([], self.wz))

    @unittest.skipUnless(HAVE_CRYPTO, "cryptography not installed")
    def test_durable(self):
        req = wz_adk.confirmation_requests(adk_events("adk-durable"))[0]
        asked = wz_adk.ask_for_confirmation(self.wz, req, to="@zoe", wait=False, callback="https://a.example/h")
        self.assertEqual(asked.status, "waiting")
        ap = self.home.settle(asked.id, "declined", text="not today", deliver=False)
        res = Result.from_approval(ap)
        self.assertEqual(wz_adk.confirmation_id_from(res), "adk-durable")
        resp = wz_adk.confirmation_response("adk-durable", res, self.wz, sent=pending_entry(asked))
        self.assertEqual(resp["response"]["confirmed"], False)
        self.assertEqual(resp["response"]["payload"]["text"], "not today")
        msg = wz_adk.confirmation_message(resp, types_module=fake_genai_types)
        self.assertEqual(msg.parts[0].function_response.id, "adk-durable")
        with self.assertRaises(ValueError):  # a body from outside needs the saved ask
            wz_adk.confirmation_response("adk-durable", {"approval": ap, "signed_answer": ap["signed_answer"]})

    @unittest.skipUnless(HAVE_CRYPTO, "cryptography not installed")
    def test_durable_pending_and_resume(self):
        pending = wz_adk.ask_confirmations(adk_events("adk-p1"), self.wz, to="@zoe", callback="https://a.example/h")
        self.assertEqual([p["confirmation_id"] for p in pending], ["adk-p1"])
        self.assertTrue({"id", "request", "asked_by", "wayza_id"} <= set(pending[0]))
        ap = self.home.settle(pending[0]["id"], "approved", deliver=False)
        body = {"approval": ap, "signed_answer": ap["signed_answer"]}
        msg = wz_adk.resume_confirmations([body], pending, self.wz, types_module=fake_genai_types)
        fr = msg.parts[0].function_response
        self.assertEqual((fr.id, fr.response["confirmed"]), ("adk-p1", True))
        # Replayed: a genuine answer to another ask, sent for this confirmation.
        with self.assertRaisesRegex(WayzaVerifyError, "approval"):
            wz_adk.resume_confirmations({"adk-p1": self.body("ADK other?")}, pending, self.wz,
                                        types_module=fake_genai_types)
        with self.assertRaises(ValueError):
            wz_adk.resume_confirmations([self.body("ADK other 2?")], pending, self.wz, types_module=fake_genai_types)
        with self.assertRaisesRegex(WayzaVerifyError, "different request"):
            wz_adk.resume_confirmations([body], [dict(pending[0], request="f" * 64)], self.wz,
                                        types_module=fake_genai_types)

    def test_ai_approval_is_not_a_confirmation(self):
        ai = Result(approved=True, status="approved", as_="ai", answers=[{"decision": "approved", "as": "ai"}])
        resp = wz_adk.confirmation_response("c1", ai)
        self.assertFalse(resp["response"]["confirmed"])
        self.assertIn("person's answer is required", resp["response"]["payload"]["reason"])
        self.assertTrue(wz_adk.confirmation_response("c1", ai, require_person=False)["response"]["confirmed"])


# --------------------------------------------------------- OpenAI Agents SDK ----
class FakeItem:  # agents.items.ToolApprovalItem
    def __init__(self, name, arguments, call_id):
        self.name, self.arguments, self.call_id = name, arguments, call_id


class FakeState:  # agents.RunState
    def __init__(self, items):
        self.items = items
        self.approved, self.rejected = [], []

    def get_interruptions(self):
        return [i for i in self.items if i not in self.approved and i not in [r[0] for r in self.rejected]]

    def approve(self, item, always_approve=False):
        self.approved.append(item)

    def reject(self, item, always_reject=False, *, rejection_message=None):
        self.rejected.append((item, rejection_message))


class FakeRunResult:
    def __init__(self, items, state=None):
        self.interruptions = items
        self._state = state or FakeState(items)
        self.final_output = None

    def to_state(self):
        return self._state


class OpenAIAgentsTests(Base):
    def policy(self, ap):
        if ap["title"] == "Allow cancel_order?":
            return ("approved", {})
        if ap["title"] == "Allow send_email?":
            return ("declined", {"text": "wrong customer"})
        return None

    def test_approve_interruptions(self):
        items = [FakeItem("cancel_order", '{"order_id": 1}', "call-a1"), FakeItem("send_email", '{"subject": "refund"}', "call-b1")]
        result = FakeRunResult(items)
        with Answerer(self.home, self.policy):
            state = wz_oa.approve_interruptions(self.wz, result, to="@zoe", timeout="10s")
        self.assertIs(state, result.to_state())
        self.assertEqual(state.approved, [items[0]])
        self.assertIs(state.rejected[0][0], items[1])
        self.assertIn("wrong customer", state.rejected[0][1])
        sent = [a for a in self.home.approvals.values() if a["request_id"] == "openai-agents:call-a1"][0]
        self.assertIn('"order_id": 1', sent["details"])

    @unittest.skipUnless(HAVE_CRYPTO, "cryptography not installed")
    def test_durable_ask_and_apply(self):
        items = [FakeItem("cancel_order", '{"order_id": 2}', "call-a2"), FakeItem("send_email", "{}", "call-b2")]
        result = FakeRunResult(items)
        asks = wz_oa.ask_interruptions(self.wz, result, to="@zoe", callback="https://a.example/h")
        self.assertEqual([a["call_id"] for a in asks], ["call-a2", "call-b2"])
        self.assertTrue({"id", "request", "asked_by", "wayza_id"} <= set(asks[0]))
        ap = self.home.settle(asks[0]["wayza_id"], "approved", deliver=False)
        state = FakeState(items)  # as if reloaded with RunState.from_string(agent, saved)
        # Replays: A's genuine approval offered for B, or an answer to an ask we never sent.
        with self.assertRaisesRegex(WayzaVerifyError, "approval"):
            wz_oa.apply_answers(state, {"call-b2": Result.from_approval(ap)}, pending=asks, wayza=self.wz)
        with self.assertRaises(ValueError):
            wz_oa.apply_answers(state, [self.body("OA other?")], pending=asks, wayza=self.wz)
        with self.assertRaisesRegex(WayzaVerifyError, "different request"):
            wz_oa.apply_answers(state, [Result.from_approval(ap)], wayza=self.wz,
                                pending=[dict(asks[0], request="1" * 64), asks[1]])
        with self.assertRaises(WayzaVerifyError):  # no signed answer at all
            wz_oa.apply_answers(state, {"call-b2": Result(approved=True, status="approved")}, pending=asks, wayza=self.wz)
        self.assertEqual((state.approved, state.rejected), ([], []))
        left = wz_oa.apply_answers(state, [Result.from_approval(ap)], pending=asks, wayza=self.wz)
        self.assertEqual(state.approved, [items[0]])
        self.assertEqual(left, [items[1]])
        ex = self.home.end(asks[1]["wayza_id"], "expired", deliver=False)
        left = wz_oa.apply_answers(state, {"call-b2": {"approval": ex, "signed_answer": ex["signed_answer"]}},
                                   pending=asks, wayza=self.wz)
        self.assertEqual(left, [])
        self.assertIn("expired", state.rejected[0][1])

    def test_ai_approval_rejects_the_call(self):
        item = FakeItem("cancel_order", "{}", "call-ai")
        state = FakeState([item])
        ai = Result(approved=True, status="approved", as_="ai-unclaimed",
                    answers=[{"decision": "approved", "as": "ai-unclaimed"}])
        wz_oa.apply_answer(state, item, ai)
        self.assertEqual(state.approved, [])
        self.assertIn("person's answer is required", state.rejected[0][1])
        wz_oa.apply_answer(state, item, ai, require_person=False)
        self.assertEqual(state.approved, [item])

    def test_run_with_approvals(self):
        items = [FakeItem("cancel_order", '{"order_id": 3}', "call-a3")]

        class Runner:  # agents.Runner.run(agent, input_or_state)
            calls = []

            @classmethod
            async def run(cls, agent, inp, **kw):
                cls.calls.append(inp)
                if len(cls.calls) == 1:
                    return FakeRunResult(items)
                return SimpleNamespace(interruptions=[], final_output="cancelled")

        async def main():
            return await wz_oa.run_with_approvals("agent", "cancel order 3", self.wz, to="@zoe", timeout="10s",
                                                  runner=Runner)

        with Answerer(self.home, self.policy):
            out = asyncio.run(main())
        self.assertEqual(out.final_output, "cancelled")
        self.assertIsInstance(Runner.calls[1], FakeState)
        self.assertEqual(Runner.calls[1].approved, items)


class NoFrameworkImportsTests(unittest.TestCase):
    def test_adapters_do_not_import_frameworks(self):
        # A fresh interpreter: other test modules may import frameworks on purpose.
        import subprocess

        src = os.path.join(os.path.dirname(__file__), "..", "src")
        code = ("import sys; sys.path.insert(0, %r); "
                "import wayza_human, wayza_human.langgraph, wayza_human.crewai, wayza_human.adk, wayza_human.openai_agents; "
                "bad = [m for m in ('langgraph', 'crewai', 'google.adk', 'google.genai', 'agents', 'cryptography') if m in sys.modules]; "
                "print(','.join(bad))") % src
        out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
        self.assertEqual(out.stdout.strip(), "", "imported at module load: " + out.stdout)


if __name__ == "__main__":
    unittest.main()
