# wayza-human (Python)

When an agent toolkit pauses a run for human approval, `wayza-human` sends the question to a
real person through [Wayza](https://wayza.com) and resumes the run on their **signed** answer.
The person answers in Wayza, or by a one-tap email link if they aren't on Wayza.

- The core is stdlib-only (urllib). Python 3.10+.
- Verifying signatures needs Ed25519: `pip install 'wayza-human[verify]'` (adds `cryptography`).
- Adapters for LangGraph, CrewAI, Google ADK and the OpenAI Agents SDK. None of them imports
  its framework until you call it.
  Tested with langgraph 1.2, crewai 1.15, google-adk 2.11 and openai-agents 0.23. The CrewAI
  adapter needs a CrewAI with `crewai.core.providers` (1.6 does not have it).

## Who answered: `as`

Every answer says **how** it was given, in the signed record's `as` (exposed as `result.as_`).
`approved` alone only says the ask was approved, not that a human approved it.

| `as` | Who gave the answer | Counts as a person? |
|---|---|---|
| `person` | The person themselves, signed in to Wayza | yes |
| `email-link` | The person, by the one-tap link in the email Wayza sent them | yes |
| `ai-on-behalf` | An AI answering *for* its person (with the "approve" scope) | no |
| `ai` | An AI answering for itself (agent to agent) | no |
| `ai-unclaimed` | An AI with no owner answering for itself | no |

Why it matters: `to` can be another agent, and an AI can be allowed to answer for its
person. If your code treats any `approved` as consent, an AI (possibly one that was talked
into it, or one nobody owns) can approve a refund or a deletion. So:

- **The gate adapters require a person by default** (`require_person=True`): LangGraph,
  CrewAI, ADK and the OpenAI Agents SDK. An approval from `ai`, `ai-on-behalf` or
  `ai-unclaimed` is treated as *not approved*, and the reason says why
  (`result.reason`, the tool's decline message, the rejection message, the feedback).
  Pass `require_person=False` only if an AI's approval really is enough.
- **The plain client does not** (it returns what happened): check `r.as_` or `r.by_person`
  yourself, or create the client with `Wayza(require_person=True)` to get the same rule.
  When it applies, `status` still shows the signed outcome (`"approved"`) but
  `approved` is `False` and `reason` is set.

## Install

```sh
pip install wayza-human            # core
pip install 'wayza-human[verify]'  # + signature verification (recommended)
```

To try changes from this repo: `pip install './packages/human-py[verify]'`.

## The core

```python
from wayza_human import Wayza

wz = Wayza()  # key from WAYZA_KEY (your agent's fam_... connector key); home="https://wayza.com"

r = wz.ask_and_wait("Refund £40 to order 1182?", to="you@example.com",
                    details="Customer says it arrived broken.", timeout="24h")
if r.approved:
    refund()
print(r.status, r.choice, r.text, r.answered_by, r.as_)
```

| Call | What it does |
|---|---|
| `ask(title, to=, details=, choices=, free_text=, needs=, request_id=, expires_at=, timeout=, callback=)` | `POST /approvals`. Returns a `Result` with status `waiting`. |
| `get(id, wait=None)` | `GET /approvals/{id}`. With `wait` (up to 30 s) the server holds until the ask settles. |
| `wait_for(id_or_approval, timeout)` | Long-polls until it settles. Raises `WayzaTimeout` after `timeout`. Given the approval (the `Result` from `ask`), it also checks the answer belongs to that ask (`check_answer`). |
| `ask_and_wait(..., timeout="24h", on_timeout="cancel")` | Asks and waits. If the timeout passes, it cancels the ask and returns that result (`"raise"` raises instead). |
| `cancel(id)` | `DELETE /approvals/{id}`. |
| `inbox()` | `GET /approvals`, `waiting_for_your_person`: asks waiting for this agent (or its person). |
| `reply(id, decision, choice=None, text=None)` | `POST /approvals/{id}/reply`: answers, as this agent, an ask another agent sent it. |
| `decide(id, decision, ...)` | `POST /approvals/{id}/decision`: answers *for your person* (needs the "approve" scope). |
| `verify(signed_answer)` / `parse_callback(body, expect=)` | Checks a signed record against this client's home (see below). |
| `request_fingerprint(approval)` / `check_answer(signed_answer, sent)` | Tie an answer to the ask that was sent (see below). |

`timeout` takes seconds or strings like `"90s"`, `"15m"`, `"24h"`, `"2d"` or `"1h30m"`. If you
don't pass `expires_at`, the timeout sets it (the server caps it at 30 days).

**Retries don't double-ask.** The default `request_id` is a stable hash of the ask (title,
details, recipients, choices, ...), so a retried or replayed call returns the same approval.
Pass your own `request_id` (for example `"run-77/tool-call-3"`) when the same question may
legitimately be asked again. The adapters scope it for you, using the graph thread, the tool
call id or the flow id.

`Result` fields: `approved`, `status` (`waiting | approved | declined | answered | expired | cancelled`),
`choice`, `text`, `answered_by`, `as_` (see "Who answered" above), `approval` (the raw object),
`signed_answer`, plus `answers`, `verified`, `reason`, `.id`, `.by_person` and
`.to_dict()` / `Result.from_dict()`.

### Async

```python
from wayza_human import AsyncWayza
r = await AsyncWayza().ask_and_wait("Deploy to prod?", to="@your-name", timeout="1h")
```

### Callbacks and verification

Pass `callback="https://your.app/wayza"`. When the ask settles, the home POSTs
`{approval, signed_answer}` to that URL. Treat the body as untrusted until it verifies:

```python
wz = Wayza()                                   # the home you trust is the client's home
result = wz.parse_callback(request.body, expect=saved)  # raises WayzaVerifyError unless genuine
```

`saved` is what you stored when you asked: the approval (`r.approval`), or
`{"id", "request", "asked_by"}`. The module-level `parse_callback(body, home=...)` needs the
home you trust; it refuses `home=None`.
Without `expect` only the signature is checked and `result.checked` is False: on its own that
could be a genuine answer to a different ask on your home, so check it against your saved ask
before acting.

`verify()` serialises the record without `sig` canonically. It fetches the keys from
`{origin of record["approval"]}/.well-known/wayza.json`, checks the Ed25519 signature,
and requires `urlparse(approval).netloc == record["home"]`. The record must also come from
the home you trust: `home="https://wayza.com"` by default (`home=None` turns that check off).
It requires https unless you pass `insecure=True` (for local or dev homes on
`http://localhost`). Keys marked `retired` are still accepted, so old records keep
verifying. In expired or cancelled records, people who never answered appear with
`decision: "waiting"`.

With `wayza-human[verify]` installed, the signed answers you get by polling are verified too (`verify_answers` defaults to on when it can; pass `False` to turn it off).

### Tie each answer to the ask you sent

A signature only proves the home said *something*. A genuine answer to another of your asks
(or to the same question asked differently) is still genuine, so a replayed callback could
approve the wrong thing. Each signed record carries `request`, a fingerprint of the ask, and
`asked_by`:

- `request_fingerprint(approval)` takes the approval returned by `POST /approvals` and returns
  the lowercase hex sha-256 of the canonical JSON of `{title, details, choices, free_text,
  asked_by (asked_by_address), to (sorted), request_id, expires_at}`, exactly as the home computes it.
- `check_answer(signed_answer, sent)` raises `WayzaVerifyError` unless the record's approval id,
  `asked_by` and `request` all match `sent` (the approval, or a saved `{"id", "request", "asked_by"}`).
  It doesn't check the signature: verify first.

`ask_and_wait`, `wait_for(approval)`, `parse_callback(expect=...)` and every adapter's durable
mode apply it for you. Durable adapters save `id`, `request` and `asked_by` with each pending
ask and check them on resume; resuming needs the signed answer (and `wayza-human[verify]`).

## Frameworks, one line each

```python
# LangGraph: ask from inside a node or tool (blocking), or pause with interrupt() (durable)
r = wayza_human.langgraph.ask_human("Refund £40?", to="you@example.com", durable=True)

# CrewAI Flows: @human_feedback(message="Approve?", emit=["approved", "rejected"], llm=..., provider=...)
provider = wayza_human.crewai.WayzaFeedbackProvider(to="you@example.com")

# Google ADK: answer FunctionTool(require_confirmation=True) / tool_context.request_confirmation()
reply = wayza_human.adk.answer_confirmations(events, to="you@example.com")

# OpenAI Agents SDK: @function_tool(needs_approval=True)
result = await wayza_human.openai_agents.run_with_approvals(agent, "cancel order 7", to="you@example.com")
```

### LangGraph (`wayza_human.langgraph`)

- `ask_human(title, ..., durable=False)`. The blocking mode asks and long-polls inside the node.
  `durable=True` sends the ask, then calls `interrupt({"type": "wayza.ask", "wayza_id": ...})`.
  The checkpointer saves the run, and you store `wayza_id` with the thread id.
- `pending_asks(result)` reads `result["__interrupt__"]` and returns `[{"interrupt_id", "wayza_id", "id", "request", "asked_by", "value"}]`.
- `wait_and_resume(wz, result)` returns `Command(resume=...)` once answered (a map by interrupt id when several are pending).
- `resume_from_callback(body)` verifies the callback and returns `Command(resume=<result>)`.
- `approval_node(make_ask)` and `@require_approval(to=...)` (put it under `@tool`) are the node and tool helpers.

When the run resumes, the node re-runs, the ask returns the same approval (same request id,
scoped by `thread_id` and `checkpoint_ns`), and the resume value is accepted only if its
signed answer verifies against the client's home and answers that ask. Gates
(`ask_human`, `approval_node`, `@require_approval`) default to `require_person=True`.

### CrewAI (`wayza_human.crewai`)

- **Flows:** pass `WayzaFeedbackProvider(to=..., durable=False)` to `@human_feedback(provider=...)`.
  It offers your `emit` outcomes as choices. `durable=True` raises `HumanFeedbackPending`
  (with `callback_info["wayza_id"]`, `id`, `request`, `asked_by`, also saved in the pending
  context's `metadata["wayza"]`), so `kickoff()` returns the pending object. Later,
  `resume_flow(MyFlow, callback_body, persistence=...)` checks the answer against that saved
  ask and calls `MyFlow.from_pending(flow_id).resume(feedback)`. An AI's answer comes back as
  "rejected" with the reason unless `require_person=False`.
- **Tasks with `human_input=True`:** `use_for_human_input(WayzaHumanInputProvider(to=...))`
  makes the review go to a person instead of stdin. An approval accepts the answer. A decline
  or a typed answer goes back to the agent for another round.
- **CrewAI AMP webhook HITL:** `amp_resume(crew_url, token, result, execution_id=..., task_id=...)`
  posts to the deployed crew's `/resume`.

### Google ADK (`wayza_human.adk`)

The ADK emits an `adk_request_confirmation` function call. `answer_confirmations(events, to=...)`
asks the person and returns the `types.Content` to send back with
`runner.run_async(..., new_message=reply)`. For durable runs, save
`pending = ask_confirmations(events, to=..., callback=url)` and later build the reply with
`resume_confirmations(answers, pending)`, which verifies and checks each answer. An AI's
approval is sent as `confirmed: False` unless `require_person=False`.

### OpenAI Agents SDK (`wayza_human.openai_agents`)

`approve_interruptions(wz, result, to=...)` returns the `RunState` with `approve()` or
`reject(rejection_message=...)` applied, ready for `Runner.run(agent, state)`.
`run_with_approvals` runs the whole loop. For durable runs, call `asks = ask_interruptions(...)`,
store `result.to_state().to_string()` and `asks`, then after `RunState.from_string(agent, saved)`
call `apply_answers(state, answers, pending=asks)`. An AI's approval rejects the call unless
`require_person=False`.

## Agent to agent

`to` doesn't have to be a person. It can be another agent's address (`"@ai-1f2e3d4c"` or
`"@ai-1f2e3d4c@wayza.com"`). The other agent sees the ask in `inbox()` and answers with
`reply(id, "answered", choice="Yes")`. On the asking side, `result.as_` tells you who answered:
`"person"` or `"email-link"` for a human, `"ai-on-behalf"` for an AI answering for its person,
and `"ai"` or `"ai-unclaimed"` for an AI answering for itself (see "Who answered" above).
`result.by_person` is a shortcut. Check it before treating an answer as human consent.

## Agents with no owner

An agent doesn't need a person behind it to use this. An unclaimed agent's key can still ask
and still reply to asks sent to it. Its asks are marked `from_ai_with_no_owner`, and they wait
quietly in the person's Requests instead of notifying them. A person can turn such asks away
entirely. Ownerless agents can't email people outside Wayza, and their own answers are signed
as `ai-unclaimed`.

## Tests

```sh
cd packages/human-py && PYTHONPATH=src python3 -m unittest discover -s tests
```

A mock home built on `http.server` implements the contract, with Ed25519 signing when
`cryptography` is installed. Without it, the signature tests are skipped. The adapter tests
use fake objects shaped like each framework's API. `tests/test_real_frameworks.py` runs the
adapters against the real frameworks (scripted models, no network) when they are installed,
and skips otherwise.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
