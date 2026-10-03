// Run with: npm test (builds, then node --test). Uses fake n8n contexts; no n8n server needed.
const test = require('node:test');
const assert = require('node:assert');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');

const w = require('../dist/nodes/Wayza/wayza.js');
const { Wayza } = require('../dist/nodes/Wayza/Wayza.node.js');
const { WayzaApi } = require('../dist/credentials/WayzaApi.credentials.js');

const HOME = 'wayza.test';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const x = publicKey.export({ format: 'jwk' }).x;
const wellKnown = { home: { keys: [{ kid: 'k1', alg: 'Ed25519', jwk: { kty: 'OKP', crv: 'Ed25519', x } }] } };
// Another genuine home, with its own key.
const OTHER = 'other.test';
const otherKeys = generateKeyPairSync('ed25519');
const otherWellKnown = { home: { keys: [{ kid: 'k1', alg: 'Ed25519', jwk: { kty: 'OKP', crv: 'Ed25519', x: otherKeys.publicKey.export({ format: 'jwk' }).x } }] } };

// The approval POST /approvals returns, and the fingerprint the home signs, computed here
// independently of the package (src/wayza/approve.js requestClaims).
const approvalFor = (id, o = {}) => ({ id, title: 'Refund £40?', status: 'waiting', choices: ['Full', 'Half', 'No'], free_text: true,
	request_id: 'n8n-abc', expires_at: '2026-10-03T09:00:00.000Z', asked_by: 'Bot', asked_by_address: '@ai-bot@wayza.test',
	people: [{ to: 'graham@wayza.test', decision: 'waiting' }], ...o });
function fingerprint(ap) {
	const c = { title: ap.title, details: ap.details || null, choices: ap.choices || null, free_text: !!ap.free_text,
		asked_by: ap.asked_by_address, to: ap.people.map((p) => p.to).sort(), request_id: ap.request_id || null, expires_at: ap.expires_at || null };
	const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object'
		? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v ?? null);
	return createHash('sha256').update(canon(c), 'utf8').digest('hex');
}

function signed(status, answers, id = 42, home = HOME, { approval = approvalFor(id), key = privateKey } = {}) {
	const rec = { v: 1, type: 'wayza.answer', approval: `https://${home}/wayza/v0/approvals/${id}`, request: fingerprint(approval),
		asked_by: approval.asked_by_address, status, answers, at: '2026-10-02T10:00:00Z', home };
	const value = sign(null, Buffer.from(w.canonical(rec), 'utf8'), key).toString('base64');
	return { ...rec, sig: { kid: 'k1', alg: 'Ed25519', value } };
}
const answer = (o) => ({ to: 'graham@wayza.test', decision: 'approved', choice: null, text: null,
	answered_by: 'graham@wayza.test', as: 'person', attested: 'home', at: '2026-10-02T10:00:00Z', ...o });
const fetchJson = async (url) => { assert.strictEqual(url, `https://${HOME}/.well-known/familia.json`); return wellKnown; };

test('canonical matches the contract reference', () => {
	assert.strictEqual(w.canonical({ b: [1, null, 'é'], a: { d: undefined, c: true } }), '{"a":{"c":true,"d":null},"b":[1,null,"é"]}');
});

test('verify accepts a genuine record and rejects edits, other homes and http', async () => {
	const rec = signed('approved', [answer()]);
	assert.ok(await w.verifySignedAnswer(rec, { home: `https://${HOME}`, fetchJson }));
	await assert.rejects(w.verifySignedAnswer({ ...rec, status: 'declined' }, { home: HOME, fetchJson }), /does not verify/);
	await assert.rejects(w.verifySignedAnswer(rec, { home: 'https://wayza.com', fetchJson }), /expected/);
	await assert.rejects(w.verifySignedAnswer({ ...rec, home: 'evil.example' }, { home: null, fetchJson }), /not on the home/);
	await assert.rejects(w.verifySignedAnswer({ ...rec, sig: { ...rec.sig, kid: 'nope' } }, { home: HOME, fetchJson }), /Unknown signing key/);
	const http = { ...rec, approval: rec.approval.replace('https', 'http') };
	await assert.rejects(w.verifySignedAnswer(http, { home: HOME, fetchJson }), /https/);
});

test('parseCallback builds the result, and expired records keep waiting answers', async () => {
	const rec = signed('answered', [answer({ decision: 'answered', choice: 'Half', text: 'keep the box' })]);
	const r = await w.parseCallback({ approval: { id: 42, status: 'answered' }, signed_answer: rec }, { home: HOME, fetchJson });
	assert.deepStrictEqual([r.approved, r.status, r.choice, r.text, r.as, r.verified, r.by_person], [false, 'answered', 'Half', 'keep the box', 'person', true, true]);
	await assert.rejects(w.parseCallback({ approval: { id: 43 }, signed_answer: rec }, { home: HOME, fetchJson }), /does not match/);
	const ex = await w.parseCallback({ approval: { id: 42 }, signed_answer: signed('expired', [answer({ decision: 'waiting', as: null, answered_by: null })]) }, { home: HOME, fetchJson });
	assert.deepStrictEqual([ex.status, ex.approved, ex.answered_by], ['expired', false, null]);
});

test('requestFingerprint and checkAnswer tie an answer to the ask that was sent', () => {
	const ap = approvalFor(42, { people: [{ to: 'b@x' }, { to: 'a@x' }] });
	assert.strictEqual(w.requestFingerprint(ap), fingerprint(ap));
	assert.match(w.requestFingerprint(ap), /^[0-9a-f]{64}$/);
	const rec = signed('approved', [answer()], 42, HOME, { approval: ap });
	assert.ok(w.checkAnswer(rec, ap));
	assert.ok(w.checkAnswer(rec, { id: '42', request: fingerprint(ap), asked_by: '@ai-bot@wayza.test' }));
	assert.throws(() => w.checkAnswer(rec, approvalFor(43, { people: ap.people })), /approval 42, not 43/);
	assert.throws(() => w.checkAnswer(rec, { ...ap, title: 'Refund £400?' }), /different request/);
	assert.throws(() => w.checkAnswer(rec, { ...ap, asked_by_address: '@ai-other@wayza.test' }), /someone else/);
	assert.throws(() => w.checkAnswer(rec, { id: 42, request: fingerprint(ap) }), /missing/);
	assert.throws(() => w.checkAnswer(null, ap), /No signed answer/);
});

test('requirePerson turns an AI approval into a refusal with a reason', () => {
	const ai = w.resultFrom({ id: 1 }, signed('approved', [answer({ as: 'ai-on-behalf' })], 1));
	assert.strictEqual(ai.approved, true);
	const r = w.requirePerson(ai);
	assert.deepStrictEqual([r.approved, r.status, r.as], [false, 'approved', 'ai-on-behalf']);
	assert.match(r.reason, /person's answer is required.*ai-on-behalf/);
	const human = w.resultFrom({ id: 1 }, signed('approved', [answer({ as: 'email-link' })], 1));
	assert.strictEqual(w.requirePerson(human).approved, true);
	const declined = w.resultFrom({ id: 1 }, signed('declined', [answer({ decision: 'declined', as: 'ai' })], 1));
	assert.strictEqual(w.requirePerson(declined).reason, null);
});

test('askBody: stable request ids, lists and limits', () => {
	const a = w.askBody({ title: 'Ship it?', to: 'a@b.c, @ai-x' }, 'exec-1');
	const b = w.askBody({ title: 'Ship it?', to: 'a@b.c,@ai-x' }, 'exec-1');
	const c = w.askBody({ title: 'Ship it?', to: 'a@b.c,@ai-x' }, 'exec-2');
	assert.deepStrictEqual(a.to, ['a@b.c', '@ai-x']);
	assert.strictEqual(a.request_id, b.request_id);
	assert.notStrictEqual(a.request_id, c.request_id);
	assert.throws(() => w.askBody({ title: 'x', to: 'a', choices: ['one'] }, 's'), /2 to 10/);
	assert.throws(() => w.askBody({ title: '', to: 'a' }, 's'), /Title/);
});

function execContext(params, { signedResume = true, staticData = {} } = {}) {
	const calls = { http: [], waitTill: null, staticData };
	const ctx = {
		getWorkflowStaticData: (type) => { assert.strictEqual(type, 'node'); return staticData; },
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		getCredentials: async () => ({ apiKey: 'fam_x', home: `https://${HOME}/` }),
		getInputData: () => [{ json: { order: 1182 } }, { json: { order: 1183 } }],
		getExecutionId: () => 'exec-9',
		getNode: () => ({ id: 'node-1', name: 'Ask a person' }),
		continueOnFail: () => false,
		evaluateExpression: (e) => { assert.match(e, /\$execution\.resumeUrl/); return 'https://n8n.example/webhook-waiting/exec-9'; },
		putExecutionToWait: async (d) => { calls.waitTill = d; },
		helpers: {
			httpRequestWithAuthentication: async function (cred, opts) {
				assert.strictEqual(cred, 'wayzaApi');
				calls.http.push(opts);
				return approvalFor(7);
			},
		},
	};
	if (signedResume) ctx.getSignedResumeUrl = () => 'https://n8n.example/webhook-waiting/exec-9/node-1?signature=abc';
	return { ctx, calls };
}

const baseParams = { title: 'Refund £40?', to: 'graham@wayza.test', details: '', answerType: 'choices', choices: 'Full, Half, No', allowText: true, needs: 'any' };

test('Ask and wait: sends the ask with the resume URL as callback and pauses', async () => {
	const { ctx, calls } = execContext({ ...baseParams, mode: 'sendAndWait', options: { limitWaitTime: { values: { amount: 2, unit: 'hours' } } } });
	const out = await new Wayza().execute.call(ctx);
	assert.strictEqual(calls.http.length, 1);
	const req = calls.http[0];
	assert.strictEqual(req.url, `https://${HOME}/wayza/v0/approvals`);
	assert.strictEqual(req.method, 'POST');
	assert.strictEqual(req.body.callback, 'https://n8n.example/webhook-waiting/exec-9/node-1?signature=abc');
	assert.deepStrictEqual(req.body.choices, ['Full', 'Half', 'No']);
	assert.strictEqual(req.body.free_text, true);
	assert.match(req.body.expires_at, /Z$/);
	const wait = calls.waitTill.getTime() - Date.now();
	assert.ok(wait > 2 * 3600e3 && wait < 2 * 3600e3 + 120e3);
	assert.deepStrictEqual(out, [ctx.getInputData()]);
	// The ask is kept with the waiting execution: id, request fingerprint and asker.
	const kept = calls.staticData['wayza:exec-9'];
	assert.deepStrictEqual([kept.id, kept.request, kept.asked_by], [7, fingerprint(approvalFor(7)), '@ai-bot@wayza.test']);
});

test('Ask and wait falls back to $execution.resumeUrl on older n8n', async () => {
	const { ctx, calls } = execContext({ ...baseParams, mode: 'sendAndWait', options: {} }, { signedResume: false });
	await new Wayza().execute.call(ctx);
	assert.strictEqual(calls.http[0].body.callback, 'https://n8n.example/webhook-waiting/exec-9/node-1');
	assert.strictEqual(calls.waitTill.getTime(), require('n8n-workflow').WAIT_INDEFINITELY.getTime(), 'waits indefinitely without a limit');
});

test('Ask and wait uses the resume token URL when $execution.resumeUrl carries one (n8n 2.x)', async () => {
	const { ctx, calls } = execContext({ ...baseParams, mode: 'sendAndWait', options: {} });
	ctx.evaluateExpression = () => 'https://n8n.example/webhook-waiting/exec-9?signature=tok123';
	await new Wayza().execute.call(ctx);
	assert.strictEqual(calls.http[0].body.callback, 'https://n8n.example/webhook-waiting/exec-9/node-1?signature=tok123');
});

test('Send and continue returns the approval for every item', async () => {
	const { ctx, calls } = execContext({ ...baseParams, mode: 'send', answerType: 'approval', options: {} });
	const [items] = await new Wayza().execute.call(ctx);
	assert.strictEqual(items.length, 2);
	assert.deepStrictEqual([items[0].json.id, items[0].json.status, items[0].json.approved], [7, 'waiting', false]);
	assert.strictEqual(calls.http[0].body.callback, undefined);
	assert.strictEqual(calls.waitTill, null);
});

const keptFor = (ap) => ({ 'wayza:exec-9': { id: ap.id, request: fingerprint(ap), asked_by: ap.asked_by_address, at: Date.now() } });

function hookContext(body, options = {}, { staticData = keptFor(approvalFor(7)), params = {} } = {}) {
	const sent = {};
	return {
		sent,
		staticData,
		ctx: {
			getBodyData: () => body,
			getNodeParameter: (name, fallback) => (name === 'options' ? options : name in params ? params[name] : fallback),
			getCredentials: async () => ({ apiKey: 'fam_x', home: `https://${HOME}` }),
			getExecutionId: () => 'exec-9',
			getWorkflowStaticData: (type) => { assert.strictEqual(type, 'node'); return staticData; },
			getResponseObject: () => ({ status(c) { sent.code = c; return this; }, json(b) { sent.body = b; return this; } }),
			helpers: {
				httpRequest: async ({ url }) => {
					if (url === `https://${OTHER}/.well-known/familia.json`) return otherWellKnown;
					return fetchJson(url);
				},
			},
		},
	};
}

async function refused(h) {
	const r = await new Wayza().webhook.call(h.ctx);
	assert.deepStrictEqual(r, { noWebhookResponse: true });
	assert.strictEqual(h.sent.code, 401);
	return h.sent.body.error;
}

test('webhook resumes with a verified answer and refuses forgeries', async () => {
	const rec = signed('approved', [answer()], 7);
	const good = hookContext({ approval: { id: 7, status: 'approved' }, signed_answer: rec });
	const r = await new Wayza().webhook.call(good.ctx);
	const json = r.workflowData[0][0].json;
	assert.deepStrictEqual([json.approved, json.status, json.as, json.verified, json.answered_by], [true, 'approved', 'person', true, 'graham@wayza.test']);
	assert.deepStrictEqual(good.staticData, {}, 'the kept ask is cleared once answered');
	await refused(hookContext({ approval: { id: 7 }, signed_answer: { ...rec, status: 'declined' } }));
});

test('webhook pins the credential home: a record genuinely signed by another home is refused', async () => {
	const rec = signed('approved', [answer()], 7, OTHER, { key: otherKeys.privateKey });
	// Genuine: it verifies against its own home.
	assert.ok(await w.verifySignedAnswer(rec, { home: OTHER, fetchJson: async () => otherWellKnown }));
	const err = await refused(hookContext({ approval: { id: 7 }, signed_answer: rec }));
	assert.match(err, /expected wayza\.test/);
});

test('webhook refuses a replayed answer: another approval, another request, or no ask waiting', async () => {
	// Genuinely signed, but for approval 8.
	const other = signed('approved', [answer()], 8);
	assert.match(await refused(hookContext({ approval: { id: 8 }, signed_answer: other })), /approval 8, not 7/);
	// Genuinely signed for approval 7, but for a different request than this execution sent.
	const reworded = signed('approved', [answer()], 7, HOME, { approval: approvalFor(7, { title: 'Refund £400?' }) });
	assert.match(await refused(hookContext({ approval: { id: 7 }, signed_answer: reworded })), /different request/);
	// Asked by another agent.
	const otherAsker = signed('approved', [answer()], 7, HOME, { approval: approvalFor(7, { asked_by_address: '@ai-x@wayza.test' }) });
	assert.match(await refused(hookContext({ approval: { id: 7 }, signed_answer: otherAsker })), /someone else/);
	// Nothing kept for this execution.
	const rec = signed('approved', [answer()], 7);
	assert.match(await refused(hookContext({ approval: { id: 7 }, signed_answer: rec }, {}, { staticData: {} })), /No ask/);
	// An old workflow saved with "Verify Signature" off still verifies: the option is gone.
	assert.match(await refused(hookContext({ approval: { id: 7 }, signed_answer: { ...rec, status: 'declined' } }, { verifySignature: false })), /[Ss]ignature/);
});

test('the ask is also kept in execution custom data, and the webhook finds it there when static data is gone (n8n 2.x)', async () => {
	const store = {};
	const customData = { set: (k, v) => { assert.match(k, /^[A-Za-z0-9_]{1,50}$/); assert.strictEqual(typeof v, 'string'); store[k] = v; }, get: (k) => store[k] };
	const { ctx } = execContext({ ...baseParams, mode: 'sendAndWait', options: {} });
	ctx.customData = customData;
	await new Wayza().execute.call(ctx);
	assert.strictEqual(Object.keys(store).length, 1);
	const rec = signed('approved', [answer()], 7);
	const h = hookContext({ approval: { id: 7 }, signed_answer: rec }, {}, { staticData: {} });
	Object.assign(h.ctx, { customData, getNode: () => ({ id: 'node-1', name: 'Ask a person' }) });
	const r = await new Wayza().webhook.call(h.ctx);
	assert.strictEqual(r.workflowData[0][0].json.approved, true);
	// The kept ask still pins the answer: a genuine answer to approval 8 is refused.
	const h8 = hookContext({ approval: { id: 8 }, signed_answer: signed('approved', [answer()], 8) }, {}, { staticData: {} });
	Object.assign(h8.ctx, { customData, getNode: () => ({ id: 'node-1', name: 'Ask a person' }) });
	assert.match(await refused(h8), /approval 8, not 7/);
});

test('if n8n drops the custom data (past its key limit), the ask stops at once instead of waiting for an answer it could never check', async () => {
	const { ctx } = execContext({ ...baseParams, mode: 'sendAndWait', options: {} });
	ctx.customData = { set: () => {}, get: () => undefined };
	await assert.rejects(new Wayza().execute.call(ctx), /too many custom data keys/);
});

test('webhook requires a person by default', async () => {
	const rec = signed('approved', [answer({ as: 'ai-unclaimed', answered_by: '@ai-helper@wayza.test' })], 7);
	const strict = await new Wayza().webhook.call(hookContext({ approval: { id: 7 }, signed_answer: rec }).ctx);
	const j = strict.workflowData[0][0].json;
	assert.deepStrictEqual([j.approved, j.status, j.as, j.by_person], [false, 'approved', 'ai-unclaimed', false]);
	assert.match(j.reason, /person's answer is required/);
	const loose = await new Wayza().webhook.call(hookContext({ approval: { id: 7 }, signed_answer: rec }, {}, { params: { requirePerson: false } }).ctx);
	assert.strictEqual(loose.workflowData[0][0].json.approved, true);
});

test('credentials send a bearer token and test GET /approvals', () => {
	const c = new WayzaApi();
	assert.strictEqual(c.name, 'wayzaApi');
	assert.strictEqual(c.authenticate.properties.headers.Authorization, '=Bearer {{$credentials.apiKey}}');
	assert.strictEqual(c.test.request.url, '/approvals');
});

test('the node reports its own version as User-Agent', () => {
	const { VERSION } = require('../dist/nodes/Wayza/Wayza.node.js');
	assert.strictEqual(VERSION, require('../package.json').version);
});

test("a refused ask shows Wayza's own reason, not just n8n's status text", async () => {
	for (const response of [{ status: 400, data: { error: '@ai-b is an AI with no owner too.' } }, { status: 400, body: '{"error":"@ai-b is an AI with no owner too."}' }]) {
		const { ctx } = execContext({ ...baseParams, mode: 'send', options: {} });
		ctx.helpers.httpRequestWithAuthentication = async () => { const e = new Error('Request failed with status code 400'); e.response = response; throw e; };
		await assert.rejects(new Wayza().execute.call(ctx), /no owner too/);
	}
});
