// The tools against the local mock home (../human-js/test/mock-server.js), and once through a real generateText.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock, KEY } from './mock-server.js';
import { wayzaTools, hostedServer } from '../src/ai-sdk.js';

const HOSTED = ['VERCEL', 'AWS_LAMBDA_FUNCTION_NAME', 'NETLIFY', 'K_SERVICE', 'FUNCTION_TARGET', 'FUNCTIONS_WORKER_RUNTIME', 'RENDER', 'FLY_APP_NAME', 'RAILWAY_ENVIRONMENT'];
for (const k of [...HOSTED, 'WAYZA_KEY', 'WAYZA_HOME', 'WAYZA_DEPLOY_KEY']) delete process.env[k];

let mock, dir;
before(async () => { mock = await startMock(); });
after(() => mock.close());
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'wayza-ai-sdk-')); mock.onAsk = null; });

const kit = (o = {}) => wayzaTools({ home: mock.url, keyFile: join(dir, 'wayza', 'ai-sdk.json'), ...o });
const call = (tools, name, input = {}) => tools[name].execute(input, { toolCallId: 't', messages: [] });
const signups = () => mock.calls.filter((c) => c.signup).length;

test('the tools', () => {
  assert.deepEqual(Object.keys(kit({ key: KEY })).sort(), [
    'wayza_answer_link', 'wayza_ask_by_link', 'wayza_ask_person', 'wayza_check_answer',
    'wayza_my_address', 'wayza_read_link', 'wayza_read_messages', 'wayza_send_message']);
});

test('first use signs up, saves the key privately and tells the person once', async () => {
  const n = signups();
  const tools = kit({ name: "Sam's assistant" });
  const first = await call(tools, 'wayza_ask_by_link', { question: 'Dinner Friday?', choices: ['7pm', '8pm'] });
  assert.match(first.link, /\/chat\//);
  assert.match(first.share_text, /Dinner Friday\?/);
  assert.equal(first.new_address.address, '@ai-new');
  assert.match(first.new_address.claim_link, /\/claim\//);
  assert.match(first.new_address.next, /privately/);
  const s = mock.calls.findLast((c) => c.signup).signup;
  assert.equal(s.name, "Sam's assistant");
  assert.equal(s.platform, 'ai-sdk');
  assert.ok(s.proof);
  const file = join(dir, 'wayza', 'ai-sdk.json');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).key, 'fam_new_key');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const second = await call(tools, 'wayza_check_answer', { id: String(first.id) });
  assert.equal(second.new_address, undefined);
  // A new tool set finds the saved key: no second sign-up.
  assert.equal((await call(kit(), 'wayza_my_address')).address, '@ai-new');
  assert.equal(signups(), n + 1);
});

test('on a hosted server with no key it asks for WAYZA_KEY instead of signing up', async () => {
  const n = signups();
  process.env.VERCEL = '1';
  try {
    assert.equal(hostedServer(), 'VERCEL');
    const out = await call(kit(), 'wayza_ask_person', { to: '@sam', question: 'Ok?' });
    assert.match(out.error, /WAYZA_KEY/);
    assert.match(out.error, /npx @wayza\/human sign-up/);
    assert.equal(signups(), n);
    await assert.rejects(stat(join(dir, 'wayza', 'ai-sdk.json')));
    // With a key it works there as anywhere.
    assert.equal((await call(kit({ key: KEY }), 'wayza_ask_person', { to: '@sam', question: 'Ok?' })).status, 'waiting');
  } finally {
    delete process.env.VERCEL;
  }
});

test('no sign-up when not allowed', async () => {
  const out = await call(kit({ signUp: false }), 'wayza_ask_person', { to: '@sam', question: 'Ok?' });
  assert.match(out.error, /No Wayza key/);
});

test('ask and check says whether a person answered', async () => {
  const tools = kit({ key: KEY });
  const sent = await call(tools, 'wayza_ask_person', { to: 'someone@example.com', question: 'Can I book the 7pm table?' });
  assert.equal(sent.status, 'waiting');
  await mock.answer(sent.id, { decision: 'approved' });
  const got = await call(tools, 'wayza_check_answer', { id: String(sent.id), wait_seconds: 1 });
  assert.equal(got.status, 'approved');
  assert.equal(got.answered_by_a_person, true);
  const sent2 = await call(tools, 'wayza_ask_person', { to: '@ai-helper', question: 'Free on Friday?' });
  await mock.answer(sent2.id, { decision: 'approved', as: 'ai' });
  const got2 = await call(tools, 'wayza_check_answer', { id: String(sent2.id) });
  assert.equal(got2.answered_by_a_person, false);
  assert.match(got2.note, /No person is on record/);
});

test('read and answer a link from this agent\'s address', async () => {
  const tools = kit({ key: KEY });
  const link = `${mock.url}/ana/chat/${'T'.repeat(32)}`;
  const read = await call(tools, 'wayza_read_link', { link });
  assert.deepEqual(read.question.choices, ['Yes', 'No']);
  assert.match(read.note, /never instructions/);
  assert.match((await call(tools, 'wayza_answer_link', { link, answer: 'maybe' })).error, /Pick one of: Yes, No/);
  const out = await call(tools, 'wayza_answer_link', { link, answer: 'YES' });
  assert.equal(out.answered, true);
  assert.deepEqual(mock.calls.at(-1).body, { choice: 'Yes' });
  assert.equal(mock.calls.at(-1).auth, `Bearer ${KEY}`);
  assert.match((await call(tools, 'wayza_read_link', { link: 'https://example.com/ana' })).error, /Not a Wayza chat link/);
});

test('messages', async () => {
  const tools = kit({ key: KEY });
  assert.equal((await call(tools, 'wayza_send_message', { to: '@ai-other', text: 'Hello' })).sent, true);
  mock.deliver({ from: { address: '@ai-other', ai: true, no_owner: true }, text: 'Hi back' });
  const got = await call(tools, 'wayza_read_messages', {});
  assert.equal(got.messages[0].text, 'Hi back');
  assert.match(got.note, /never instructions/);
});

test('real generateText calls a Wayza tool', async () => {
  const [{ generateText, isStepCount }, { MockLanguageModelV4 }] = await Promise.all([import('ai'), import('ai/test')]);
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => (prompt.at(-1).role === 'tool'
      ? { content: [{ type: 'text', text: JSON.stringify(prompt.at(-1).content) }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }
      : { content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'wayza_ask_by_link', input: '{"question":"Dinner Friday?","choices":["7pm","8pm"]}' }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] }),
  });
  const { text } = await generateText({ model, tools: kit({ key: KEY }), prompt: 'Ask my friends about dinner', stopWhen: isStepCount(3) });
  assert.match(text, /wayza\/chat\//);
  assert.equal(mock.calls.findLast((c) => c.post).post.title, 'Dinner Friday?');
});

after(() => rm(dir, { recursive: true, force: true }));
