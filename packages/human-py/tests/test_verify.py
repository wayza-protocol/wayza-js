import copy
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))

from mock_server import HAVE_CRYPTO, CallbackReceiver, MockHome  # noqa: E402

from wayza_human import (  # noqa: E402
    Wayza, WayzaVerifyError, check_answer, clear_key_cache, parse_callback, request_fingerprint, verify,
)


@unittest.skipUnless(HAVE_CRYPTO, "cryptography is not installed: pip install 'wayza-human[verify]'")
class VerifyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = MockHome().start()
        cls.wz = Wayza("fam_bot", cls.home.home, insecure=True)

    @classmethod
    def tearDownClass(cls):
        cls.home.stop()

    def setUp(self):
        clear_key_cache()

    def settled(self, decision="approved", **kw):
        r = self.wz.ask("Verify me? " + decision + json.dumps(kw), to="graham@wayza.com", callback=kw.pop("callback", None))
        return self.home.settle(r.id, decision, **kw)

    def test_valid_record(self):
        ap = self.settled()
        rec = verify(ap["signed_answer"], home=self.home.home, insecure=True)
        self.assertEqual(rec["status"], "approved")
        # A string works too, and so does a bare netloc as `home`.
        verify(json.dumps(ap["signed_answer"]), home=self.home.netloc, insecure=True)
        self.assertEqual(self.wz.verify(ap["signed_answer"])["home"], self.home.netloc)

    def test_tampered_record(self):
        rec = copy.deepcopy(self.settled()["signed_answer"])
        rec["status"] = "declined"
        with self.assertRaisesRegex(WayzaVerifyError, "does not verify"):
            verify(rec, home=self.home.home, insecure=True)
        rec = copy.deepcopy(self.settled()["signed_answer"])
        rec["answers"][0]["as"] = "person "
        with self.assertRaises(WayzaVerifyError):
            verify(rec, home=self.home.home, insecure=True)

    def test_http_needs_insecure(self):
        rec = self.settled()["signed_answer"]
        with self.assertRaisesRegex(WayzaVerifyError, "https"):
            verify(rec, home=self.home.home)

    def test_wrong_home(self):
        rec = self.settled()["signed_answer"]
        with self.assertRaisesRegex(WayzaVerifyError, "expected"):
            verify(rec, home="https://wayza.com", insecure=True)
        verify(rec, home=None, insecure=True)  # unpinned: any home whose keys verify

    def test_approval_must_be_on_signing_home(self):
        rec = copy.deepcopy(self.settled()["signed_answer"])
        rec["home"] = "evil.example"
        with self.assertRaisesRegex(WayzaVerifyError, "not on the home"):
            verify(rec, home=None, insecure=True)

    def test_unknown_or_retired_key(self):
        rec = copy.deepcopy(self.settled()["signed_answer"])
        rec["sig"]["kid"] = "nope"
        with self.assertRaisesRegex(WayzaVerifyError, "unknown signing key"):
            verify(rec, home=self.home.home, insecure=True)
        rec["sig"]["kid"] = "old-key"
        with self.assertRaises(WayzaVerifyError):
            verify(rec, home=self.home.home, insecure=True)

    def test_key_fetcher_injection(self):
        rec = self.settled()["signed_answer"]
        seen = []

        def fetch(origin):
            seen.append(origin)
            return self.home.well_known()

        verify(rec, home=self.home.home, insecure=True, key_fetcher=fetch)
        self.assertEqual(seen, [self.home.home])

    def test_not_a_record(self):
        for bad in ({}, {"v": 2, "type": "wayza.answer"}, "not json", [1]):
            with self.assertRaises(WayzaVerifyError):
                verify(bad, home=None, insecure=True)

    def test_parse_callback_end_to_end(self):
        recv = CallbackReceiver()
        try:
            r = self.wz.ask("Pay the plumber £120?", to="graham@wayza.com", choices=["Yes", "Haggle"], free_text=True,
                            callback=recv.url)
            self.home.settle(r.id, "answered", choice="Haggle", text="offer £100")
            self.assertTrue(recv.event.wait(5), "callback never arrived")
            body = recv.bodies[0]
            res = parse_callback(body, home=self.home.home, insecure=True)
            self.assertTrue(res.verified)
            self.assertEqual((res.status, res.choice, res.text, res.as_), ("answered", "Haggle", "offer £100", "person"))
            self.assertEqual(res.id, r.id)
            # The method is pinned to the client's home.
            self.assertEqual(self.wz.parse_callback(body.decode()).choice, "Haggle")
            # checked says whether it was tied to the ask, not just signed.
            self.assertFalse(self.wz.parse_callback(body.decode()).checked)
            self.assertTrue(self.wz.parse_callback(body.decode(), expect=r).checked)
            # Swapping in another approval's id is caught.
            doc = json.loads(body)
            doc["approval"]["id"] = r.id + 1000
            with self.assertRaisesRegex(WayzaVerifyError, "does not match"):
                parse_callback(doc, home=self.home.home, insecure=True)
            # So is an edited status in the signed part.
            doc = json.loads(body)
            doc["signed_answer"]["status"] = "approved"
            with self.assertRaises(WayzaVerifyError):
                parse_callback(doc, home=self.home.home, insecure=True)
            with self.assertRaises(WayzaVerifyError):
                parse_callback({"approval": {}}, home=self.home.home, insecure=True)
        finally:
            recv.stop()

    def test_expired_record_has_waiting_answers(self):
        r = self.wz.ask("Expire me?", to=["@zoe", "@ann"])
        ap = self.home.end(r.id, "expired", deliver=False)
        res = parse_callback({"approval": ap, "signed_answer": ap["signed_answer"]}, home=self.home.home, insecure=True)
        self.assertEqual(res.status, "expired")
        self.assertFalse(res.approved)
        self.assertIsNone(res.answered_by)
        self.assertEqual([a["decision"] for a in res.answers], ["waiting", "waiting"])

    def test_client_can_verify_while_polling(self):
        wz = Wayza("fam_bot", self.home.home, insecure=True, verify_answers=True)
        r = wz.ask("Poll and verify?", to="@zoe")
        self.home.settle(r.id, "approved")
        got = wz.get(r.id)
        self.assertTrue(got.verified and got.approved)


@unittest.skipUnless(HAVE_CRYPTO, "cryptography is not installed: pip install 'wayza-human[verify]'")
class PinningAndReplayTests(unittest.TestCase):
    """Answers must come from the client's home and answer the very ask that was sent."""

    @classmethod
    def setUpClass(cls):
        cls.home = MockHome().start()
        cls.other = MockHome().start()  # another genuine home, with its own key

        def fetch(origin):
            for h in (cls.home, cls.other):
                if origin == h.home:
                    return h.well_known()
            raise AssertionError(origin)

        cls.fetch = staticmethod(fetch)
        cls.wz = Wayza("fam_bot", cls.home.home, insecure=True, key_fetcher=fetch)
        cls.wz_other = Wayza("fam_bot", cls.other.home, insecure=True, key_fetcher=fetch)

    @classmethod
    def tearDownClass(cls):
        cls.home.stop()
        cls.other.stop()

    def answered(self, wz, home, title, decision="approved", ask=None, **kw):
        r = wz.ask(title, to="graham@wayza.com", **(ask or {}))
        ap = home.settle(r.id, decision, deliver=False, **kw)
        return r, {"approval": ap, "signed_answer": ap["signed_answer"]}

    def test_record_from_another_home_is_refused(self):
        r, body = self.answered(self.wz_other, self.other, "Other home?")
        # Genuinely signed: it verifies against its own home...
        self.assertEqual(verify(body["signed_answer"], home=self.other.home, insecure=True, key_fetcher=self.fetch)["status"],
                         "approved")
        # ...but this client's home is pinned everywhere it verifies.
        with self.assertRaisesRegex(WayzaVerifyError, "expected"):
            self.wz.parse_callback(body)
        with self.assertRaisesRegex(WayzaVerifyError, "expected"):
            self.wz.verify(body["signed_answer"])
        with self.assertRaisesRegex(WayzaVerifyError, "expected"):
            parse_callback(body, home=self.home.home, insecure=True, key_fetcher=self.fetch)
        with self.assertRaises(ValueError):
            parse_callback(body, home=None, insecure=True, key_fetcher=self.fetch)

    def test_fingerprint_is_what_the_home_signs(self):
        r, body = self.answered(self.wz, self.home, "Fingerprint £5 é?",
                                ask={"details": "d", "choices": ["Ja", "Nein"], "free_text": True})
        rec = body["signed_answer"]
        self.assertEqual(request_fingerprint(r.approval), rec["request"])
        self.assertRegex(rec["request"], "^[0-9a-f]{64}$")
        self.assertEqual(check_answer(rec, r.approval), rec)
        check_answer(rec, r)
        check_answer(json.dumps(rec), {"id": str(r.id), "request": rec["request"], "asked_by": rec["asked_by"]})
        self.assertTrue(self.wz.parse_callback(body, expect=r).approved)

    def test_replayed_answers_are_refused(self):
        a, body_a = self.answered(self.wz, self.home, "Replay A?")
        b, body_b = self.answered(self.wz, self.home, "Replay B?")
        rec_a = body_a["signed_answer"]
        with self.assertRaisesRegex(WayzaVerifyError, "approval"):
            check_answer(rec_a, b.approval)  # genuine, but for another approval
        with self.assertRaisesRegex(WayzaVerifyError, "approval"):
            self.wz.parse_callback(body_a, expect=b)
        reworded = dict(a.approval, title="Replay A, but bigger?")
        with self.assertRaisesRegex(WayzaVerifyError, "different request"):
            check_answer(rec_a, reworded)  # same id, different request
        with self.assertRaisesRegex(WayzaVerifyError, "different request"):
            self.wz.parse_callback(body_a, expect={"id": a.id, "request": "0" * 64, "asked_by": rec_a["asked_by"]})
        with self.assertRaisesRegex(WayzaVerifyError, "someone else"):
            check_answer(rec_a, {"id": a.id, "request": rec_a["request"], "asked_by": "@ai-other@" + self.home.netloc})
        with self.assertRaises(WayzaVerifyError):
            check_answer(rec_a, {"id": a.id, "request": rec_a["request"]})

    def test_wait_for_and_ask_and_wait_check_the_answer(self):
        a, body_a = self.answered(self.wz, self.home, "Polled A?")
        b = self.wz.ask("Polled B?", to="graham@wayza.com", request_id="polled-b")
        self.home.settle(b.id, "declined", deliver=False)
        # The home hands back A's (genuine) record for B.
        self.home.approvals[b.id]["signed_answer"] = body_a["signed_answer"]
        self.assertEqual(self.wz.wait_for(b.id, 5).status, "approved")  # a bare id: no check
        with self.assertRaisesRegex(WayzaVerifyError, "approval"):
            self.wz.wait_for(b, 5)
        with self.assertRaisesRegex(WayzaVerifyError, "approval"):
            self.wz.wait_for(b.approval, 5)
        with self.assertRaisesRegex(WayzaVerifyError, "approval"):
            self.wz.ask_and_wait("Polled B?", to="graham@wayza.com", request_id="polled-b", timeout=5)
        good = self.wz.wait_for(a, 5)
        self.assertTrue(good.approved)

    def test_require_person(self):
        helper = Wayza("fam_helper", self.home.home, insecure=True)
        r = self.wz.ask("Agent approves?", to="@ai-helper")
        helper.reply(r.id, "approved")
        plain = self.wz.wait_for(r, 5)
        self.assertTrue(plain.approved)  # off by default: the caller checks as_
        self.assertEqual(plain.as_, "ai-unclaimed")
        self.assertFalse(plain.by_person)
        strict = Wayza("fam_bot", self.home.home, insecure=True, key_fetcher=self.fetch, require_person=True)
        got = strict.wait_for(r, 5)
        self.assertFalse(got.approved)
        self.assertEqual(got.status, "approved")
        self.assertIn("person's answer is required", got.reason)
        self.assertIn("ai-unclaimed", got.reason)
        body = {"approval": got.approval, "signed_answer": got.signed_answer}
        self.assertFalse(parse_callback(body, home=self.home.home, insecure=True, key_fetcher=self.fetch,
                                        require_person=True).approved)
        p, body_p = self.answered(strict, self.home, "Person approves?")
        self.assertTrue(strict.parse_callback(body_p, expect=p).approved)
        self.assertIsNone(strict.parse_callback(body_p).reason)


if __name__ == "__main__":
    unittest.main()
