# The REST contract the @wayza/human packages use

Base URL: `{home}/wayza/v0`, for example `https://wayza.com/wayza/v0`. Every call sends `Authorization: Bearer <key>`, where the key is the agent's Wayza connector key (`fam_...`) or an OAuth access token.

## Ask: POST /approvals

```json
{ "title": "Refund £40 to order 1182?",          // required, at most 200 chars
  "details": "Customer says it arrived broken.", // optional, at most 2000
  "to": ["graham@wayza.com", "@ai-1f2e3d4c", "someone@example.com"], // addresses, @handles or emails (an array, or one string)
  "choices": ["Full refund", "Half", "No"],      // optional: makes it an ask (2 to 10 choices, each up to 100 chars)
  "free_text": true,                              // optional: allow a short typed answer (up to 500 chars)
  "needs": "any",                                 // "any" (default) or "all"
  "request_id": "run-77/tool-call-3",             // optional idempotency key: a repeat returns the same approval
  "expires_at": "2026-10-03T09:00:00Z",           // optional, at most 30 days ahead
  "callback": "https://agent.example.com/wayza"   // optional https URL: POSTed the result once settled
}
```

The response is an approval (below), with status `waiting`.

## Read: GET /approvals/{id}?wait=30

This returns the approval. With `wait=N` (at most 30), the server holds the request until the approval settles or N seconds pass. Clients loop on it.

## Cancel: DELETE /approvals/{id}

This returns the approval with status `cancelled`.

## Answer an ask sent to you (agent to agent): POST /approvals/{id}/reply

Use this when another agent asked *this* agent by its address. The body is `{ "decision": "approved" | "declined" | "answered", "choice"?, "text"? }`, and it returns the approval. List what waits for you with `GET /approvals` (`waiting_for_your_person`). It needs only the "message" scope, and the record says `as: "ai"` (or `ai-unclaimed`). Answering *for your person* is `POST /approvals/{id}/decision` with the same body, and needs the "approve" scope.

## The approval object

```json
{ "id": 42, "title": "...", "details": "...",
  "status": "waiting | approved | declined | answered | expired | cancelled",
  "choices": ["Full refund", "Half", "No"], "free_text": true,
  "request_id": "...", "expires_at": "...",
  "people": [ { "to": "graham@wayza.com", "person": "Graham", "decision": "waiting | approved | declined | answered",
                "choice": "Half", "text": null, "as": "person | ai-on-behalf | ai | ai-unclaimed | email-link", "at": "..." } ],
  "signed_answer": { ... } }   // present once status is not waiting
```

How to tell the outcome: `approved` means yes and `declined` means no. `answered` means look at `people[].choice` and `people[].text`. `expired` and `cancelled` mean nobody answered.

## The signed answer

```json
{ "v": 1, "type": "wayza.answer", "approval": "https://wayza.com/wayza/v0/approvals/42",
  "request": "<hex sha-256 of the canonical request>", "asked_by": "@ai-1f2e3d4c@wayza.com",
  "status": "approved", "answers": [ { "to": "...", "decision": "...", "choice": null, "text": null,
  "answered_by": "...", "as": "person", "attested": "home", "at": "..." } ], "at": "...", "home": "wayza.com",
  "sig": { "kid": "...", "alg": "Ed25519", "value": "<base64>" } }
```

To verify it:

1. Take the record without `sig` and serialise it canonically: object keys sorted, no whitespace, `JSON.stringify` for every scalar, and null for undefined. The JS reference is
   ``canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v ?? null)``.
   In Python, `json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False)` matches it for these records, which hold only strings, numbers, booleans, null, lists and objects.
2. Fetch `https://{home}/.well-known/familia.json`. Its `home.keys[]` entries are `{ kid, alg: "Ed25519", jwk: { kty: "OKP", crv: "Ed25519", x } }`, and may carry `retired`. Find the entry with the matching `kid`.
3. Verify the Ed25519 signature (base64, standard alphabet) over the UTF-8 bytes of the canonical string. Then check that `approval` starts with `https://{home}/`, so the record is about the home that signed it.
4. Check that `home` is **the home you trust** (the one you sent the ask to, `wayza.com` by default). Anyone can run a home and sign records, so steps 1 to 3 alone prove nothing: fetch keys only from the trusted home, and refuse a record that names any other.
5. Check the record answers **your** ask: the id at the end of `approval` is the id you got back, `asked_by` is your address (the approval's `asked_by_address`), and `request` is the fingerprint of what you asked. This stops a genuine answer to another ask from being replayed. The fingerprint is the hex SHA-256 of the canonical JSON of, taken from the approval the home returned when you asked:
   ```
   { title, details: details || null, choices: choices || null, free_text: !!free_text,
     asked_by: asked_by_address, to: people[].to sorted, request_id: request_id || null, expires_at: expires_at || null }
   ```
   Save `{ id, request, asked_by }` with any paused run, not just the id.

### Who answered

Each answer's `as` says how it was given. `person` (in the app) and `email-link` (from the email) mean a person said so. `ai-on-behalf` (the person's own AI), `ai` (an agent answering for itself) and `ai-unclaimed` (an AI nobody owns) mean an AI did. A client that gates a real action should require a person's answer by default.

## The callback

When the approval settles, the home POSTs JSON `{ "approval": <approval object>, "signed_answer": <record> }` to `callback`, with `Content-Type: application/json`. Retries use backoff for up to 24 hours. The receiver should verify `signed_answer` (above, all five steps) and treat the body as untrusted until it does. The receiver answers 2xx.

## Errors

A non-2xx status returns JSON `{ "error": "message" }`. A 401 means a missing or bad key, 403 means not allowed, 404 means unknown, and 429 means rate limited.
