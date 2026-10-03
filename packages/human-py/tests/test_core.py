import asyncio
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))

from mock_server import MockHome  # noqa: E402

from wayza_human import (  # noqa: E402
    AsyncWayza, Result, Wayza, WayzaError, WayzaTimeout, canonical, parse_timeout, stable_request_id,
)


def later(delay, fn, *args, **kwargs):
    t = threading.Timer(delay, fn, args, kwargs)
    t.daemon = True
    t.start()
    return t


class UtilTests(unittest.TestCase):
    def test_parse_timeout(self):
        self.assertEqual(parse_timeout(90), 90.0)
        self.assertEqual(parse_timeout("90"), 90.0)
        self.assertEqual(parse_timeout("30s"), 30.0)
        self.assertEqual(parse_timeout("15m"), 900.0)
        self.assertEqual(parse_timeout("24h"), 86400.0)
        self.assertEqual(parse_timeout("2d"), 172800.0)
        self.assertEqual(parse_timeout("1h30m"), 5400.0)
        self.assertEqual(parse_timeout("1.5h"), 5400.0)
        self.assertIsNone(parse_timeout(None))
        for bad in ("soon", "24x", "h", "", "-5", True):
            with self.assertRaises(ValueError, msg=bad):
                parse_timeout(bad)

    def test_stable_request_id(self):
        a = stable_request_id({"title": "x", "to": ["a"], "details": None})
        b = stable_request_id({"to": ["a"], "title": "x"})
        c = stable_request_id({"title": "y", "to": ["a"]})
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)
        self.assertTrue(a.startswith("wh-"))

    def test_canonical_matches_js_reference(self):
        sample = {"z": [1, 2.5, None, True, "é ☃   \"q\""], "a": {"b": None, "a": "x/y"}, "n": -0.125, "e": ""}
        py = canonical(sample)
        self.assertEqual(py, '{"a":{"a":"x/y","b":null},"e":"","n":-0.125,"z":[1,2.5,null,true,"é ☃   \\"q\\""]}')
        node = shutil.which("node")
        if not node:
            self.skipTest("node not installed")
        js = ("const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? "
              "`{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v ?? null);"
              "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(canonical(JSON.parse(s))));")
        out = subprocess.run([node, "-e", js], input=json.dumps(sample).encode(), capture_output=True, check=True)
        self.assertEqual(out.stdout.decode("utf-8"), py)


class CoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = MockHome().start()

    @classmethod
    def tearDownClass(cls):
        cls.home.stop()

    def wz(self, key="fam_bot", **kw):
        return Wayza(key, self.home.home, insecure=True, **kw)

    def test_verifies_answers_by_default_when_it_can(self):
        from wayza_human._client import _can_verify
        self.assertEqual(self.wz().verify_answers, _can_verify())
        self.assertFalse(self.wz(verify_answers=False).verify_answers)

    def test_inbox_leaves_out_asks_for_the_person(self):
        wz = self.wz()
        wz.list_approvals = lambda: {"waiting_for_your_person": [{"id": 1, "addressed_to": "you"}, {"id": 2, "addressed_to": "your_person"}, {"id": 3}]}
        self.assertEqual([a["id"] for a in wz.inbox()], [1, 3])
        self.assertEqual([a["id"] for a in wz.inbox(for_person=True)], [1, 2, 3])

    def test_http_home_needs_insecure(self):
        with self.assertRaises(ValueError):
            Wayza("k", self.home.home)

    def test_key_from_env(self):
        os.environ["WAYZA_KEY"] = "fam_bot"
        try:
            self.assertEqual(Wayza(home=self.home.home, insecure=True).key, "fam_bot")
        finally:
            del os.environ["WAYZA_KEY"]

    def test_ask_get_and_answer(self):
        wz = self.wz()
        r = wz.ask("Refund £40 to order 1182?", to="graham@wayza.com", details="Arrived broken.", timeout="1h")
        self.assertEqual(r.status, "waiting")
        self.assertFalse(r.approved)
        self.assertIsInstance(r.id, int)
        sent = self.home.approvals[r.id]["_request"]
        self.assertTrue(sent["request_id"].startswith("wh-"))
        self.assertTrue(sent["expires_at"].endswith("Z"))
        self.assertEqual(sent["to"], "graham@wayza.com")
        self.assertEqual(wz.get(r.id).status, "waiting")
        later(0.2, self.home.settle, r.id, "approved")
        t0 = time.monotonic()
        done = wz.get(r.id, wait=5)
        self.assertLess(time.monotonic() - t0, 3)
        self.assertTrue(done.approved)
        self.assertEqual(done.status, "approved")
        self.assertEqual(done.answered_by, "graham@wayza.com")
        self.assertEqual(done.as_, "person")
        self.assertTrue(done.by_person)
        self.assertEqual(done.signed_answer["status"], "approved")

    def test_retries_do_not_double_ask(self):
        wz = self.wz()
        a = wz.ask("Same question?", to=["@zoe"], choices=["Yes", "No"])
        b = wz.ask("Same question?", to=["@zoe"], choices=["Yes", "No"])
        c = wz.ask("Same question?", to=["@zoe"], choices=["Yes", "No"], request_id="run-1/call-2")
        self.assertEqual(a.id, b.id)
        self.assertNotEqual(a.id, c.id)

    def test_retry_on_503(self):
        wz = self.wz()
        self.home.fail_next = [503, 429]
        r = wz.ask("After a hiccup?", to="@zoe")
        self.assertEqual(r.status, "waiting")

    def test_errors(self):
        with self.assertRaises(WayzaError) as e:
            self.wz("fam_nope").get(1)
        self.assertEqual(e.exception.status, 401)
        with self.assertRaises(WayzaError) as e:
            self.wz().get(999999)
        self.assertEqual(e.exception.status, 404)
        self.assertIn("No approval", str(e.exception))
        with self.assertRaises(WayzaError) as e:
            Wayza("", self.home.home, insecure=True).get(1)
        self.assertIn("no Wayza key", str(e.exception))
        with self.assertRaises(ValueError):
            self.wz().ask("x" * 201)
        with self.assertRaises(ValueError):
            self.wz().ask("ok", choices=["only one"])

    def test_wait_for_and_choices(self):
        wz = self.wz()
        r = wz.ask("How much should we refund?", to="@zoe", choices=["Full", "Half", "None"], free_text=True)
        later(0.2, self.home.settle, r.id, "answered", choice="Half", text="keep the box", person="Zoe")
        done = wz.wait_for(r.id, "10s")
        self.assertFalse(done.approved)
        self.assertEqual((done.status, done.choice, done.text), ("answered", "Half", "keep the box"))

    def test_wait_for_timeout(self):
        wz = self.wz()
        r = wz.ask("Nobody answers?", to="@zoe")
        with self.assertRaises(WayzaTimeout) as e:
            wz.wait_for(r.id, 1)
        self.assertEqual(e.exception.approval_id, r.id)

    def test_ask_and_wait(self):
        wz = self.wz()
        ids = []

        def answer_first_waiting():
            for _ in range(100):
                waiting = [a for a in self.home.approvals.values() if a["title"] == "Ship it?" and a["status"] == "waiting"]
                if waiting:
                    ids.append(waiting[0]["id"])
                    self.home.settle(waiting[0]["id"], "declined", text="Not on a Friday")
                    return
                time.sleep(0.05)

        later(0.1, answer_first_waiting)
        r = wz.ask_and_wait("Ship it?", to="@zoe", timeout="20s")
        self.assertEqual(r.status, "declined")
        self.assertEqual(r.text, "Not on a Friday")
        self.assertFalse(r.approved)

    def test_ask_and_wait_cancels_on_timeout(self):
        wz = self.wz()
        r = wz.ask_and_wait("Too slow?", to="@zoe", timeout=1)
        self.assertEqual(r.status, "cancelled")
        self.assertFalse(r.approved)
        self.assertEqual(r.answers[0]["decision"], "waiting")
        self.assertIsNone(r.answered_by)
        with self.assertRaises(WayzaTimeout):
            wz.ask_and_wait("Too slow again?", to="@zoe", timeout=1, on_timeout="raise")

    def test_cancel(self):
        wz = self.wz()
        r = wz.ask("Never mind?", to="@ann")
        c = wz.cancel(r.id)
        self.assertEqual(c.status, "cancelled")
        self.assertEqual(c.signed_answer["status"], "cancelled")

    def test_agent_to_agent_inbox_and_reply(self):
        asker = self.wz("fam_bot")
        helper = self.wz("fam_helper")
        r = asker.ask("Can you take this booking?", to="@ai-helper", choices=["Yes", "No"])
        inbox = helper.inbox()
        self.assertIn(r.id, [a["id"] for a in inbox])
        self.assertNotIn(r.id, [a["id"] for a in self.wz("fam_other").inbox()])
        replied = helper.reply(r.id, "answered", choice="Yes")
        self.assertEqual((replied.status, replied.choice, replied.as_), ("answered", "Yes", "ai-unclaimed"))
        self.assertFalse(replied.by_person)
        got = asker.get(r.id)
        self.assertEqual(got.choice, "Yes")
        self.assertEqual(got.as_, "ai-unclaimed")
        sent = [x for x in self.home.requests if x[1].endswith("/reply")][-1]
        self.assertEqual(sent[1], f"/wayza/v0/approvals/{r.id}/reply")
        self.assertEqual(sent[2], {"decision": "answered", "choice": "Yes"})
        with self.assertRaises(ValueError):
            helper.reply(r.id, "maybe")
        with self.assertRaises(WayzaError) as e:
            self.wz("fam_other").reply(r.id, "approved")
        self.assertEqual(e.exception.status, 403)

    def test_result_roundtrip(self):
        r = Result(approved=True, status="approved", as_="person", approval={"id": 3})
        d = r.to_dict()
        self.assertEqual(d["as"], "person")
        json.dumps(d)
        self.assertEqual(Result.from_dict(d), r)


class AsyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = MockHome().start()

    @classmethod
    def tearDownClass(cls):
        cls.home.stop()

    def test_async_round_trip(self):
        async def main():
            wz = AsyncWayza("fam_bot", self.home.home, insecure=True)
            r = await wz.ask("Async ask?", to="@zoe")
            later(0.2, self.home.settle, r.id, "approved")
            done = await wz.wait_for(r, "10s")  # the approval: its answer is checked against it
            self.assertTrue(done.approved)
            slow = await wz.ask_and_wait("Async too slow?", to="@zoe", timeout=1)
            self.assertEqual(slow.status, "cancelled")
            helper = AsyncWayza("fam_helper", self.home.home, insecure=True)
            q = await wz.ask("Async to an agent?", to="@ai-helper")
            self.assertIn(q.id, [a["id"] for a in await helper.inbox()])
            rep = await helper.reply(q.id, "declined", text="busy")
            self.assertEqual((rep.status, rep.text), ("declined", "busy"))

        asyncio.run(main())


if __name__ == "__main__":
    unittest.main()
