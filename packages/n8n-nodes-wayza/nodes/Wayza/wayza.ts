// Wayza contract helpers (packages/CONTRACT.md): the ask body, the result shape and
// signature verification. Pure functions, no n8n imports, so they can be unit-tested.
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

/** The JS reference canonicaliser from CONTRACT.md. */
export const canonical = (v: unknown): string =>
	Array.isArray(v)
		? `[${v.map(canonical).join(',')}]`
		: v && typeof v === 'object'
			? `{${Object.keys(v as object)
					.sort()
					.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
					.join(',')}}`
			: JSON.stringify(v ?? null);

export interface AskInput {
	title: string;
	to: string;
	details?: string;
	choices?: string[];
	freeText?: boolean;
	needs?: 'any' | 'all';
	requestId?: string;
	expiresAt?: string;
	callback?: string;
}

export function splitList(s: string | undefined): string[] {
	return String(s ?? '')
		.split(/[,\n]/)
		.map((x) => x.trim())
		.filter(Boolean);
}

/** The POST /approvals body. The default request_id is a stable hash of the ask, so a retry doesn't ask twice. */
export function askBody(a: AskInput, scope: string): JsonObject {
	if (!a.title || a.title.length > 200) throw new Error('Title is required (at most 200 characters)');
	if (a.details && a.details.length > 2000) throw new Error('Details are at most 2000 characters');
	const to = splitList(a.to);
	if (!to.length) throw new Error('Add at least one person or agent in "To"');
	const body: JsonObject = { title: a.title, to: to.length === 1 ? to[0] : to };
	if (a.details) body.details = a.details;
	if (a.choices && a.choices.length) {
		if (a.choices.length < 2 || a.choices.length > 10) throw new Error('Choices need 2 to 10 options');
		body.choices = a.choices;
	}
	if (a.freeText) body.free_text = true;
	if (a.needs && a.needs !== 'any') body.needs = a.needs;
	if (a.callback) body.callback = a.callback;
	body.request_id =
		a.requestId ||
		'n8n-' +
			createHash('sha256')
				.update(canonical({ scope, ...body }))
				.digest('hex')
				.slice(0, 40);
	if (a.expiresAt) body.expires_at = a.expiresAt;
	return body;
}

export function expiresAtFrom(seconds: number): string {
	const capped = Math.min(seconds, 30 * 86400 - 60);
	return new Date(Date.now() + capped * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The node's output: the result fields of the Python/JS packages. */
export function resultFrom(approval: JsonObject, signed?: JsonObject | null, verified = false): JsonObject {
	const rec = (signed ?? (approval.signed_answer as JsonObject | undefined)) || null;
	const status = String((rec?.status as string) ?? approval.status ?? 'waiting');
	type Answer = { [k: string]: Json };
	const answers: Answer[] = rec
		? ((rec.answers as Answer[]) ?? []).map((a) => ({ ...a }))
		: ((approval.people as Answer[]) ?? []).map((p) => ({
				to: p.to ?? null,
				decision: p.decision ?? null,
				choice: p.choice ?? null,
				text: p.text ?? p.note ?? null,
				answered_by: p.person ?? p.to ?? null,
				as: p.as ?? null,
				at: p.at ?? null,
			}));
	const first: Answer = answers.find((a) => a.decision && a.decision !== 'waiting') ?? {};
	return {
		id: (approval.id as Json) ?? idFromUrl(rec?.approval as string | undefined),
		approved: status === 'approved',
		status,
		choice: first.choice ?? null,
		text: first.text ?? null,
		answered_by: first.answered_by ?? (first as Answer).person ?? first.to ?? null,
		as: first.as ?? null,
		by_person: first.as === 'person' || first.as === 'email-link',
		answers,
		approval,
		signed_answer: rec,
		verified,
		reason: null,
	};
}

function idFromUrl(url: string | undefined): Json {
	if (!url) return null;
	const tail = url.replace(/\/+$/, '').split('/').pop() ?? '';
	return /^\d+$/.test(tail) ? Number(tail) : tail;
}

export class VerifyError extends Error {}

export function homeNetloc(home: string): string {
	return home.includes('://') ? new URL(home).host : home.replace(/\/+$/, '');
}

/**
 * Verify a signed answer: Ed25519 over canonical(record without sig), with keys from
 * `{origin of record.approval}/.well-known/familia.json`. The approval URL must be on
 * `record.home`, which must be the trusted `home`. https only unless `insecure`.
 */
export async function verifySignedAnswer(
	record: JsonObject,
	opts: { home: string | null; insecure?: boolean; fetchJson: (url: string) => Promise<unknown> },
): Promise<JsonObject> {
	if (!record || typeof record !== 'object') throw new VerifyError('No signed answer');
	if (record.v !== 1 || record.type !== 'wayza.answer') throw new VerifyError('Not a v1 wayza.answer record');
	const sig = record.sig as JsonObject | undefined;
	if (!sig || sig.alg !== 'Ed25519' || !sig.kid || !sig.value) throw new VerifyError('Missing or unsupported signature');
	const approvalUrl = String(record.approval ?? '');
	const recordHome = String(record.home ?? '');
	if (!URL.canParse(approvalUrl)) throw new VerifyError('Record has no approval URL');
	const u = new URL(approvalUrl);
	if (u.protocol !== 'https:' && !(opts.insecure && u.protocol === 'http:'))
		throw new VerifyError('Approval URL must be https');
	if (u.host !== recordHome || !approvalUrl.startsWith(`${u.protocol}//${u.host}/`))
		throw new VerifyError('Approval URL is not on the home that signed it');
	if (opts.home !== null && homeNetloc(opts.home) !== recordHome)
		throw new VerifyError(`Signed by ${recordHome}, expected ${homeNetloc(opts.home)}`);

	const doc = (await opts.fetchJson(`${u.protocol}//${u.host}/.well-known/familia.json`)) as {
		home?: { keys?: Array<{ kid?: string; alg?: string; jwk?: { kty?: string; crv?: string; x?: string } }> };
	};
	const entry = (doc?.home?.keys ?? []).find((k) => k && k.kid === sig.kid);
	if (!entry) throw new VerifyError(`Unknown signing key ${String(sig.kid)}`);
	const jwk = entry.jwk ?? {};
	if ((entry.alg ?? 'Ed25519') !== 'Ed25519' || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.x)
		throw new VerifyError('Signing key is not Ed25519');
	const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
	const { sig: _omit, ...body } = record;
	void _omit;
	const ok = edVerify(null, Buffer.from(canonical(body), 'utf8'), key, Buffer.from(String(sig.value), 'base64'));
	if (!ok) throw new VerifyError('Signature does not verify');
	return record;
}

/** Verify a callback body `{approval, signed_answer}` and return the node output. */
export async function parseCallback(
	body: JsonObject,
	opts: { home: string | null; insecure?: boolean; fetchJson: (url: string) => Promise<unknown> },
): Promise<JsonObject> {
	const signed = body?.signed_answer as JsonObject | undefined;
	if (!signed) throw new VerifyError('Callback has no signed_answer');
	const rec = await verifySignedAnswer(signed, opts);
	const approval = (body.approval && typeof body.approval === 'object' ? body.approval : {}) as JsonObject;
	if (approval.id !== undefined && approval.id !== null) {
		const tail = String(rec.approval).replace(/\/+$/, '').split('/').pop();
		if (tail !== String(approval.id)) throw new VerifyError('Approval id does not match the signed record');
	}
	return resultFrom(approval, rec, true);
}

/**
 * The fingerprint of an ask, as the home signs it in the record's `request` field: the
 * lowercase hex sha-256 of the canonical JSON of the request claims of the approval that
 * POST /approvals returned.
 */
export function requestFingerprint(approval: JsonObject): string {
	const people = approval?.people as JsonObject[] | undefined;
	if (!approval || typeof approval.title !== 'string' || !approval.asked_by_address || !Array.isArray(people))
		throw new VerifyError('The approval is missing what its fingerprint needs (title, asked_by_address, people)');
	const claims = {
		title: approval.title,
		details: approval.details || null,
		choices: approval.choices || null,
		free_text: !!approval.free_text,
		asked_by: approval.asked_by_address,
		to: people.map((p) => String(p.to)).sort(),
		request_id: approval.request_id || null,
		expires_at: approval.expires_at || null,
	};
	return createHash('sha256').update(canonical(claims), 'utf8').digest('hex');
}

/** What to keep with a waiting execution: the ask's id, request fingerprint and asker. */
export interface SentAsk {
	id: Json;
	request: string;
	asked_by: string;
}

export function sentAsk(approval: JsonObject): SentAsk {
	if (approval?.id === undefined || approval.id === null) throw new VerifyError('The approval has no id');
	return { id: approval.id, request: requestFingerprint(approval), asked_by: String(approval.asked_by_address) };
}

/**
 * Throw VerifyError unless the signed answer is the answer to the ask that was sent: same
 * approval id, same asker, same request fingerprint. It doesn't check the signature.
 */
export function checkAnswer(signed: JsonObject | null | undefined, sent: SentAsk | JsonObject): JsonObject {
	if (!signed || typeof signed !== 'object') throw new VerifyError('No signed answer to check');
	const want = 'request' in sent ? (sent as SentAsk) : sentAsk(sent as JsonObject);
	if (want.id === undefined || want.id === null || !want.request || !want.asked_by)
		throw new VerifyError('The saved ask is missing its id, request or asked_by');
	const tail = String(signed.approval ?? '').replace(/\/+$/, '').split('/').pop();
	if (tail !== String(want.id)) throw new VerifyError(`The signed answer is for approval ${tail}, not ${String(want.id)}`);
	if (signed.asked_by !== want.asked_by) throw new VerifyError('The signed answer was asked by someone else');
	if (signed.request !== want.request) throw new VerifyError('The signed answer is for a different request than the one sent');
	return signed;
}

const HUMAN_AS = ['person', 'email-link'];
const AI_AS = ['ai', 'ai-on-behalf', 'ai-unclaimed'];

/** With "Require a Person": an approval an AI gave becomes approved=false, with the reason. */
export function requirePerson(result: JsonObject): JsonObject {
	if (!result.approved) return result;
	const decided = ((result.answers as JsonObject[]) ?? []).filter((a) => a.decision && a.decision !== 'waiting');
	const kinds = [result.as, ...decided.map((a) => a.as)];
	const bad = kinds.find((k) => !HUMAN_AS.includes(String(k)));
	if (bad === undefined) return result;
	const who = AI_AS.includes(String(bad)) ? `an AI (${String(bad)})` : `an answer with no person behind it (as=${String(bad)})`;
	return { ...result, approved: false, reason: `Not approved: a person's answer is required, but this one came from ${who}.` };
}
