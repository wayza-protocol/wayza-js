// Shared plumbing for the framework adapters. Not a public entry point.
import { Wayza, toResult, isSettled, canonical, checkAnswer, verify, PERSON } from './index.js';

const ASK_KEYS = ['to', 'details', 'choices', 'freeText', 'needs', 'expiresAt', 'timeout', 'callback'];

/** Use opts.wayza, or build a client from opts.key / opts.home / WAYZA_KEY. */
export function client(opts = {}) {
  return opts.wayza ?? new Wayza({ key: opts.key, home: opts.home, fetch: opts.fetch, insecure: opts.insecure });
}

/**
 * Adapters gate actions, so by default only a person's answer counts (`as` "person" or
 * "email-link"): a yes from an AI, even the person's own, is not enough unless
 * `requirePerson: false`.
 */
const needsPerson = (opts) => opts?.requirePerson !== false;
const notByPerson = (opts, result) => needsPerson(opts) && result.status !== 'waiting' && !result.byPerson;

/** Default decision: only an explicit "approved" from a person lets the action run. */
export const decide = (opts, result) => (opts.decide ? !!opts.decide(result) : result.approved === true && !notByPerson(opts, result));

/**
 * The result an adapter hands back: when a person is required and an AI answered,
 * it reads as not approved, with no choice or text, and says why.
 */
export function gated(opts, result) {
  if (!notByPerson(opts, result)) return result;
  return { ...result, approved: false, choice: null, text: null, refused: `Answered by an AI (${result.as}), and this needs a person` };
}

/** A short reason the agent sees when the person said no (or nobody answered). */
export function denial(result) {
  if (result.refused) return `${result.refused}.`;
  if (result.approved === true && !result.byPerson) return `Approved by an AI (${result.as}), but this needs a person.`;
  if (result.text) return result.text;
  const who = result.answeredBy ? ` by ${result.answeredBy}` : '';
  if (result.status === 'declined') return `Declined${who} via Wayza.`;
  if (result.status === 'answered') return `Answered${who} via Wayza: ${result.choice ?? 'no choice'}.`;
  return `Not approved via Wayza (${result.status}).`;
}

/** title/details may be strings or functions of the framework item. */
const pick = (v, item) => (typeof v === 'function' ? v(item) : v);

export const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const json = (v) => {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
};

/**
 * Build ask() options from adapter opts and a framework item.
 * `defaults` supplies the adapter's own title/details; `runId` feeds the stable requestId.
 */
export function askOptions(opts, item, defaults, runId) {
  const out = {};
  for (const k of ASK_KEYS) if (opts[k] !== undefined) out[k] = pick(opts[k], item);
  out.title = clip(String(pick(opts.title, item) ?? defaults.title), 200);
  const details = pick(opts.details, item) ?? defaults.details;
  if (details != null) out.details = clip(String(details), 2000);
  if (opts.requestId) out.requestId = pick(opts.requestId, item);
  else if (runId != null) out.runId = runId;
  if (!out.to) throw new TypeError('Wayza adapter needs `to` (who should answer)');
  return out;
}

/** Stable key for "this tool with this input". */
export const canonicalKey = (name, input) => canonical([name, input ?? null]);

/** JSON-safe form of a result, for resume payloads that frameworks persist. */
export function plain(result) {
  const { approval, ...rest } = result;
  return rest;
}

/**
 * Check a settled result against what was sent: signed by our home, for this approval,
 * asked by this agent, about this question. `p` is a pending entry ({ id, request, asked_by }).
 */
export async function checked(opts, p, r) {
  if (r.status === 'waiting') return r;
  if (!r.signedAnswer) throw new Error(`Wayza answer for approval ${p.id} has no signed record`);
  const w = opts.wayza, home = opts.home ?? w?.home ?? 'https://wayza.com';
  await verify(r.signedAnswer, { home, fetch: opts.fetch ?? w?.fetch, insecure: opts.insecure ?? w?.insecure ?? home.startsWith('http:') });
  await checkAnswer(r.signedAnswer, p);
  return { ...r, checked: true };
}

/**
 * For durable mode: given the pending asks (each { id, request, asked_by }, as saved from
 * sentOf()), find each one's answer, from callback results in `answers` or by reading the
 * approval. Every answer is verified against our home and checked against its ask.
 * Returns { ready, results: Map<id, result>, waiting: pending[] }.
 */
export async function collect(pending, opts = {}) {
  const given = new Map([opts.answers ?? []].flat().filter(Boolean).map((a) => [String(a.id), a]));
  const results = new Map();
  const waiting = [];
  for (const p of pending) {
    let r = given.get(String(p.id));
    if (!r) {
      const approval = await client(opts).get(p.id);
      r = toResult(approval, isSettled(approval) ? approval.signed_answer : undefined);
    }
    r = await checked(opts, p, r);
    if (r.status === 'waiting') waiting.push(p);
    else results.set(String(p.id), r);
  }
  return { ready: waiting.length === 0, results, waiting };
}
