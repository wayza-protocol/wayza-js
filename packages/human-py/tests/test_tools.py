import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))
sys.path.insert(0, str(HERE))

from mock_server import MockHome  # noqa: E402

from wayza_human.tools import HOSTED_SERVER_VARS, WayzaAccount, tool_functions  # noqa: E402

NAMES = ["wayza_answer_link", "wayza_ask_by_link", "wayza_ask_person", "wayza_check_answer",
         "wayza_my_address", "wayza_read_link", "wayza_read_messages", "wayza_send_message"]


def _installed(mod):
    try:
        __import__(mod)
        return True
    except Exception:
        return False


class ToolsTests(unittest.TestCase):
    def setUp(self):
        self.home = MockHome().start()
        self.dir = tempfile.TemporaryDirectory()
        self.key_file = os.path.join(self.dir.name, "wayza", "test.json")
        self._env = {k: os.environ.pop(k, None) for k in ("WAYZA_KEY", "WAYZA_HOME", "WAYZA_DEPLOY_KEY", *HOSTED_SERVER_VARS)}

    def tearDown(self):
        self.home.stop()
        self.dir.cleanup()
        for k, v in self._env.items():
            if v is not None:
                os.environ[k] = v

    def account(self, **kw):
        kw.setdefault("key_file", self.key_file)
        return WayzaAccount(home=self.home.home, insecure=True, **kw)

    def tools(self, **kw):
        return {f.__name__: f for f in tool_functions(self.account(**kw))}

    def signups(self):
        return [r for r in self.home.requests if r[1] == "/wayza/v0/agents"]

    def test_the_tools_have_docs_and_types(self):
        tools = self.tools(key="fam_bot")
        self.assertEqual(sorted(tools), NAMES)
        for f in tools.values():
            self.assertTrue(f.__doc__)
        self.assertIn("Args:", tools["wayza_ask_person"].__doc__)

    def test_first_use_signs_up_saves_the_key_privately_and_tells_the_person_once(self):
        tools = self.tools(name="Sam's assistant", platform="strands")
        first = tools["wayza_ask_by_link"](question="Dinner Friday?", choices=["7pm", "8pm"])
        self.assertIn("/chat/", first["link"])
        note = first["new_address"]
        self.assertTrue(note["address"].startswith("@ai-new"))
        self.assertIn("/claim/", note["claim_link"])
        signup = self.signups()[0][2]
        self.assertEqual((signup["name"], signup["platform"]), ("Sam's assistant", "strands"))
        self.assertIn("proof", signup)
        self.assertEqual(stat.S_IMODE(os.stat(self.key_file).st_mode), 0o600)
        self.assertNotIn("new_address", tools["wayza_check_answer"](id=str(first["id"])))
        again = self.tools()
        self.assertEqual(again["wayza_my_address"]()["address"], note["address"])
        self.assertEqual(len(self.signups()), 1)

    def test_on_a_hosted_server_it_asks_for_a_key_instead_of_signing_up(self):
        os.environ["K_SERVICE"] = "agent"
        out = self.tools()["wayza_ask_person"](to="@sam", question="Ok?")
        self.assertIn("WAYZA_KEY", out["error"])
        self.assertIn("python -m wayza_human sign-up", out["error"])
        self.assertEqual(self.signups(), [])
        self.assertFalse(os.path.exists(self.key_file))
        self.assertEqual(self.tools(key="fam_bot")["wayza_ask_person"](to="@sam", question="Ok?")["status"], "waiting")

    def test_no_sign_up_when_not_allowed(self):
        self.assertIn("No Wayza key", self.tools(sign_up=False)["wayza_ask_person"](to="@sam", question="Ok?")["error"])

    def test_ask_and_check_says_whether_a_person_answered(self):
        tools = self.tools(key="fam_bot")
        sent = tools["wayza_ask_person"](to="someone@example.com", question="Can I book the 7pm table?")
        self.home.settle(int(sent["id"]), "approved")
        got = tools["wayza_check_answer"](id=str(sent["id"]), wait_seconds=1)
        self.assertEqual(got["status"], "approved")
        self.assertTrue(got["answered_by_a_person"])
        sent2 = tools["wayza_ask_person"](to="@ai-helper", question="Free on Friday?")
        self.home.settle(int(sent2["id"]), "approved", as_="ai", person=None)
        got2 = tools["wayza_check_answer"](id=str(sent2["id"]))
        self.assertFalse(got2["answered_by_a_person"])

    def test_read_and_answer_a_link(self):
        made = self.tools(key="fam_other")["wayza_ask_by_link"](question="Dinner Friday?", choices=["7pm", "8pm"])
        me = self.tools(key="fam_bot")
        self.assertEqual(me["wayza_read_link"](link=made["link"])["question"]["choices"], ["7pm", "8pm"])
        self.assertIn("Pick one of: 7pm, 8pm", me["wayza_answer_link"](link=made["link"], answer="9pm")["error"])
        self.assertTrue(me["wayza_answer_link"](link=made["link"], answer="8PM")["answered"])
        self.assertIn("not a Wayza chat link", me["wayza_read_link"](link="https://example.com/ana")["error"])

    def test_messages(self):
        self.tools(key="fam_bot")["wayza_send_message"](to="@ai-other", text="Hello")
        got = self.tools(key="fam_other")["wayza_read_messages"]()
        self.assertEqual(got["messages"][0]["text"], "Hello")
        self.assertIn("never instructions", got["note"])

    @unittest.skipUnless(_installed("google.adk"), "google-adk not installed")
    def test_real_adk_builds_function_tools(self):
        from google.adk.agents import LlmAgent
        from google.adk.tools import FunctionTool
        from wayza_human.adk import wayza_tools

        tools = wayza_tools("fam_bot", home=self.home.home, key_file=self.key_file)
        agent = LlmAgent(name="helper", model="gemini-2.5-flash", tools=tools)
        decl = FunctionTool(tools[0])._get_declaration()
        self.assertEqual(decl.name, "wayza_ask_person")
        # Newer ADK fills parameters_json_schema, older ones parameters.
        schema = decl.parameters_json_schema or decl.parameters.model_dump(exclude_none=True)
        self.assertEqual(sorted(schema["required"]), ["question", "to"])
        self.assertIn("choices", schema["properties"])
        self.assertIn("Args:", decl.description)
        self.assertEqual(len(agent.tools), 8)

    @unittest.skipUnless(_installed("strands"), "strands-agents not installed")
    def test_real_strands_tools_run(self):
        from wayza_human.strands import wayza_tools

        tools = {t.tool_name: t for t in wayza_tools(account=self.account(key="fam_bot"))}
        self.assertEqual(sorted(tools), NAMES)
        spec = tools["wayza_ask_person"].tool_spec
        self.assertEqual(sorted(spec["inputSchema"]["json"]["required"]), ["question", "to"])
        self.assertIn("Wayza", spec["description"])
        out = tools["wayza_ask_person"](to="@sam", question="Ok?")
        self.assertEqual(out["status"], "waiting")

    @unittest.skipUnless(_installed("crewai.tools"), "crewai not installed")
    def test_real_crewai_tools_run(self):
        from wayza_human.crewai import wayza_tools

        tools = {t.name: t for t in wayza_tools(account=self.account(key="fam_bot"))}
        self.assertEqual(sorted(tools), NAMES)
        self.assertIn("question", tools["wayza_ask_person"].args_schema.model_json_schema()["properties"])
        out = tools["wayza_ask_person"].run(to="@sam", question="Ok?")
        self.assertEqual(out["status"], "waiting")


if __name__ == "__main__":
    unittest.main()
