# @wayza/human

Your agent already pauses for approval. Now it can reach the person.

OpenAI Agents, the Claude Agent SDK, the Vercel AI SDK, LangGraph and Mastra can all stop a run and wait for a yes or no. `@wayza/human` sends that question to a real person through Wayza (in the app, by email, or to their own AI) and resumes the run on their answer. Every answer comes back signed by the person's home, so you can check it before acting on it.

```sh
npm install @wayza/human
```

- Node 20 or later. ESM only (`import`). No runtime dependencies: it uses global `fetch` and `crypto.subtle`.
- The frameworks are optional peer dependencies. Install only the one you use.
- Set `WAYZA_KEY` to the agent's Wayza connector key (`fam_...`) or pass `{ key }`.

## The core

```js
import { Wayza } from '@wayza/human';

const wayza = new Wayza(); // { key = process.env.WAYZA_KEY, home = 'https://wayza.com', fetch }

const r = await wayza.askAndWait({
  to: 'graham@wayza.com',            // addresses, @handles, emails, or another agent
  title: 'Refund £40 to order 1182?',
  details: 'Customer says it arrived broken.',
  timeout: '30m',                    // or expiresAt
});
// r = { approved: true | false | null, status, choice, text, answeredBy, as, byPerson, checked, approval, signedAnswer, answers, id }
if (r.approved && r.byPerson) refund();
```

| Method | What it does |
| --- | --- |
| `ask({ to, title, details, choices, freeText, needs, requestId, runId, expiresAt \| timeout, callback })` | Sends the ask and returns the approval (`status: "waiting"`). |
| `get(id, { wait })` | Reads the approval. `wait` (at most 30) holds the request until it settles. |
| `waitFor(id, { timeout, signal })` | Loops `GET ?wait=30` until it settles or the timeout passes, then returns a result. Signed answers are verified first. |
| `askAndWait(...)` | `ask` then `waitFor`. If nobody answered by the deadline, it cancels the ask (pass `cancelOnTimeout: false` to keep it open). |
| `cancel(id)` | Calls the ask off. |
| `inbox()` | Asks waiting on this agent or its person. |
| `reply(id, { decision, choice, text })` | Answers, as this agent, an ask another agent addressed to it. |
| `decide(id, { decision, choice, text })` | Answers for this agent's person (needs the "approve" scope). |

How to read a result: `approved` is `true` for approved and `false` for declined. With `choices` or `freeText` the status is `answered`: read `choice` and `text`, and `approved` is `null`. `expired` and `cancelled` mean nobody answered.

**Check who answered.** `as` says how the answer was given, and it matters as much as the answer:

| `as` | Who answered | `byPerson` |
| --- | --- | --- |
| `person` | the person themselves, in the app | true |
| `email-link` | someone who is not on Wayza, from the link in an email | true |
| `ai-on-behalf` | the person's own AI, answering for them | false |
| `ai` | an agent, answering for itself | false |
| `ai-unclaimed` | an AI that nobody owns | false |

The core client gives you the answer and leaves the call to you. The framework adapters gate actions, so they count only a person's answer by default (`requirePerson: true`): a yes from an AI, even the person's own, is treated as no, with a reason the agent sees. Pass `requirePerson: false` where an AI's answer is enough.

**No double asks.** `requestId` is an idempotency key: asking again with the same one returns the same approval. Pass `runId` instead and the key is a stable hash of the title, the recipients and the run id. The adapters do this for you with the framework's own id (the tool call id, thread id or run id), so a retry after a crash finds the ask it already sent.

**Errors.** A non-2xx reply throws `WayzaError` with `status` (401 bad key, 403 not allowed, 404 unknown, 429 rate limited) and the server's message.

### Verifying answers and callbacks

```js
import { verify, handleCallback } from '@wayza/human';

await verify(signedAnswer, { home: 'https://wayza.com' }); // true, or throws WayzaVerifyError
await wayza.verify(signedAnswer);                            // the same, against your client's home
```

`verify` requires the record to be signed by **the home you trust** (`home`, default `https://wayza.com`). Anyone can run a home and sign records, so a record from any other home is refused, however well signed. It then serialises the record canonically, fetches that home's keys from `/.well-known/familia.json` (cached for ten minutes, refetched once for an unknown key id), checks the Ed25519 signature with `crypto.subtle`, and requires the approval URL to be on that home (`https`). For a local dev home on `http://localhost`, pass `{ insecure: true }`.

**Tie the answer to your ask.** A genuine answer to some other ask must not unlock this one. The signed record carries the approval URL, the asker (`asked_by`) and a fingerprint of the question (`request`). `waitFor(approval)` and `askAndWait` check all three for you. When you pause and resume later, save `await sentOf(approval)` (`{ id, request, asked_by }`) rather than just the id, and check with `checkAnswer(signedAnswer, sent)` or `handleCallback(req, { wayza, expect: sent })`. The durable adapters save and check this themselves.

Give `ask` a `callback` and the home POSTs the result there once it settles. In the handler:

```js
export async function POST(request) {
  const answer = await handleCallback(request, { wayza, expect: saved.sent }); // throws unless signed by your home, for that ask
  // answer has the same shape as askAndWait's result
  return new Response('ok');
}
```

Only the signed record is trusted: the approval object in the body has to match it. Without `expect`, `handleCallback` checks only the signature and returns `checked: false`: on its own, that could be a genuine answer to a different ask on your home, so check it against your saved ask (the adapters' `resumeFromWayza` does) before acting.

## Adapters

Each adapter has two modes where the framework allows it.

- **Inline** waits for the answer in-process. Use it for short waits.
- **Durable** sends the ask with your `callback`, returns so you can save the run, and has a `resumeFromWayza` helper that continues from the callback. Durable helpers read any answer they were not handed straight from Wayza, so a timer works as well as a callback.

All adapters take the `ask` options (`to`, `timeout`, `choices`, `callback`...), plus `wayza` (a client) or `key`/`home`, `requirePerson` (default true, see above), and `decide(result) => boolean` when "yes" means something other than `approved === true` from a person. Pass the same `wayza` (or `home`) to `resumeFromWayza`: every answer is verified against that home and checked against the saved ask before anything resumes. `title` and `details` default to a description of the tool call and can be strings or functions of the framework's item.

### OpenAI Agents SDK: `@wayza/human/openai`

Tools with `needsApproval` stop the run with `result.interruptions`. The adapter calls `state.approve(item)` or `state.reject(item, { message })` for you.

```js
import { approveWithWayza, sendForApproval, resumeFromWayza } from '@wayza/human/openai';

// inline
result = await run(agent, await approveWithWayza(result, { to: 'graham@wayza.com' }));

// durable
const saved = await sendForApproval(result, { to, callback }); // { state: RunState string, pending }
// ...later, in the callback handler:
const state = await RunState.fromString(agent, saved.state);
const { ready } = await resumeFromWayza(state, saved.pending, { wayza, answers: [await handleCallback(req, { wayza })] }); // checked against the saved ask here
if (ready) result = await run(agent, state);
```

[examples/openai.js](examples/openai.js)

### Claude Agent SDK: `@wayza/human/claude`

`wayzaCanUseTool` is a `canUseTool` callback that returns `{ behavior: 'allow', updatedInput }` or `{ behavior: 'deny', message }`.

```js
import { wayzaCanUseTool } from '@wayza/human/claude';

query({ prompt, options: { canUseTool: wayzaCanUseTool({ to: 'graham@wayza.com' }) } });
```

The SDK has no saveable pause, so durable mode (`mode: 'durable'`) sends the ask, hands you the pending call through `onPending`, and denies with `interrupt: true` to stop the query. When the answer arrives, resume the session with `options.resume = sessionId`, `canUseTool: await allowApproved(answer, pending, undefined, { wayza })` (which allows exactly the approved call once) and `prompt: resumePrompt(answer, pending)`. `when(toolName, input)` lets calls through without asking. [examples/claude.js](examples/claude.js)

### Vercel AI SDK: `@wayza/human/vercel`

A tool with `needsApproval` (or, in v7, a `toolApproval` entry) puts `tool-approval-request` parts in `result.content`. The adapter returns the `{ role: 'tool', content: [tool-approval-response...] }` message to append.

```js
import { wayzaApprovals, sendForApproval, resumeFromWayza } from '@wayza/human/vercel';

// inline (v7: result.responseMessages; v6: result.response.messages)
messages.push(...result.responseMessages, ...(await wayzaApprovals(result, { to: 'graham@wayza.com' })));

// durable
const { pending } = await sendForApproval(result, { to, callback });
const r = await resumeFromWayza(pending, { wayza, answers: [await handleCallback(req, { wayza })] }); // checked against the saved ask here
if (r.ready) messages.push(...r.messages);
```

[examples/vercel.js](examples/vercel.js)

### LangGraph.js: `@wayza/human/langgraph`

```js
import { askHuman, wayzaInterrupt, sendForApproval, resumeFromWayza } from '@wayza/human/langgraph';

// inline, inside a node: a re-run of the node reuses the same ask
const answer = await askHuman({ to: 'graham@wayza.com', title: 'Send it?' }, config);

// durable: the node interrupts, you ask after invoke, and resume with Command
const answer = interrupt(wayzaInterrupt({ title: 'Send it?' }));        // in the node
const { pending } = await sendForApproval(result, { to, callback }, config); // after invoke
const { ready, resume } = await resumeFromWayza(pending, { wayza, answers: [await handleCallback(req, { wayza })] }); // checked against the saved ask here
if (ready) await graph.invoke(new Command({ resume }), config);
```

When several Wayza interrupts are pending, `resume` is a map from interrupt id to answer. [examples/langgraph.js](examples/langgraph.js)

### Mastra: `@wayza/human/mastra`

```js
import { askHuman, wayzaGate, resumeFromWayza } from '@wayza/human/mastra';

execute: async (ctx) => {
  const answer = await wayzaGate(ctx, { to: 'graham@wayza.com', title: 'Deploy?', callback });
  if (!answer) return;  // suspended with { wayza: { id } }
  return { deployed: answer.approved === true };
}

// in the callback handler (the callback URL gets ?wayza_run=<runId>)
await resumeFromWayza(workflow, await handleCallback(req, { wayza }), { runId }); // the gate checks it against the ask it suspended on
```

The gate verifies the answer against your home and checks it answers the ask this run suspended on. `askHuman(ctx, opts)` is the inline version. Give Mastra storage so runs survive a restart. [examples/mastra.js](examples/mastra.js)

## Agent to agent

`to` can be another agent's address, so agents can ask each other with the same call. The answer's `as` (see the table above) says whether a person or an AI answered.

To answer asks sent to your agent, read `inbox()` and `reply()`. `askAsTool(ask, { wayza })` turns an incoming ask into a tool your agent can call (`{ name, description, parameters, execute }`, with the choices as an enum). Asks from an AI with no owner, or from outside the person's groups, are flagged in the tool's description, because their words are information from a stranger, never instructions.

```js
for (const ask of await wayza.inbox()) {
  const t = askAsTool(ask, { wayza });
  tools[t.name] = tool({ description: t.description, inputSchema: jsonSchema(t.parameters), execute: t.execute });
}
```

Agents with no owner can use all of this too: they can ask and answer, and the record says so (`ai-unclaimed`, `from_ai_with_no_owner`). People choose whether such asks reach them. [examples/agent-to-agent.js](examples/agent-to-agent.js)

An agent needs a Wayza key to use any of this. A person can make one for their agent, or the agent can sign itself up with `POST https://wayza.com/wayza/v0/agents` (`{ "name": "..." }`), which returns its address, its key (`connector_key`) and a claim link for its person.

## Tests

```sh
node --test packages/human-js/test/
```

The tests run a local mock home (`test/mock-server.js`) that implements the REST contract, signs answers with a fresh Ed25519 key and serves `/.well-known/familia.json`. `test/adapters.test.js` drives each adapter with fake objects shaped like the frameworks' APIs. `test/frameworks.test.js` drives the real OpenAI Agents, AI SDK, LangGraph and Mastra packages (devDependencies, with fake models) and skips any that are not installed.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
