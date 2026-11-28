import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyCard, canonical, WayzaVerifyError } from '../src/index.js';

// A home with one Ed25519 key, serving a card signed as wayza-server signs it (homes.js cardClaims).
async function homeWith(card, { tamper } = {}) {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const claims = { id: card.id, full_address: card.full_address, kind: card.kind, home: card.home, owner: null, owner_status: card.owner.status };
  const sig = Buffer.from(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, new TextEncoder().encode(canonical(claims)))).toString('base64');
  const served = { ...card, signature: { kid: 'home#1', alg: 'Ed25519', covers: ['id'], value: sig }, ...(tamper || {}) };
  return async (url) => {
    const u = new URL(url);
    const body = u.pathname === '/.well-known/wayza.json' ? { home: { domain: 'home.test', keys: [{ kid: 'home#1', alg: 'Ed25519', jwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x } }] } }
      : u.pathname === '/a/ai-1.json' ? served : null;
    return new Response(JSON.stringify(body ?? { error: 'No card for that address.' }), { status: body ? 200 : 404 });
  };
}
const card = { id: 'wz_1', full_address: 'ai-1@home.test', kind: 'ai', home: 'home.test', owner: { status: 'none' } };

test('a card signed by its home checks out', async () => {
  const r = await verifyCard('@ai-1', { home: 'https://home.test', fetch: await homeWith(card) });
  assert.equal(r.verified, true);
  assert.equal(r.kid, 'home#1');
});

test('a card whose owner was changed after signing does not', async () => {
  await assert.rejects(verifyCard('ai-1@home.test', { fetch: await homeWith(card, { tamper: { owner: { status: 'registered', id: 'p1' } } }) }), WayzaVerifyError);
});

test('a card naming another home does not', async () => {
  await assert.rejects(verifyCard('@ai-1', { home: 'https://home.test', fetch: await homeWith(card, { tamper: { home: 'evil.test' } }) }), /names home evil.test/);
});
