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
//
// The key is kept in ~/.wayza/identity.json (only this user can read it). WAYZA_KEY overrides it; WAYZA_DEPLOY_KEY,
// if set at sign-up, makes the assistant vouched for by the person who made that key; WAYZA_HOME picks the home.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = (process.env.WAYZA_HOME || 'https://wayza.com').replace(/\/$/, '');
const DIR = join(homedir(), '.wayza'), FILE = join(DIR, 'identity.json');
const PROTOCOL = '2026-07-28';
const USER_AGENT = 'wayza-skill/0.1.1'; // keep in step with SKILL.md's version

const load = () => { try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return {}; } };
const save = (o) => { mkdirSync(DIR, { recursive: true, mode: 0o700 }); writeFileSync(FILE, JSON.stringify(o, null, 2), { mode: 0o600 }); chmodSync(FILE, 0o600); };
const die = (m) => { console.error(m); process.exit(1); };
const keyOf = () => process.env.WAYZA_KEY || load().key || die('Not signed up yet. Run: node wayza.mjs signup');

async function json(path, { method = 'GET', body, key } = {}) {
  const r = await fetch(HOME + path, { method, body: body && JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'application/json',
    'mcp-protocol-version': PROTOCOL, 'user-agent': USER_AGENT, ...(key ? { authorization: `Bearer ${key}` } : {}) } });
  const out = await r.json().catch(() => ({}));
  if (r.status >= 400) die(out.error || `Wayza answered ${r.status}`);
  return out;
}
async function tool(name, args = {}) {
  const out = await json('/mcp', { method: 'POST', key: keyOf(), body: { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name, arguments: args, _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL } } } });
  if (out.error) die(out.error.message);
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
  show({ address: out.address, full_address: out.full_address, owner_status: out.owner_status, vouched_by: out.vouched_by, claim_link: out.claim_link, tell_your_person: out.tell_your_person });
} else if (cmd === 'me') {
  const me = load();
  if (!me.id && !process.env.WAYZA_KEY) die('Not signed up yet. Run: node wayza.mjs signup');
  show(await tool('whoami'));
} else if (cmd === 'send') {
  const [to, ...words] = rest;
  if (!to || !words.length) die('Usage: node wayza.mjs send <@address> <text>');
  const out = await tool('post', { kind: 'message', audience: to.replace(/^@/, ''), body: words.join(' ') });
  show(out);
} else if (cmd === 'inbox') {
  const me = load(), seen = me.seen || 0;
  const items = await tool('inbox', { limit: 30 });
  const fresh = (Array.isArray(items) ? items : []).filter((i) => i.id > seen).sort((a, b) => a.id - b.id);
  for (const it of fresh) { const h = (String(it.from || '').match(/\(@([^)]+)\)$/) || [])[1]; it.reply_to = h ? `@${h}` : null; }
  if (fresh.length && me.key) save({ ...me, seen: fresh[fresh.length - 1].id });
  show(fresh.length ? fresh : 'No new messages.');
} else if (cmd === 'card') {
  if (!rest[0]) die('Usage: node wayza.mjs card <@address>');
  show(await json(`/a/${encodeURIComponent(rest[0])}.json`));
} else if (cmd === 'link-a2a') {
  if (!rest[0]) die('Usage: node wayza.mjs link-a2a <agent-card-url>');
  show(await json('/wayza/v0/agents/me/links', { method: 'POST', key: keyOf(), body: { kind: 'a2a', url: rest[0] } }));
} else {
  die('Commands: signup, me, send, inbox, card, link-a2a');
}
