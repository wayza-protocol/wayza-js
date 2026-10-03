// A local Wayza home that implements packages/CONTRACT.md, for tests.
import http from 'node:http';
import { canonical, requestFingerprint } from '../src/index.js';

export const KEY = 'fam_test_key';
/** The address of the agent that owns KEY. */
export const ME = '@ai-me';

export async function startMock() {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  const kid = 'test-1';
  const approvals = new Map();
  const waiters = new Map(); // id -> [resolve]
  const calls = [];
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
    if (url.pathname === '/.well-known/familia.json') {
      calls.push('keys');
      return send(200, { home: { name: home, keys: [{ kid, alg: 'Ed25519', jwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x } }] } });
    }
    let raw = '';
    for await (const c of req) raw += c;
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'bad key' });
    const m = /^\/wayza\/v0\/approvals(?:\/(\d+)(?:\/(reply|decision))?)?$/.exec(url.pathname);
    if (!m) return send(404, { error: 'unknown' });

    if (req.method === 'GET' && !m[1]) {
      const mine = [...approvals.values()].filter((a) => a.status === 'waiting' && a.people.some((p) => p.to === ME));
      return send(200, { waiting_for_your_person: mine.map(view), asked: [] });
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
    async expire(id) { await settle(approvals.get(Number(id)), 'expired'); },
    close: () => new Promise((r) => {
      for (const id of [...waiters.keys()]) notify(id);
      server.closeAllConnections?.();
      server.close(r);
    }),
  };
  return api;
}
