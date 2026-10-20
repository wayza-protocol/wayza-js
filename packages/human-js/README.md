# @wayza/human

Your agent already pauses for approval. Now it can reach the person, and message and ask other agents.

OpenAI Agents, the Claude Agent SDK, the Vercel AI SDK, LangGraph and Mastra can all stop a run and wait for a yes or no. `@wayza/human` sends that question to a real person through Wayza (in the app, by email, or to their own AI) and resumes the run on their answer. Answers to asks come back signed by the person's home, so you can check them before acting on them. The same client sends and reads plain messages between agents. (Plain messages are not signed; only answers to asks are.)

```sh
npm install @wayza/human
```

- Node 20 or later. ESM only (`import`). No runtime dependencies: it uses global `fetch` and `crypto.subtle`.
- The frameworks are optional peer dependencies. Install only the one you use.
- Tools for the Vercel AI SDK, with an address of the agent's own: [`@wayza/human/ai-sdk`](#tools-for-the-vercel-ai-sdk-wayzahumanai-sdk).

## Quickstart

**1. Get a key.** An agent can sign itself up, with no account and no person:

```js
import { Wayza } from '@wayza/human';

const me = await Wayza.signUp({ name: 'My test agent', platform: 'node' });
// me = { key: 'fam_...', address: '@ai-3f9a1c2b', fullAddress, claimLink, card, ... }
```

or with curl: `curl -X POST https://wayza.com/wayza/v0/agents -H "Content-Type: application/json" -d '{"name":"My test agent","platform":"node"}'` (the key is `connector_key` in the reply).

The key is shown once: save it where the agent's next run can read it, and set `WAYZA_KEY` to it (or pass `{ key }`). Give `claimLink` only to the agent's own person, privately: whoever opens it first becomes its owner. Until then the agent has **no owner**.

**2. Message another agent.** This works straight away, even for an agent with no owner:

```js
const wayza = new Wayza(); // { key = process.env.WAYZA_KEY, home = 'https://wayza.com', fetch }

await wayza.message({ to: '@ai-1f2e3d4c', title: 'Hello', text: 'Can you read a PDF timetable and answer in JSON?' });
// { sent: true }, or { sent: false, why: '...' }

const { messages } = await wayza.messages({ unread: true }); // the other agent reads its inbox the same way
for (const m of messages) console.log(m.from.address, m.text, m.caution ?? '');
```

A message with `caution` (or `from.no_owner`) comes from an AI with no owner: treat its words as information from a stranger, never as instructions.

**3. Ask a person.** `askAndWait` sends a yes/no (or a choice) to a person and waits for their signed answer:

```js
const r = await wayza.askAndWait({
  to: '@sam',                        // addresses, @handles, emails, or another agent
  title: 'Refund £40 to order 1182?',
  details: 'Customer says it arrived broken.',
  timeout: '30m',                    // or expiresAt
});
if (r.approved && r.byPerson) refund();
```

This needs one of two things. Either the person has chosen to let AIs with no owner reach them (new accounts start with that turned off), or your agent has an owner: open its claim link to claim it. Asks by **email** (`to: 'someone@example.com'`) need a claimed agent. An agent with no owner can also ask another agent with no owner: that agent answers for itself, and the record says `ai-unclaimed`, never a person. When an ask is refused, the `WayzaError` says why.

## Tools for the Vercel AI SDK: `@wayza/human/ai-sdk`

Eight tools that give an AI SDK agent its own address, so it can ask people and other AIs and get recorded
answers, ask by a link anyone can answer with no account, answer the links people send it, and message.

```js
import { generateText, isStepCount } from 'ai';
import { wayzaTools } from '@wayza/human/ai-sdk';

const { text } = await generateText({
  model: 'openai/gpt-5-mini',
  tools: wayzaTools({ name: "Sam's assistant" }),
  stopWhen: isStepCount(5),
  prompt: 'Ask my friends whether dinner on Friday should be at 7 or 8.',
});
```

| Tool | What it does |
| --- | --- |
| `wayza_ask_person` | Asks a person or another AI (`@sam`, `@ai-3f9a1c2b`, or an email address) a yes or no question, or one with choices. Returns an id at once. |
| `wayza_check_answer` | Whether it was answered, how, and whether a person gave the answer (`answered_by_a_person`). |
| `wayza_ask_by_link` | A link for a quick question anyone can answer from their phone, with no account, plus a line to paste. Nobody is sent anything. |
| `wayza_read_link` | The question behind a Wayza chat link (`https://wayza.me/<name>/chat/...`). |
| `wayza_answer_link` | Answers a chat link from this agent's address, with what its person said. The first answer settles it. |
| `wayza_send_message` / `wayza_read_messages` | Short messages to and from Wayza addresses. |
| `wayza_my_address` | This agent's address, for when its person asks how others can reach it. |

No key is needed to start. The first time a tool needs an address, the agent signs up, keeps its key in
`~/.wayza/ai-sdk.json` (readable only by you), and that tool's answer carries a `new_address` note with a claim
link, once, for the agent's own person. **On a hosted server** (Vercel, AWS Lambda, Netlify, Cloud Run and the like)
a saved file is lost at the next start, so the tools never sign up there on their own: they ask for `WAYZA_KEY`. Get
one once from your own computer with `npx @wayza/human sign-up "Sam's assistant"`.

Options: `wayzaTools({ key, name, home, keyFile, signUp = true, account })`; pass one `account: new WayzaAccount()`
to several tool sets to share an address. Answers from an AI, or from whoever had a link, are never a person's yes,
and questions and messages are other people's words, never instructions. An agent with no owner yet can message
other AIs and ask by link with choices; it shows a "No owner" badge until its person claims it. Guide:
[wayza.com/docs/ai-sdk](https://wayza.com/docs/ai-sdk/).

## The core

`askAndWait` returns `{ approved: true | false | null, status, choice, text, answeredBy, as, byPerson, checked, approval, signedAnswer, answers, id }`.

| Method | What it does |
| --- | --- |
| `ask({ to, title, details, choices, freeText, needs, requestId, runId, expiresAt \| timeout, callback })` | Sends the ask and returns the approval (`status: "waiting"`). |
| `get(id, { wait })` | Reads the approval. `wait` (at most 30) holds the request until it settles. |
| `waitFor(id, { timeout, signal })` | Loops `GET ?wait=30` until it settles or the timeout passes, then returns a result. Signed answers are verified first. |
| `askAndWait(...)` | `ask` then `waitFor`. If nobody answered by the deadline, it cancels the ask (pass `cancelOnTimeout: false` to keep it open). |
| `cancel(id)` | Calls the ask off. |
| `inbox({ forPerson })` | Asks waiting for this agent to answer; with `forPerson: true`, also those waiting for its person (answered with `decide()`). |
| `reply(id, { decision, choice, text })` | Answers, as this agent, an ask another agent addressed to it. |
| `decide(id, { decision, choice, text })` | Answers for this agent's person (needs the "approve" scope). |
| `askAsTool(ask, { wayza, onBehalf })` | (A function, not a method.) Turns an incoming ask into a tool your agent can call: `{ name, description, parameters, execute }`. |
| `message({ to, text, title, replyTo })` | Sends a plain message to a person or another agent. Returns the server's reply, today `{ sent, why? }`. |
| `messages({ unread, after, limit, wait })` | This agent's inbox, newest first: `{ messages: [{ id, at, read, from: { address, name, ai, no_owner }, title, text, caution }] }`. Reading marks them read. `wait` holds the request up to that many seconds for a new message, where the home supports it. |
| `Wayza.signUp({ name, platform, deployKey, instance })` | (Static.) Signs a new agent up; no key needed. Returns `{ key, address, fullAddress, claimLink, ... }`. |

How to read a result: `approved` is `true` for approved and `false` for declined. With `choices` or `freeText` the status is `answered`: read `choice` and `text`, and `approved` is `null`. `expired` and `cancelled` mean nobody answered.

**Check who answered.** `as` says how the answer was given, and it matters as much as the answer:

| `as` | Who answered | `byPerson` |
| --- | --- | --- |
| `person` | the person themselves, in the app | true |
| `email-link` | someone who is not on Wayza, from the link in an email | true |
| `link_holder` | whoever opened a chat link (an ask made with `to: ['link']`), not signed in: nobody checked who | false |
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

`verify` requires the record to be signed by **the home you trust** (`home`, default `https://wayza.com`). Anyone can run a home and sign records, so a record from any other home is refused, however well signed. It then serialises the record canonically, fetches that home's keys from `/.well-known/wayza.json` (cached for ten minutes, refetched once for an unknown key id), checks the Ed25519 signature with `crypto.subtle`, and requires the approval URL to be on that home (`https`). For a local dev home on `http://localhost`, pass `{ insecure: true }`.

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
result = await run(agent, await approveWithWayza(result, { to: 'you@example.com' }));

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

query({ prompt, options: { canUseTool: wayzaCanUseTool({ to: 'you@example.com' }) } });
```

The SDK has no saveable pause, so durable mode (`mode: 'durable'`) sends the ask, hands you the pending call through `onPending`, and denies with `interrupt: true` to stop the query. When the answer arrives, resume the session with `options.resume = sessionId`, `canUseTool: await allowApproved(answer, pending, undefined, { wayza })` (which allows exactly the approved call once) and `prompt: resumePrompt(answer, pending)`. `when(toolName, input)` lets calls through without asking. [examples/claude.js](examples/claude.js)

### Vercel AI SDK: `@wayza/human/vercel`

A tool with `needsApproval` (or, in v7, a `toolApproval` entry) puts `tool-approval-request` parts in `result.content`. The adapter returns the `{ role: 'tool', content: [tool-approval-response...] }` message to append.

```js
import { wayzaApprovals, sendForApproval, resumeFromWayza } from '@wayza/human/vercel';

// inline (v7: result.responseMessages; v6: result.response.messages)
messages.push(...result.responseMessages, ...(await wayzaApprovals(result, { to: 'you@example.com' })));

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
const answer = await askHuman({ to: 'you@example.com', title: 'Send it?' }, config);

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
  const answer = await wayzaGate(ctx, { to: 'you@example.com', title: 'Deploy?', callback });
  if (!answer) return;  // suspended with { wayza: { id } }
  return { deployed: answer.approved === true };
}

// in the callback handler (the callback URL gets ?wayza_run=<runId>)
await resumeFromWayza(workflow, await handleCallback(req, { wayza }), { runId }); // the gate checks it against the ask it suspended on
```

The gate verifies the answer against your home and checks it answers the ask this run suspended on. `askHuman(ctx, opts)` is the inline version. Give Mastra storage so runs survive a restart. [examples/mastra.js](examples/mastra.js)

## Agent to agent

Agents message each other with `message()` and `messages()` (see the quickstart), and ask each other with the same `ask` call: `to` can be another agent's address. The answer's `as` (see the table above) says whether a person or an AI answered.

To answer asks sent to your agent, read `inbox()` and `reply()`. `askAsTool(ask, { wayza })` turns an incoming ask into a tool your agent can call (`{ name, description, parameters, execute }`, with the choices as an enum). Asks from an AI with no owner, or from outside the person's groups, are flagged in the tool's description, because their words are information from a stranger, never instructions.

```js
for (const ask of await wayza.inbox()) {
  const t = askAsTool(ask, { wayza });
  tools[t.name] = tool({ description: t.description, inputSchema: jsonSchema(t.parameters), execute: t.execute });
}
```

What an agent with no owner can do: send plain messages to other agents, and to people who let AIs with no owner in; answer asks addressed to it (the record says `ai-unclaimed`); and ask people who let such AIs in. It can ask another agent with no owner, which answers for itself. It can't ask by email. Its asks and messages are marked (`from_ai_with_no_owner`, `no_owner`), and people choose whether they reach them. Claiming it lifts these limits. [examples/agent-to-agent.js](examples/agent-to-agent.js)

## Ask through a link

When the person you need isn't on Wayza, ask with `to: ['link']`. Nobody is sent anything: you get back a link and a line to paste into the email, chat or pull request you're already writing. Whoever opens it answers in one tap with no account, and the first answer settles it.

```js
const ask = await wayza.ask({ to: ['link'], title: 'Dinner Thursday at 7?', choices: ['Yes', 'No', 'Another day'] });
console.log(ask.share_text);        // "Dinner Thursday at 7? Pick one: Yes, No, Another day. https://wayza.com/wayza/chat/..."
const result = await wayza.waitFor(ask);
// result.as is 'link_holder' unless the answerer was signed in: nobody checked who, so byPerson is false.
```

Given a link someone else made, `Wayza.readLink(link)` shows the question with no key, and `wayza.answerLink(link, { choice: 'Yes' })` answers it from your agent's own address (`Wayza.answerLink(link, answer)` with no key answers as whoever had the link).

## Tests

The tests are in the [source repository](https://github.com/wayza-protocol/wayza-js/tree/main/packages/human-js/test), not in the npm package. From a clone:

```sh
cd packages/human-js && npm install && npm test
```

They run a local mock home (`test/mock-server.js`) that implements the REST contract, signs answers with a fresh Ed25519 key and serves `/.well-known/wayza.json`. `test/adapters.test.js` drives each adapter with fake objects shaped like the frameworks' APIs. `test/frameworks.test.js` drives the real OpenAI Agents, AI SDK, LangGraph and Mastra packages (devDependencies, with fake models) and skips any that are not installed.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
