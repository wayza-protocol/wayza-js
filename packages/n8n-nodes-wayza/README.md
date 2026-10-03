# n8n-nodes-wayza

An n8n community node, **Wayza: Ask a person**. It sends a question to a real person (or to
another agent) through [Wayza] and continues the workflow on their **signed** answer.

## What's in it

- **Credentials: Wayza API.** An API key (your agent's `fam_...` connector key or an OAuth
  token) and a home URL (default `https://wayza.com`). Requests send `Authorization: Bearer <key>`.
  The credential test calls `GET /wayza/v0/approvals`.
- **Node: Wayza: Ask a person**, with two modes:
  - **Ask and Wait for the Answer.** Sends the ask with `callback` set to this execution's
    resume webhook, then calls `putExecutionToWait` (the "wait for webhook" pattern that n8n's
    own *send and wait* nodes use). The workflow pauses until the person answers. The Wayza
    callback (`{approval, signed_answer}`) resumes it, and the node outputs the result.
  - **Send and Continue.** Sends one ask per item and returns the approval at once, with status
    `waiting`. You can set an optional callback URL.

Fields: Title, To (comma-separated addresses, @handles, emails or another agent's address),
Details, Answer Type (approve or decline / pick a choice / typed answer), Choices, Needs (any
or all), **Require a Person** (on by default, see below). Options: Limit Wait Time (also sets `expires_at`), Request ID, Callback URL (Send
and Continue), Allow HTTP Home (dev only). The signed answer is always verified; there is no switch to turn that off.

### Output

```json
{ "id": 42, "approved": true, "status": "approved", "choice": null, "text": null,
  "answered_by": "graham@wayza.com", "as": "person", "by_person": true,
  "answers": [...], "approval": {...}, "signed_answer": {...}, "verified": true, "reason": null }
```

`status` is one of `approved`, `declined`, `answered` (see `choice` / `text`), `expired` or
`cancelled`. Agents with no owner can use the node too.

**When nobody answers in time.** With Limit Wait Time, the ask expires on Wayza at that time and n8n
gives up a minute later. Usually Wayza's signed `expired` answer arrives first and the node outputs
`status: "expired"`, `approved: false`. If n8n's own timer fires first, n8n passes the input items on
unchanged, with no `status` at all. Downstream, treat a missing `status` as timed out.

Tested in a real n8n 2.35.7: approve, decline, Require a Person (an AI's yes is turned into no),
refused forgeries and replays, and Limit Wait Time. n8n needs a public `WEBHOOK_URL` (https) for
wayza.com to reach it.

### Who answered: `as`

Every answer says **how** it was given, in the signed record's `as`:

| `as` | Who gave the answer | Counts as a person? |
|---|---|---|
| `person` | The person themselves, signed in to Wayza | yes |
| `email-link` | The person, by the one-tap link in the email Wayza sent them | yes |
| `ai-on-behalf` | An AI answering *for* its person | no |
| `ai` | An AI answering for itself (agent to agent) | no |
| `ai-unclaimed` | An AI with no owner answering for itself | no |

Why it matters: "To" can be another agent, and an AI can be allowed to answer for its person.
A workflow that treats any approval as consent would let an AI (one that was talked into it,
or one nobody owns) approve a refund or a deletion. **Require a Person** is therefore on by
default: an approval whose `as` is `ai`, `ai-on-behalf` or `ai-unclaimed` is output with
`approved: false`, `status` still `"approved"` (what the record says), and a `reason`
explaining why. Turn it off only if an AI's approval really is enough, and then branch on
`as` or `by_person` yourself.

### Security

Before resuming, the node's webhook verifies `signed_answer` as `packages/CONTRACT.md`
describes, using `node:crypto` Ed25519 with no extra dependencies. It takes the canonical
JSON of the record without `sig`, fetches the keys from
`{origin of approval}/.well-known/familia.json`, and requires the approval URL to be on
`record.home`, which must be the credential's home. It requires https unless *Allow HTTP Home*
is on. A body that fails gets a 401 and the execution keeps waiting.

A genuine signature isn't enough on its own: a real answer to another ask could be replayed
at this webhook. When the node sends its ask, it keeps the approval's `id`, its `request`
fingerprint (sha-256 of the canonical ask the home signs) and `asked_by` in the execution's
custom data (n8n's workflow static data is only a fallback where there is no custom data). The webhook resumes only if the signed answer's approval id,
`asked_by` and `request` all match.
Anything else gets the same 401 as a forged body. The callback URL is this execution's resume URL (`$execution.resumeUrl`, which carries n8n's resume
token, plus `/<nodeId>`), so n8n itself refuses a call without the token.

The default request id is a hash of the ask, the execution id and the node id. Retries within
an execution don't ask twice.

## Install

In n8n: **Settings > Community Nodes > Install**, and enter `n8n-nodes-wayza`. Or, on a self-hosted
n8n, `npm install n8n-nodes-wayza` in `~/.n8n/nodes` and restart n8n.

## Requirements

- Your n8n must be reachable over **https** from the Wayza home: set `WEBHOOK_URL` to the public
  URL. The server only accepts https callback URLs.
- Self-hosted n8n with community nodes enabled.

## Build and test

```sh
cd packages/n8n-nodes-wayza
npm install          # dev deps: typescript, n8n-workflow, @types/node
npm run typecheck
npm test             # builds to dist/ and runs node --test with fake n8n contexts
```

To try it in a local n8n, run `npm run build`, then `npm link` and link it into
`~/.n8n/custom` (see n8n's "Run your node locally" docs).

[Wayza]: https://wayza.com

## Licence

MIT. See [LICENSE](LICENSE).
