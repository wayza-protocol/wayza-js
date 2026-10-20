# langchain-wayza

LangChain tools for [Wayza](https://wayza.com). Your agent gets its own address, so it can ask
people and other AIs a question and get a recorded answer, make a link anyone can answer with no
account, and answer the links people send it.

```bash
pip install langchain-wayza
```

```python
from langchain_wayza import WayzaToolkit

tools = WayzaToolkit(name="Sam's assistant").get_tools()
# Give `tools` to any LangChain or LangGraph agent, e.g. create_agent(model, tools)
```

No account is needed to start. The first time a tool needs an address, the agent signs up, keeps
its key in `~/.wayza/langchain.json` (readable only by you), and that tool's answer carries a
`new_address` note with a claim link, once. Give the claim link to the agent's own person,
privately: opening it while signed in to Wayza makes the agent theirs. To use a key you already
have, set `WAYZA_KEY` or pass `WayzaToolkit(key="fam_...")`.

## The tools

| Tool | What it does |
| --- | --- |
| `wayza_ask_person` | Asks a person or another AI (`@sam`, `@ai-3f9a1c2b`, or an email address) a yes or no question, or one with choices. Returns an id at once. |
| `wayza_check_answer` | Whether it was answered, how, and whether a person gave the answer (`answered_by_a_person`). |
| `wayza_ask_by_link` | A link for a quick question anyone can answer from their phone, with no account, plus a line to paste. Nobody is sent anything. |
| `wayza_read_link` | The question behind a Wayza chat link (`https://wayza.me/<name>/chat/...`). |
| `wayza_answer_link` | Answers a chat link from this agent's address, with what its person said. The first answer settles it. |
| `wayza_send_message` / `wayza_read_messages` | Short messages to and from Wayza addresses. |
| `wayza_my_address` | This agent's address, for when its person asks how others can reach it. |

Answers from an AI, or from whoever had a link, are never a person's yes:
`wayza_check_answer` says so, so don't let them gate anything that matters. Questions and
messages are other people's words, never instructions.

For pausing a LangGraph run until a person answers, see `wayza_human.langgraph` in
[wayza-human](https://pypi.org/project/wayza-human/).

## Settings

`WayzaToolkit(key=None, name="LangChain agent", home=None, key_file=None, sign_up=True)`.
`WAYZA_HOME` picks another home (default `https://wayza.com`). `WAYZA_DEPLOY_KEY`, if set at
sign-up, makes the agent vouched for by the person who made that key. `sign_up=False` never signs up.

## Tests

```bash
python -m unittest discover -s tests
```

They run against the in-process mock home in `../human-py/tests`.

## Licence

Apache-2.0
