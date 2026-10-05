// A local Wayza home that implements packages/CONTRACT.md, for tests.
import http from 'node:http';
import { canonical, requestFingerprint } from '../src/index.js';

export const KEY = 'fam_test_key';
/** The address of the agent that owns KEY. */
export const ME = '@ai-me';
/** The address of the agent's person: asks to them wait for the person, not the agent. */
export const PERSON = '@me';

export async function startMock() {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  const kid = 'test-1';
  const approvals = new Map();
  const waiters = new Map(); // id -> [resolve]
  const calls = [];
  const messages = [];
  let messageWaiters = [];
  let nextId = 1;
  let home, base;

  const notify = (id) => { for (const r of waiters.get(id) ?? []) r(); waiters.delete(id); };

  async function sign(record) {
    const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(canonical(record)));
    return { ...record, sig: { kid, alg: 'Ed25519', value: Buffer.from(sig).toString('base64') } };
  }

  async function settle(a, status) {
    a.status = status;
    a.signed_answer = await sign({
      v: 1, type: 'wayza.answer', approval: `${base}/approvals/${a.id}`,
      request: await requestFingerprint(view(a)), asked_by: a.asked_by_address, status,
      answers: a.people.map((p) => ({
        to: p.to, decision: p.decision, choice: p.choice ?? null, text: p.text ?? null,
        answered_by: p.decision === 'waiting' ? null : p.person, as: p.decision === 'waiting' ? null : p.as,
        attested: 'home', at: p.at ?? null,
      })),
      at: new Date().toISOString(), home,
    });
    notify(a.id);
    if (a.callback) {
      fetch(a.callback, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approval: view(a), signed_answer: a.signed_answer }),
      }).catch(() => {});
    }
  }

  const view = (a) => { const { callback, ...v } = a; return structuredClone(v); };

  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url, home ? `http://${home}` : 'http://x');
    if (url.pathname === '/.well-known/wayza.json') {
      calls.push('keys');
      return send(200, { home: { name: home, keys: [{ kid, alg: 'Ed25519', jwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x } }] } });
    }
    let raw = '';
    for await (const c of req) raw += c;
    if (url.pathname === '/wayza/v0/agents' && req.method === 'POST') {
      const b = JSON.parse(raw || '{}');
      calls.push({ signup: b, auth: req.headers.authorization ?? null });
      if (!b.name) return send(400, { error: 'name required' });
      return send(201, {
        id: 'wz_test', address: '@ai-new', full_address: `ai-new@${home}`, card: `http://${home}/a/wz_test.json`,
        owner_status: 'none', claim_link: `http://${home}/claim/abc`, connector_key: 'fam_new_key', api: base,
      });
    }
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'bad key' });
    if (url.pathname === '/wayza/v0/messages') {
      if (req.method === 'POST') {
        const b = JSON.parse(raw || '{}');
        calls.push({ message: b });
        if (!b.to || !b.text) return send(400, { error: 'to and text required' });
        if (b.to === '@nobody') return send(200, { sent: false, why: 'They do not take messages from AIs with no owner.' });
        return send(200, { sent: true, id: `msg_${messages.length + 1}`, ...(b.reply_to != null && { reply_to: b.reply_to }) });
      }
      calls.push({ messages: Object.fromEntries(url.searchParams) });
      const wait = Number(url.searchParams.get('wait') || 0);
      const unread = url.searchParams.get('unread') === 'true';
      let list = messages.filter((x) => !unread || !x.read);
      if (!list.length && wait) {
        await new Promise((r) => { const t = setTimeout(r, wait * 1000); messageWaiters.push(() => { clearTimeout(t); r(); }); });
        list = messages.filter((x) => !unread || !x.read);
      }
      const out = structuredClone(list).reverse();
      for (const x of list) x.read = true;
      return send(200, { messages: out });
    }
    const m = /^\/wayza\/v0\/approvals(?:\/(\d+)(?:\/(reply|decision))?)?$/.exec(url.pathname);
    if (!m) return send(404, { error: 'unknown' });

    if (req.method === 'GET' && !m[1]) {
      const mine = [...approvals.values()].filter((a) => a.status === 'waiting' && a.people.some((p) => p.to === ME || p.to === PERSON));
      return send(200, { waiting_for_your_person: mine.map((a) => ({ ...view(a), addressed_to: a.people.some((p) => p.to === ME) ? 'you' : 'your_person' })), asked: [] });
    }
    if (req.method === 'POST' && m[2]) {
      const a = approvals.get(Number(m[1]));
      const i = a?.people.findIndex((p) => p.to === ME) ?? -1;
      if (i < 0) return send(404, { error: 'No approval addressed to you with that id.' });
      const b = JSON.parse(raw || '{}');
      calls.push({ [m[2]]: a.id, body: b });
      return send(200, await api.answer(a.id, { ...b, text: b.text ?? b.note ?? null, as: m[2] === 'reply' ? 'ai' : 'ai-on-behalf', index: i }));
    }

    if (req.method === 'POST' && !m[1]) {
      const b = JSON.parse(raw || '{}');
      calls.push({ post: b });
      if (!b.title || b.title.length > 200) return send(400, { error: 'title required' });
      if (b.request_id) {
        const same = [...approvals.values()].find((a) => a.request_id === b.request_id);
        if (same) return send(200, view(same));
      }
      const id = nextId++;
      const a = {
        id, title: b.title, details: b.details ?? null, status: 'waiting', asked_by_address: '@ai-asker@' + home,
        choices: b.choices ?? null, free_text: !!b.free_text, request_id: b.request_id ?? null,
        expires_at: b.expires_at ?? null, callback: b.callback ?? null,
        people: [b.to].flat().map((to) => ({ to, person: String(to).split('@')[0] || to, decision: 'waiting', choice: null, text: null, as: null, at: null })),
      };
      approvals.set(id, a);
      if (api.onAsk) {
        const reply = api.onAsk(view(a));
        if (reply) setTimeout(() => api.answer(id, reply), 20);
      }
      return send(201, view(a));
    }
    const a = approvals.get(Number(m[1]));
    if (!a) return send(404, { error: 'unknown approval' });
    if (req.method === 'GET') {
      const wait = Math.min(30, Number(url.searchParams.get('wait') || 0));
      calls.push({ get: a.id, wait });
      if (wait && a.status === 'waiting') {
        await new Promise((r) => {
          const t = setTimeout(r, wait * 1000);
          waiters.set(a.id, [...(waiters.get(a.id) ?? []), () => { clearTimeout(t); r(); }]);
        });
      }
      return send(200, view(a));
    }
    if (req.method === 'DELETE') {
      if (a.status === 'waiting') await settle(a, 'cancelled');
      return send(200, view(a));
    }
    send(405, { error: 'method' });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  home = `127.0.0.1:${server.address().port}`;
  base = `http://${home}/wayza/v0`;

  const api = {
    /** Set to (approval) => answer options to auto-answer new asks shortly after they arrive. */
    onAsk: null,
    home, url: `http://${home}`, base, approvals, calls,
    /** Simulate someone answering. decision: approved | declined | answered. */
    async answer(id, { decision = 'approved', choice = null, text = null, as = 'person', index = 0 } = {}) {
      const a = approvals.get(Number(id));
      Object.assign(a.people[index], { decision, choice, text, as, at: new Date().toISOString() });
      await settle(a, decision);
      return view(a);
    },
    /** Simulate a message arriving in the agent's inbox. */
    deliver(m) {
      messages.push({ id: `msg_${messages.length + 1}`, at: new Date().toISOString(), read: false, title: null, ...m });
      const w = messageWaiters; messageWaiters = []; for (const r of w) r();
    },
    async expire(id) { await settle(approvals.get(Number(id)), 'expired'); },
    close: () => new Promise((r) => {
      for (const id of [...waiters.keys()]) notify(id);
      for (const r of messageWaiters) r();
      server.closeAllConnections?.();
      server.close(r);
    }),
  };
  return api;
}
