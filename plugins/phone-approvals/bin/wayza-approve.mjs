#!/usr/bin/env node
// Phone approvals for Claude Code and Codex, through Wayza. When the coding agent stops to ask permission, this hook
// sends the question to your phone as a Wayza ask from your own AI, waits for your Approve or Decline, and hands the
// answer back. No answer in time, or anything goes wrong: it says nothing, and the normal prompt waits on your computer.
// It never allows anything by itself.
//
//   wayza-approve setup [--name "Claude Code"]   get an address for this computer's coding agent and connect it to you
//   wayza-approve status                         who it asks, and whether it's connected
//   wayza-approve forget                         remove this computer's key (your Wayza account keeps the AI until you remove it)
//   wayza-approve hook                           the PermissionRequest hook itself: reads the request on stdin
//
// Settings: ~/.wayza/phone-approvals.json (or WAYZA_APPROVALS_CONFIG), readable only by you. WAYZA_URL picks another
// Wayza home (default https://wayza.com). WAYZA_APPROVALS_WAIT: seconds to wait for your answer (default 540, at most
// 3000; keep it under the hook's timeout). Needs Node 18 or later and nothing else.
import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const CONFIG = process.env.WAYZA_APPROVALS_CONFIG || join(homedir(), '.wayza', 'phone-approvals.json');
const API = '/wayza/v0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load() { try { return JSON.parse(readFileSync(CONFIG, 'utf8')); } catch { return null; } }
function save(c) {
  mkdirSync(dirname(CONFIG), { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(CONFIG, 0o600); } catch { /* not every file system has modes */ }
}
const baseOf = (c) => String((c && c.base) || process.env.WAYZA_URL || 'https://wayza.com').replace(/\/+$/, '');

async function call(c, method, path, body) {
  const r = await fetch(`${baseOf(c)}${API}${path}`, { method, signal: AbortSignal.timeout(45000),
    headers: { 'Content-Type': 'application/json', ...(c && c.key ? { Authorization: `Bearer ${c.key}` } : {}) }, body: body == null ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : {}; } catch { json = null; }
  if (!r.ok) throw Object.assign(new Error((json && json.error) || `Wayza answered ${r.status}`), { status: r.status });
  return json;
}

// ---------- what the ask says ----------
// Anything that looks like a secret is hidden before it leaves this computer: keys, tokens, passwords, and the
// credentials in a URL. The person still sees enough to judge the request.
const SECRET = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, /\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, /\bAIza[0-9A-Za-z_-]{30,}/g, /\bfam_[A-Za-z0-9_-]{16,}/g, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
export function hideSecrets(s) {
  let out = String(s ?? '');
  for (const re of SECRET) out = out.replace(re, '[hidden]');
  out = out.replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [hidden]');
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[hidden]@');
  out = out.replace(/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|AUTH)[A-Za-z0-9_]*)\s*([=:])\s*("[^"]*"|'[^']*'|[^\s'";&|]+)/gi, '$1$2[hidden]');
  out = out.replace(/(--?(?:password|passwd|token|secret|api-key|apikey|key)[= ])("[^"]*"|'[^']*'|\S+)/gi, '$1[hidden]');
  out = out.replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, (m) => /^[a-f0-9]{40}$/i.test(m) ? m : '[hidden]');   // a git commit hash stays
  return out;
}
const oneLine = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// Which agent asked, and a short question for the notification, with the full detail for the account page.
export function describe(input) {
  const agent = input.turn_id !== undefined ? 'Codex' : input.hook_event_name !== undefined ? 'Claude Code' : 'Your coding agent';
  const tool = String(input.tool_name || 'a tool'), ti = input.tool_input || {};
  const where = input.cwd ? basename(String(input.cwd)) : '';
  let what;
  const cmd = typeof ti.command === 'string' ? hideSecrets(ti.command) : null;
  if (tool === 'Bash' || tool === 'shell' || tool === 'exec_command') what = cmd ? `run \`${oneLine(cmd, 90)}\`` : 'run a command';
  else if (tool === 'apply_patch') what = 'apply a patch';
  else if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) what = `${tool === 'Write' ? 'write' : 'edit'} ${basename(String(ti.file_path || ti.notebook_path || 'a file'))}`;
  else if (tool === 'WebFetch') what = `fetch ${oneLine(hideSecrets(ti.url || 'a web page'), 80)}`;
  else if (tool === 'WebSearch') what = `search the web for "${oneLine(hideSecrets(ti.query || ''), 60)}"`;
  else if (tool.startsWith('mcp__')) { const [, server, name] = tool.split('__'); what = `use ${name || tool} from ${server || 'an MCP server'}`; }
  else what = `use ${tool}`;
  const title = oneLine(`${agent} wants to ${what}${where ? ` in ${where}` : ''}. Allow?`, 200);
  const shown = { ...ti }; delete shown.description;
  const body = hideSecrets(typeof ti.command === 'string' ? ti.command : JSON.stringify(shown, null, 2));
  const details = [`${agent} asked permission to use ${tool}${where ? ` in ${where}` : ''}.`, ti.description ? `Why: ${hideSecrets(ti.description)}` : null, '', body.slice(0, 1500)]
    .filter((x) => x != null).join('\n');
  return { agent, title, details: details.slice(0, 2000) };
}

// ---------- the hook ----------
async function readStdin() { let s = ''; for await (const c of process.stdin) s += c; return s; }
// Only a yes from the configured person themselves allows anything: their own row, approved, and recorded as answered by
// a person (on Wayza or by email link). A yes from any AI, even one allowed to approve for them, is never enough.
export const yesFromPerson = (a, person) => !!a && a.status === 'approved'
  && (a.people || []).some((p) => p.to === person && p.decision === 'approved' && (p.as === 'person' || p.as === 'email-link'));
const decide = (behavior, message) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest',
  decision: behavior === 'allow' ? { behavior } : { behavior, message } } }) + '\n');

export async function hook(input, { config = load(), waitSeconds = Number(process.env.WAYZA_APPROVALS_WAIT) || 540, log = (m) => process.stderr.write(`wayza-approve: ${m}\n`), persist = save } = {}) {
  if (!config || !config.key || !config.person) return null;   // not set up: the normal prompt
  if (config.enabled !== true) {   // switched on only once the person approves setup's first ask
    if (!config.setup_ask) { log('not switched on: run "wayza-approve setup" to finish.'); return null; }
    const s = await call(config, 'GET', `/approvals/${config.setup_ask}`).catch(() => null);
    if (!yesFromPerson(s, config.person)) return null;
    config = { ...config, enabled: true }; delete config.setup_ask; persist(config);
  }
  if (input.permission_mode === 'bypassPermissions') return null;
  const { title, details } = describe(input);
  const wait = Math.max(5, Math.min(3000, waitSeconds)), until = Date.now() + wait * 1000;
  // A retry of the same tool call (Claude Code's tool_use_id) is the same ask. Anything else is always a new ask, so an
  // earlier yes is never reused for a later request that happens to look the same.
  const request_id = `cc-${createHash('sha256').update(input.tool_use_id ? `${input.session_id || ''}:${input.tool_use_id}` : randomUUID()).digest('hex').slice(0, 32)}`;
  let a;
  try {
    a = await call(config, 'POST', '/approvals', { to: [config.person], title, details, request_id, expires_at: new Date(until + 60000).toISOString() });
  } catch (e) { log(`couldn't ask you on Wayza (${e.message}); the normal prompt is waiting.`); return null; }
  while (Date.now() < until) {
    const left = Math.ceil((until - Date.now()) / 1000);
    try { a = await call(config, 'GET', `/approvals/${a.id}?wait=${Math.max(1, Math.min(30, left))}`); }
    catch (e) { if (e.status && e.status < 500 && e.status !== 429) { log(`lost track of the ask (${e.message}).`); return null; } await sleep(2000); continue; }
    if (a.status === 'approved') return yesFromPerson(a, config.person) ? 'allow' : null;
    if (a.status === 'declined') return 'deny';
    if (a.status !== 'waiting') return null;
  }
  // No answer in time: call the ask off, so a late tap on the phone doesn't seem to count, and leave the prompt to the computer.
  try { await call(config, 'DELETE', `/approvals/${a.id}`); } catch { /* it expires by itself */ }
  return null;
}

// ---------- setup ----------
function flag(args, name, fallback) { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; }

async function setup(args) {
  let c = load();
  const base = flag(args, 'url', baseOf(c));
  if (!c || !c.key || baseOf(c) !== base) {
    const name = flag(args, 'name', 'Coding agent');
    const r = await call({ base }, 'POST', '/agents', { name, platform: 'other' });
    c = { base, key: r.connector_key, address: r.full_address || r.address, person: null };
    save(c);
    console.log(`Your coding agent's Wayza address is ${c.address}.\n`);
    if (r.claim_link) console.log(`Open this link on your phone and sign in (or make a free account) to confirm it's yours:\n\n  ${r.claim_link}\n\nOnly you should open it: whoever opens it first becomes its owner.\n`);
  }
  if (!c.person) {
    console.log('Waiting for you to confirm it… (Ctrl+C to stop; run setup again any time to carry on)');
    for (let i = 0; i < 400 && !c.person; i++) {
      const me = await call(c, 'GET', '/me').catch(() => null);
      if (me && me.your_person && me.your_person.address) { c.person = me.your_person.address; save(c); break; }
      if (i === 0 && me && me.claim) console.log(me.claim);
      await sleep(3000);
    }
    if (!c.person) { console.log('Not confirmed yet. Run setup again once you have opened the link.'); return; }
  }
  if (c.enabled === true) { console.log(`Already on: permission prompts go to ${c.person}.`); return; }
  console.log(`Connected to ${c.person}. Sending you a first ask now: tap Approve on your phone or at ${baseOf(c)}/account.`);
  console.log(`To get asks as notifications, open ${baseOf(c)}/account/notify on your phone and turn them on.\n`);
  const a = await call(c, 'POST', '/approvals', { to: [c.person], title: 'Send your coding agent\'s permission prompts to your phone?',
    details: 'From now on, when Claude Code or Codex on this computer stops to ask permission, the question comes here. Approve or Decline, and the agent carries on. If you don\'t answer, the normal prompt waits on your computer.',
    request_id: `setup-${Date.now()}` });
  c.enabled = false; c.setup_ask = a.id; save(c);
  for (let i = 0; i < 20; i++) {
    const r = await call(c, 'GET', `/approvals/${a.id}?wait=30`).catch(() => null);
    if (yesFromPerson(r, c.person)) { c.enabled = true; delete c.setup_ask; save(c); console.log('Done. Permission prompts now come to your phone.'); return; }
    if (r && r.status !== 'waiting') { delete c.setup_ask; save(c); console.log('You declined, so nothing is sent to your phone. Run "wayza-approve forget" to remove the key from this computer.'); return; }
  }
  console.log('No answer yet. Approve the ask on your account page and permission prompts start coming to your phone.');
}

async function main() {
  const [cmd = process.stdin.isTTY ? 'status' : 'hook', ...args] = process.argv.slice(2);
  if (cmd === 'hook') {
    let input; try { input = JSON.parse(await readStdin() || '{}'); } catch { return; }
    const d = await hook(input);
    if (d === 'allow') decide('allow');
    else if (d === 'deny') decide('deny', 'Declined from your phone on Wayza.');
    return;
  }
  if (cmd === 'setup') return setup(args);
  if (cmd === 'status') {
    const c = load();
    if (!c || !c.key) return console.log('Not set up. Run: wayza-approve setup');
    if (!c.person) return console.log(`Waiting for you to confirm ${c.address}. Run setup again.`);
    return console.log(c.enabled === true ? `Asks go to ${c.person} from ${c.address}.` : c.setup_ask ? `Waiting for you to approve the first ask at ${baseOf(c)}/account.` : 'Off. Run: wayza-approve setup');
  }
  if (cmd === 'forget') { rmSync(CONFIG, { force: true }); return console.log(`Removed ${CONFIG}. Remove the AI itself from your account page if you like.`); }
  console.log('Use: wayza-approve setup | status | forget | hook');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('wayza-approve.mjs')) main().catch((e) => { process.stderr.write(`wayza-approve: ${e.message}\n`); process.exitCode = 0; });
