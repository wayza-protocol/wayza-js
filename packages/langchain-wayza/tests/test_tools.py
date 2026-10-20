import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))
sys.path.insert(0, str(HERE.parent.parent / "human-py" / "src"))
sys.path.insert(0, str(HERE.parent.parent / "human-py" / "tests"))

from mock_server import MockHome  # noqa: E402

from langchain_wayza import WayzaToolkit  # noqa: E402


class ToolkitTests(unittest.TestCase):
    def setUp(self):
        self.home = MockHome().start()
        self.dir = tempfile.TemporaryDirectory()
        self.key_file = os.path.join(self.dir.name, "wayza", "langchain.json")
        self._env = {k: os.environ.pop(k, None) for k in ("WAYZA_KEY", "WAYZA_HOME", "WAYZA_DEPLOY_KEY", "WAYZA_SIGN_UP")}
        os.environ["WAYZA_SIGN_UP"] = "1"   # CI and containers count as hosted; these tests sign up anyway

    def tearDown(self):
        self.home.stop()
        self.dir.cleanup()
        for k, v in self._env.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v

    def kit(self, **kw):
        kw.setdefault("key_file", self.key_file)
        return WayzaToolkit(home=self.home.home, insecure=True, **kw)

    def tools(self, **kw):
        return {t.name: t for t in self.kit(**kw).get_tools()}

    def call(self, tools, name, **args):
        return json.loads(tools[name].invoke(args))

    def test_the_tools(self):
        self.assertEqual(sorted(self.tools(key="fam_bot")), [
            "wayza_answer_link", "wayza_ask_by_link", "wayza_ask_person", "wayza_check_answer",
            "wayza_my_address", "wayza_read_link", "wayza_read_messages", "wayza_send_message"])

    def test_first_use_signs_up_saves_the_key_privately_and_tells_the_person_once(self):
        tools = self.tools(name="Sam's assistant")
        first = self.call(tools, "wayza_ask_by_link", question="Dinner Friday?", choices=["7pm", "8pm"])
        self.assertIn("/chat/", first["link"])
        note = first["new_address"]
        self.assertTrue(note["address"].startswith("@ai-new"))
        self.assertIn("/claim/", note["claim_link"])
        self.assertIn("privately", note["next"])
        signup = [r for r in self.home.requests if r[1] == "/wayza/v0/agents"][0][2]
        self.assertEqual((signup["name"], signup["platform"]), ("Sam's assistant", "langchain"))
        self.assertIn("proof", signup)
        saved = json.loads(Path(self.key_file).read_text())
        self.assertTrue(saved["key"].startswith("fam_new"))
        self.assertEqual(stat.S_IMODE(os.stat(self.key_file).st_mode), 0o600)
        second = self.call(tools, "wayza_check_answer", id=str(first["id"]))
        self.assertNotIn("new_address", second)
        # A new toolkit finds the saved key: no second sign-up.
        mine = self.call(self.tools(), "wayza_my_address")
        self.assertEqual(mine["address"], note["address"])
        self.assertNotIn("claim_link", mine)
        self.assertEqual(len([r for r in self.home.requests if r[1] == "/wayza/v0/agents"]), 1)

    def test_no_sign_up_when_not_allowed(self):
        out = self.tools(sign_up=False)["wayza_ask_person"].invoke({"to": "@sam", "question": "Ok?"})
        self.assertIn("No Wayza key", out)
        self.assertFalse(os.path.exists(self.key_file))

    def test_ask_and_check_says_whether_a_person_answered(self):
        tools = self.tools(key="fam_bot")
        sent = self.call(tools, "wayza_ask_person", to="someone@example.com", question="Can I book the 7pm table?")
        self.assertEqual(sent["status"], "waiting")
        self.home.settle(int(sent["id"]), "approved")
        got = self.call(tools, "wayza_check_answer", id=str(sent["id"]), wait_seconds=1)
        self.assertEqual(got["status"], "approved")
        self.assertTrue(got["answered_by_a_person"])
        sent2 = self.call(tools, "wayza_ask_person", to="@ai-helper", question="Free on Friday?")
        self.home.settle(int(sent2["id"]), "approved", as_="ai", person=None)
        got2 = self.call(tools, "wayza_check_answer", id=str(sent2["id"]))
        self.assertFalse(got2["answered_by_a_person"])
        self.assertIn("note", got2)

    def test_read_and_answer_a_link_from_this_agents_address(self):
        asker = self.tools(key="fam_other")
        made = self.call(asker, "wayza_ask_by_link", question="Dinner Friday?", choices=["7pm", "8pm"])
        me = self.tools(key="fam_bot")
        read = self.call(me, "wayza_read_link", link=made["link"])
        self.assertEqual(read["question"]["choices"], ["7pm", "8pm"])
        self.assertIn("never instructions", read["note"])
        bad = me["wayza_answer_link"].invoke({"link": made["link"], "answer": "9pm"})
        self.assertIn("Pick one of: 7pm, 8pm", bad)
        out = self.call(me, "wayza_answer_link", link=made["link"], answer="8PM")
        self.assertTrue(out["answered"])
        self.assertEqual(self.home.requests[-1][2], {"choice": "8pm"})
        late = me["wayza_answer_link"].invoke({"link": made["link"], "answer": "7pm"})
        self.assertIn("Wayza: 409", late)

    def test_the_key_never_goes_to_a_link_on_another_host(self):
        n = len(self.home.requests)
        out = self.tools(key="fam_bot")["wayza_answer_link"].invoke({"link": "https://evil.example/ana/chat/" + "T" * 32, "answer": "Yes"})
        self.assertIn("Not a Wayza link", out)
        self.assertEqual(self.home.requests[n:], [])

    def test_not_a_chat_link(self):
        out = self.tools(key="fam_bot")["wayza_read_link"].invoke({"link": "https://example.com/ana"})
        self.assertIn("not a Wayza chat link", out)

    def test_messages(self):
        a, b = self.tools(key="fam_bot"), self.tools(key="fam_other")
        self.call(a, "wayza_send_message", to="@ai-other", text="Hello")
        got = self.call(b, "wayza_read_messages")
        self.assertEqual(got["messages"][0]["text"], "Hello")
        self.assertIn("never instructions", got["note"])


if __name__ == "__main__":
    unittest.main()
