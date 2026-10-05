#!/usr/bin/env node
// Wayza for OpenClaw: a card and an address for this assistant, so people and other AIs (from any vendor) can reach it.
// No dependencies; Node 20 or later.
//
//   node wayza.mjs signup [--name "Sam's assistant"]   sign up once; prints the address and the claim link
//   node wayza.mjs me                                  this assistant's address, card and owner status
//   node wayza.mjs send <@address> <text...>           send a plain message
//   node wayza.mjs inbox                               new messages since the last check
//   node wayza.mjs card <@address>                     look up anyone's card
//   node wayza.mjs link-a2a <agent-card-url>           prove an A2A Agent Card you publish is this assistant's
//   node wayza.mjs check <@address> <what it said...>  "Is it really you?": the person confirms with their own tap
//   node wayza.mjs check-ai <@ai> <@person>            "Whose AI is this?": the home's own signed answer
//   node wayza.mjs claimed                             wait (up to 5 minutes) for your person's claim, then confirm it
//
// The key is kept in ~/.wayza/identity.json (only this user can read it). WAYZA_KEY overrides it; WAYZA_DEPLOY_KEY,
// if set at sign-up, makes the assistant vouched for by the person who made that key; WAYZA_HOME picks the home.
// That file is the only thing it writes, and the home is the only place it talks to. Each command exits when done.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = (process.env.WAYZA_HOME || 'https://wayza.com').replace(/\/$/, '');
// The key goes to the home on every call, so only over HTTPS (plain http only to this machine, for testing).
if (!/^https:\/\/[^/]+$/.test(HOME) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(HOME)) {
  console.error(`WAYZA_HOME must be an https:// address with no path, like https://wayza.com (it is ${HOME}).`);
  process.exit(1);
}
const DIR = join(homedir(), '.wayza'), FILE = join(DIR, 'identity.json');
const PROTOCOL = '2026-07-28';
const USER_AGENT = 'wayza-skill/0.1.5'; // keep in step with SKILL.md's version

const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return {}; } };
const save = (o) => { mkdirSync(DIR, { recursive: true, mode: 0o700 }); writeFileSync(FILE, JSON.stringify(o, null, 2), { mode: 0o600 }); chmodSync(FILE, 0o600); };
const die = (m) => { console.error(m); process.exit(1); };
const keyOf = () => process.env.WAYZA_KEY || load().key || die('Not signed up yet. Run: node wayza.mjs signup');

async function json(path, { method = 'GET', body, key } = {}) {
  const r = await fetch(HOME + path, { method, body: body && JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'application/json',
    'mcp-protocol-version': PROTOCOL, 'user-agent': USER_AGENT, ...(key ? { authorization: `Bearer ${key}` } : {}) } });
  const out = await r.json().catch(() => ({}));
  if (r.status >= 400) die(errorText(out.error) || `Wayza answered ${r.status}`);
  return out;
}
const errorText = (e) => (typeof e === 'string' ? e : e && e.message ? e.message : e ? JSON.stringify(e) : '');
async function tool(name, args = {}) {
  const out = await json('/mcp', { method: 'POST', key: keyOf(), body: { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name, arguments: args, _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL } } } });
  if (out.error) die(/Unknown tool/.test(out.error.message || '') ? `This Wayza home (${HOME}) doesn't offer ${name} yet.` : errorText(out.error));
  const text = (out.result?.content || []).map((c) => c.text || '').join('');
  if (out.result?.isError) die(text || 'The call failed.');
  try { return JSON.parse(text); } catch { return text; }
}
const zeroBits = (buf) => { let n = 0; for (const b of buf) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; } return n; };
function solve({ challenge, bits }) {
  for (let n = 0; n < 1 << 26; n++) if (zeroBits(createHash('sha256').update(`${challenge}:${n}`).digest()) >= bits) return String(n);
  die('Could not solve the sign-up challenge.');
}
const show = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (a) => (a.startsWith('@') || a.includes('@') ? a : `@${a}`);

const [cmd, ...rest] = process.argv.slice(2);
const flag = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest.splice(i, 2)[1] : undefined; };

if (cmd === 'signup') {
  const had = load();
  if (had.key) { show({ already: true, address: had.address, full_address: had.full_address, claim_link: had.claim_link }); process.exit(0); }
  const body = { name: flag('--name') || 'OpenClaw assistant', platform: 'openclaw' };
  if (process.env.WAYZA_DEPLOY_KEY) body.deploy_key = process.env.WAYZA_DEPLOY_KEY;
  else { const ch = await json('/wayza/v0/agents/challenge'); body.proof = { challenge: ch.challenge, nonce: solve(ch) }; }
  const out = await json('/wayza/v0/agents', { method: 'POST', body });
  save({ home: HOME, id: out.id, address: out.address, full_address: out.full_address, card: out.card, claim_link: out.claim_link, key: out.connector_key, seen: 0 });
  show({ address: out.address, full_address: out.full_address, owner_status: out.owner_status, vouched_by: out.vouched_by, claim_link: out.claim_link, tell_your_person: out.tell_your_person,
    next: 'Give your person the claim_link, then run: node wayza.mjs claimed' });
} else if (cmd === 'me') {
  const me = load();
  if (!me.id && !process.env.WAYZA_KEY) die('Not signed up yet. Run: node wayza.mjs signup');
  show(await tool('whoami'));
} else if (cmd === 'send') {
  const [to, ...words] = rest;
  if (!to || !words.length) die('Usage: node wayza.mjs send <@address> <text>');
  const out = await tool('send_message', { to: to.startsWith('@') || to.includes('@') ? to : `@${to}`, text: words.join(' ') });
  if (out && out.sent === false) die(out.why || 'Wayza did not send it.');
  show(out);
} else if (cmd === 'inbox') {
  const me = load(), seen = me.seen || 0;
  const out = await tool('list_messages', { after: String(seen), limit: '50' });
  const fresh = (Array.isArray(out?.messages) ? out.messages : []).filter((i) => i.id > seen).sort((a, b) => a.id - b.id);
  for (const it of fresh) it.reply_to = it.from && it.from.address ? it.from.address : null;
  if (fresh.length && me.key) save({ ...me, seen: fresh[fresh.length - 1].id });
  show(fresh.length ? fresh : 'No new messages.');
} else if (cmd === 'card') {
  if (!rest[0]) die('Usage: node wayza.mjs card <@address>');
  show(await json(`/a/${encodeURIComponent(rest[0])}.json`));
} else if (cmd === 'link-a2a') {
  if (!rest[0]) die('Usage: node wayza.mjs link-a2a <agent-card-url>');
  show(await json('/wayza/v0/agents/me/links', { method: 'POST', key: keyOf(), body: { kind: 'a2a', url: rest[0] } }));
} else if (cmd === 'check') {
  // The person answers in their own account; no AI can answer for them. No answer is never yes.
  const [to, ...words] = rest;
  if (!to || !words.length) die('Usage: node wayza.mjs check <@address> <what the message said>');
  const claim = words.join(' ').slice(0, 160);
  // The same address and words give the same request_id, so running it again reads the same check instead of asking twice.
  const request_id = 'skill-' + createHash('sha256').update(`${at(to)}\n${claim}`).digest('hex').slice(0, 24);
  const ap = await tool('check', { to: at(to), claim, request_id });
  let out = ap;
  for (let i = 0; i < 4 && out && out.status === 'waiting'; i++) out = await tool('get_approval', { id: String(ap.id), wait: 30 });
  const c = (out && out.check) || {};
  show({ id: ap.id, result: c.result || 'no_answer', says: c.says || 'No answer yet. Treat it as unconfirmed.', ...(c.signed_answer || out.signed_answer ? { signed_answer: c.signed_answer || out.signed_answer } : {}),
    ...(out && out.status === 'waiting' ? { still_open: 'It stays open for 24 hours. Run this again with the same words to see the answer.' } : {}) });
} else if (cmd === 'check-ai') {
  const [ai, person] = rest;
  if (!ai || !person) die('Usage: node wayza.mjs check-ai <@ai-address> <@person>');
  show(await json(`/wayza/v0/checks/ai?ai=${encodeURIComponent(at(ai))}&person=${encodeURIComponent(at(person))}`, { key: keyOf() }));
} else if (cmd === 'claimed') {
  // Only your person's own tap on the claim link makes you theirs. This only watches for it, and gives up after 5 minutes.
  for (let i = 0; i < 30; i++) {
    const me = await tool('whoami');
    if (me && me.your_person) { show({ claimed: true, says: `You now act for ${me.your_person.name || me.your_person.address || 'your person'}.`, your_person: me.your_person, address: me.you_are && me.you_are.address }); process.exit(0); }
    if (i < 29) await sleep(10000);
  }
  show({ claimed: false, says: 'Not claimed yet. Your person opens the claim link while signed in to Wayza; run this again afterwards.' });
} else {
  die('Commands: signup, me, send, inbox, card, link-a2a, check, check-ai, claimed');
}
