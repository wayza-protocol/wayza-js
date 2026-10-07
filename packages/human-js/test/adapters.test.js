// Each adapter against fake framework objects shaped like the real APIs.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, KEY } from './mock-server.js';
import { Wayza, handleCallback } from '../src/index.js';
import * as openai from '../src/openai.js';
import * as claude from '../src/claude.js';
import * as vercel from '../src/vercel.js';
import * as langgraph from '../src/langgraph.js';
import * as mastra from '../src/mastra.js';

let mock, wayza;
before(async () => { mock = await startMock(); wayza = new Wayza({ key: KEY, home: mock.url }); });
after(() => mock.close());
beforeEach(() => { mock.onAsk = null; });

const to = 'graham@wayza.com';
const lastPost = () => mock.calls.findLast((c) => c.post).post;
/** The callback body the home would POST for an approval id. */
const callbackFor = async (id) => {
  const a = await wayza.get(id);
  return handleCallback({ body: JSON.stringify({ approval: a, signed_answer: a.signed_answer }) }, { home: mock.url, insecure: true });
};

// ---- OpenAI Agents: RunToolApprovalItem + RunState ----
class FakeRunState {
  constructor(items) { this.items = items; this.log = []; }
  getInterruptions() { return this.items; }
  approve(item, options) { this.log.push(['approve', item.rawItem.callId, options]); }
  reject(item, options) { this.log.push(['reject', item.rawItem.callId, options]); }
  toString() { return JSON.stringify({ calls: this.items.map((i) => i.rawItem.callId) }); }
}
const approvalItem = (callId, name, args) => ({
  type: 'tool_approval_item', rawItem: { type: 'function_call', callId, name, arguments: args },
  agent: { name: 'Support' }, get name() { return this.rawItem.name; }, get arguments() { return this.rawItem.arguments; },
});

test('openai inline: approves and rejects interruptions on the state', async () => {
  const items = [approvalItem('call_1', 'refund', '{"amount":40}'), approvalItem('call_2', 'email', '{}')];
  const state = new FakeRunState(items);
  mock.onAsk = (a) => (a.title.includes('refund') ? { decision: 'approved' } : { decision: 'declined', text: 'not now' });
  const out = await openai.approveWithWayza({ interruptions: items, state }, { wayza, to });
  assert.equal(out, state);
  assert.deepEqual(state.log, [['approve', 'call_1', undefined], ['reject', 'call_2', { message: 'not now' }]]);
  assert.match(mock.approvals.get(mock.approvals.size - 1).details, /"amount":40/);
  assert.equal(mock.approvals.get(mock.approvals.size - 1).title, 'Support wants to run refund');
});

test('openai durable: send, save, resume from callback; retry does not double-ask', async () => {
  const items = [approvalItem('call_9', 'refund', '{"amount":5}')];
  const result = { interruptions: items, state: new FakeRunState(items) };
  const saved = JSON.parse(JSON.stringify(await openai.sendForApproval(result, { wayza, to, callback: 'https://agent.example/wayza' })));
  assert.equal(saved.state, '{"calls":["call_9"]}');
  assert.equal(lastPost().callback, 'https://agent.example/wayza');
  const again = await openai.sendForApproval(result, { wayza, to });
  assert.equal(again.pending[0].id, saved.pending[0].id, 'same requestId -> same approval');

  const restored = new FakeRunState(items); // stands in for RunState.fromString(agent, saved.state)
  const early = await openai.resumeFromWayza(restored, saved.pending, { wayza });
  assert.equal(early.ready, false);
  assert.deepEqual(restored.log, []);

  await mock.answer(saved.pending[0].id, { decision: 'approved' });
  const answer = await callbackFor(saved.pending[0].id);
  const done = await openai.resumeFromWayza(restored, saved.pending, { wayza, answers: [answer] });
  assert.equal(done.ready, true);
  assert.deepEqual(restored.log, [['approve', 'call_9', undefined]]);
});

// Codex review 7 Oct 2026: a signed "declined" with the unsigned fields changed to say yes approves nothing.
test('a signed no with its unsigned fields changed to yes is still a no', async () => {
  const items = [approvalItem('call_f', 'refund', '{"amount":900}')];
  const saved = await openai.sendForApproval({ interruptions: items, state: new FakeRunState(items) }, { wayza, to });
  await mock.answer(saved.pending[0].id, { decision: 'declined' });
  const forged = { ...(await callbackFor(saved.pending[0].id)), status: 'approved', approved: true, byPerson: true, as: 'person' };
  const state = new FakeRunState(items);
  const out = await openai.resumeFromWayza(state, saved.pending, { wayza, answers: [forged] });
  assert.equal(state.log[0][0], 'reject');
  assert.equal(out.results[0].approved, false);

  let pending;
  const canUseTool = claude.wayzaCanUseTool({ wayza, to, mode: 'durable', onPending: (p) => { pending = p; } });
  await canUseTool('Bash', { command: 'rm -rf /' }, { signal: new AbortController().signal, toolUseID: 'tu_f', requestId: 'r' });
  await mock.answer(pending.id, { decision: 'declined' });
  const forged2 = { ...(await callbackFor(pending.id)), status: 'approved', approved: true, byPerson: true };
  const resumed = await claude.allowApproved(forged2, pending, undefined, { wayza });
  assert.equal((await resumed('Bash', { command: 'rm -rf /' }, {})).behavior, 'deny');
  // "Still waiting" with no signed record but approved: true is still waiting.
  const waitingYes = await claude.allowApproved({ id: pending.id, status: 'waiting', approved: true, byPerson: true }, pending, undefined, { wayza });
  assert.equal((await waitingYes('Bash', { command: 'rm -rf /' }, {})).behavior, 'deny');
});

// ---- Claude Agent SDK: canUseTool ----
test('claude inline: allow and deny', async () => {
  const canUseTool = claude.wayzaCanUseTool({ wayza, to });
  const ctx = (id) => ({ signal: new AbortController().signal, toolUseID: id, requestId: 'r' });
  mock.onAsk = () => ({ decision: 'approved' });
  assert.deepEqual(await canUseTool('Bash', { command: 'ls' }, ctx('tu_1')), { behavior: 'allow', updatedInput: { command: 'ls' } });
  assert.equal(lastPost().title, 'Claude wants to use Bash');
  mock.onAsk = () => ({ decision: 'declined' });
  const denied = await canUseTool('Bash', { command: 'rm -rf /' }, { ...ctx('tu_2'), title: 'Claude wants to run rm -rf /' });
  assert.equal(denied.behavior, 'deny');
  assert.match(denied.message, /Declined by graham/);
  assert.equal(lastPost().title, 'Claude wants to run rm -rf /');

  const filtered = claude.wayzaCanUseTool({ wayza, to, when: (name) => name !== 'Read' });
  const before = mock.approvals.size;
  assert.equal((await filtered('Read', { file_path: 'a' }, ctx('tu_3'))).behavior, 'allow');
  assert.equal(mock.approvals.size, before);
});

test('claude durable: deny with interrupt, then allow exactly the approved call on resume', async () => {
  let pending;
  const canUseTool = claude.wayzaCanUseTool({ wayza, to, mode: 'durable', callback: 'https://agent.example/wayza', onPending: (p) => { pending = p; } });
  const r = await canUseTool('Write', { file_path: '/tmp/x', content: 'hi' }, { signal: new AbortController().signal, toolUseID: 'tu_9', requestId: 'r' });
  assert.deepEqual([r.behavior, r.interrupt], ['deny', true]);
  assert.equal(pending.toolName, 'Write');

  await mock.answer(pending.id, { decision: 'approved' });
  const answer = await callbackFor(pending.id);
  const resumed = await claude.allowApproved(answer, pending, undefined, { wayza });
  assert.equal((await resumed('Write', { content: 'hi', file_path: '/tmp/x' }, {})).behavior, 'allow');
  assert.equal((await resumed('Write', { content: 'hi', file_path: '/tmp/x' }, {})).behavior, 'deny', 'only once');
  assert.equal((await resumed('Bash', { command: 'ls' }, {})).behavior, 'deny');
  assert.match(claude.resumePrompt(answer, pending), /approved Write/);
  await assert.rejects(claude.allowApproved(answer, { ...pending, id: 999 }, undefined, { wayza }), /not 999/);
  await assert.rejects(claude.allowApproved(answer, { ...pending, request: 'ff'.repeat(32) }, undefined, { wayza }), /different question/);
  await assert.rejects(claude.allowApproved(answer, pending, undefined, { insecure: true }), /not the home you trust/, 'with no home given, wayza.com is the only home trusted');
});

// ---- Vercel AI SDK: tool-approval-request / tool-approval-response ----
const approvalPart = (approvalId, toolName, input) => ({
  type: 'tool-approval-request', approvalId, toolCall: { type: 'tool-call', toolCallId: `tc_${approvalId}`, toolName, input },
});

test('vercel inline: returns the tool message of approval responses', async () => {
  const result = { content: [{ type: 'text', text: 'hi' }, approvalPart('ap1', 'refund', { amount: 40 }), approvalPart('ap2', 'delete', { path: '/' }),
    { ...approvalPart('ap3', 'auto', {}), isAutomatic: true }] };
  mock.onAsk = (a) => (a.title.includes('refund') ? { decision: 'approved' } : { decision: 'declined' });
  const msgs = await vercel.wayzaApprovals(result, { wayza, to });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'tool');
  assert.deepEqual(msgs[0].content.map((c) => [c.type, c.approvalId, c.approved]), [
    ['tool-approval-response', 'ap1', true], ['tool-approval-response', 'ap2', false]]);
  assert.match(msgs[0].content[1].reason, /Declined/);
  assert.deepEqual(await vercel.wayzaApprovals({ content: [] }, { wayza, to }), []);
});

test('vercel durable: pending, then messages once answered', async () => {
  const result = { content: [approvalPart('ap7', 'refund', { amount: 1 })] };
  const { pending } = await vercel.sendForApproval(result, { wayza, to, callback: 'https://agent.example/wayza' });
  assert.equal((await vercel.resumeFromWayza(pending, { wayza })).ready, false);
  await mock.answer(pending[0].id, { decision: 'approved' });
  const r = await vercel.resumeFromWayza(pending, { wayza });
  assert.deepEqual(r.messages, [{ role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'ap7', approved: true }] }]);
});

// ---- LangGraph.js: interrupt() / Command({ resume }) ----
test('langgraph inline: askHuman in a node, re-run reuses the approval', async () => {
  mock.onAsk = () => ({ decision: 'approved' });
  const config = { configurable: { thread_id: 'thread-1' } };
  const a = await langgraph.askHuman({ wayza, to, title: 'Send the email?' }, config);
  const b = await langgraph.askHuman({ wayza, to, title: 'Send the email?' }, config);
  assert.equal(a.approved, true);
  assert.equal(a.id, b.id);
  assert.ok(!('approval' in a), 'JSON-safe for checkpoints');
});

test('langgraph durable: interrupts -> asks -> resume value', async () => {
  const invokeResult = { __interrupt__: [
    { id: 'i-1', value: langgraph.wayzaInterrupt({ title: 'Send the email?', details: 'To: board' }) },
    { id: 'i-2', value: 'not ours' },
  ] };
  const config = { configurable: { thread_id: 'thread-2' } };
  const { pending } = await langgraph.sendForApproval(invokeResult, { wayza, to, callback: 'https://agent.example/wayza' }, config);
  assert.equal(pending.length, 1);
  assert.equal(lastPost().details, 'To: board');
  await mock.answer(pending[0].id, { decision: 'declined', text: 'wait for Monday' });
  const { ready, resume } = await langgraph.resumeFromWayza(pending, { wayza, answers: [await callbackFor(pending[0].id)] });
  assert.equal(ready, true);
  assert.deepEqual([resume.approved, resume.text], [false, 'wait for Monday']);

  const two = { __interrupt__: [{ id: 'a', value: langgraph.wayzaInterrupt({ title: 'A?' }) }, { id: 'b', value: langgraph.wayzaInterrupt({ title: 'B?' }) }] };
  const p2 = (await langgraph.sendForApproval(two, { wayza, to }, config)).pending;
  for (const p of p2) await mock.answer(p.id, { decision: 'approved' });
  const r2 = await langgraph.resumeFromWayza(p2, { wayza });
  assert.deepEqual(Object.keys(r2.resume), ['a', 'b']);
});

// ---- Mastra: step suspend() / run.resume({ resumeData }) ----
test('mastra inline and durable gate', async () => {
  mock.onAsk = () => ({ decision: 'approved', as: 'ai-on-behalf' });
  const ctx = { runId: 'run-1', inputData: {}, resumeData: undefined, suspendData: undefined };
  const inline = await mastra.askHuman(ctx, { wayza, to, title: 'Ship it?' });
  assert.deepEqual([inline.approved, inline.as], [false, 'ai-on-behalf'], 'by default a gate needs a person, not their AI');
  assert.match(inline.refused, /needs a person/);
  const lax = await mastra.askHuman(ctx, { wayza, to, title: 'Ship it?', requirePerson: false });
  assert.deepEqual([lax.approved, lax.as], [true, 'ai-on-behalf']);

  mock.onAsk = null;
  let suspended;
  const step = { runId: 'run-2', inputData: {}, suspend: async (p) => { suspended = p; } };
  assert.equal(await mastra.wayzaGate(step, { wayza, to, title: 'Deploy?', callback: 'https://agent.example/wayza' }), null);
  assert.equal(lastPost().callback, 'https://agent.example/wayza?wayza_run=run-2');
  await mock.answer(suspended.wayza.id, { decision: 'approved' });
  const answer = await callbackFor(suspended.wayza.id);

  // A fake workflow: createRun({ runId }) -> run.resume({ resumeData }) re-runs the step.
  const workflow = {
    createRun: async ({ runId }) => ({
      runId,
      resume: async ({ resumeData }) => mastra.wayzaGate({ ...step, resumeData, suspendData: suspended }, { wayza, to, title: 'Deploy?' }),
    }),
  };
  const out = await mastra.resumeFromWayza(workflow, answer, { runId: 'run-2' });
  assert.equal(out.approved, true);
  // A genuine answer to a different ask is a replay, and is refused.
  const other = await wayza.ask({ to, title: 'Something else?' });
  await mock.answer(other.id, { decision: 'approved' });
  const replay = await callbackFor(other.id);
  await assert.rejects(
    mastra.wayzaGate({ ...step, resumeData: { wayza: replay }, suspendData: suspended }, { wayza, to, title: 'x' }),
    /Answer is for approval/);
});
