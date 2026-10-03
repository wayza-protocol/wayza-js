// The adapters against the real frameworks (devDependencies), with fake models.
// Each test skips when its framework is not installed. The Claude Agent SDK is not
// here: query() drives the Claude Code binary, so it is covered by the fakes only.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, KEY } from './mock-server.js';
import { Wayza } from '../src/index.js';

const load = async (...names) => {
  try { return await Promise.all(names.map((n) => import(n))); } catch { return null; }
};

let mock, wayza;
before(async () => { mock = await startMock(); wayza = new Wayza({ key: KEY, home: mock.url }); });
after(() => mock.close());
beforeEach(() => { mock.onAsk = null; });
const to = 'graham@wayza.com';

const oa = await load('@openai/agents', 'zod');
test('real @openai/agents: needsApproval -> Wayza -> resumed run', { skip: !oa && 'not installed' }, async () => {
  const [{ Agent, run, tool, RunState, Usage, setTracingDisabled }, { z }] = oa;
  const { approveWithWayza, sendForApproval, resumeFromWayza } = await import('../src/openai.js');
  setTracingDisabled(true);
  const model = {
    async getResponse(req) {
      const last = req.input.at?.(-1);
      if (last?.type === 'function_call_result') {
        return { usage: new Usage(), output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(last.output) }] }] };
      }
      return { usage: new Usage(), output: [{ type: 'function_call', callId: `call_${Math.random()}`, name: 'refund', arguments: '{"amount":40}', status: 'completed' }] };
    },
    async *getStreamedResponse() { throw new Error('not used'); },
  };
  const refund = tool({ name: 'refund', description: 'Refund', parameters: z.object({ amount: z.number() }), needsApproval: true, execute: async ({ amount }) => `refunded ${amount}` });
  const agent = new Agent({ name: 'Support', model, tools: [refund] });

  mock.onAsk = () => ({ decision: 'approved' });
  let result = await run(agent, 'refund please');
  assert.equal(result.interruptions.length, 1);
  result = await run(agent, await approveWithWayza(result, { wayza, to }));
  assert.match(result.finalOutput, /refunded 40/);

  mock.onAsk = null;
  result = await run(agent, 'refund please');
  const saved = await sendForApproval(result, { wayza, to });
  const state = await RunState.fromString(agent, saved.state);
  await mock.answer(saved.pending[0].id, { decision: 'declined', text: 'too much' });
  const { ready } = await resumeFromWayza(state, saved.pending, { wayza });
  assert.equal(ready, true);
  result = await run(agent, state);
  assert.match(result.finalOutput, /too much/);
});

const ai = await load('ai', 'ai/test', 'zod');
test('real ai (Vercel AI SDK): tool-approval-request -> Wayza -> tool executes', { skip: !ai && 'not installed' }, async () => {
  const [{ generateText, tool }, { MockLanguageModelV4 }, { z }] = ai;
  const { wayzaApprovals } = await import('../src/vercel.js');
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => (prompt.at(-1).role === 'tool'
      ? { content: [{ type: 'text', text: JSON.stringify(prompt.at(-1).content) }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }
      : { content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'refund', input: '{"amount":40}' }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] }),
  });
  let ran = false;
  const tools = { refund: tool({ description: 'Refund', inputSchema: z.object({ amount: z.number() }), needsApproval: true, execute: async ({ amount }) => { ran = true; return `refunded ${amount}`; } }) };
  const messages = [{ role: 'user', content: 'refund' }];
  const first = await generateText({ model, tools, messages });
  mock.onAsk = () => ({ decision: 'approved' });
  messages.push(...(first.responseMessages ?? first.response.messages), ...(await wayzaApprovals(first, { wayza, to })));
  const second = await generateText({ model, tools, messages });
  assert.equal(ran, true);
  assert.match(second.text, /refunded 40/);
  assert.match(mock.calls.findLast((c) => c.post).post.details, /"amount": 40/);
});

const lg = await load('@langchain/langgraph');
test('real @langchain/langgraph: interrupt -> Wayza -> Command({ resume })', { skip: !lg && 'not installed' }, async () => {
  const [{ StateGraph, Annotation, MemorySaver, interrupt, Command, START, END }] = lg;
  const { askHuman, wayzaInterrupt, sendForApproval, resumeFromWayza } = await import('../src/langgraph.js');
  const S = Annotation.Root({ answer: Annotation(), inlineAnswer: Annotation() });
  let asks = 0;
  const graph = new StateGraph(S)
    .addNode('durable', async () => ({ answer: interrupt(wayzaInterrupt({ title: 'Send the email?' })) }))
    .addNode('askInline', async (_s, config) => { asks++; return { inlineAnswer: (await askHuman({ wayza, to, title: 'Inline?' }, config)).approved }; })
    .addEdge(START, 'durable').addEdge('durable', 'askInline').addEdge('askInline', END)
    .compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: 'real-1' } };
  const r1 = await graph.invoke({}, config);
  const { pending } = await sendForApproval(r1, { wayza, to }, config);
  await mock.answer(pending[0].id, { decision: 'approved', as: 'person' });
  const { ready, resume } = await resumeFromWayza(pending, { wayza });
  assert.equal(ready, true);
  mock.onAsk = () => ({ decision: 'declined' });
  const r2 = await graph.invoke(new Command({ resume }), config);
  assert.deepEqual([r2.answer.approved, r2.answer.as, r2.inlineAnswer], [true, 'person', false]);
  assert.equal(asks, 1);
});

const ms = await load('@mastra/core/workflows', '@mastra/core', 'zod');
test('real @mastra/core: suspend -> Wayza -> createRun({ runId }).resume', { skip: !ms && 'not installed' }, async () => {
  const [{ createWorkflow, createStep }, { Mastra }, { z }] = ms;
  const { wayzaGate, resumeFromWayza } = await import('../src/mastra.js');
  const gate = createStep({
    id: 'gate', inputSchema: z.object({}), outputSchema: z.object({ shipped: z.boolean() }),
    resumeSchema: z.object({ wayza: z.any() }), suspendSchema: z.object({ wayza: z.any() }),
    execute: async (ctx) => {
      const answer = await wayzaGate(ctx, { wayza, to, title: 'Ship it?', callback: 'https://agent.example/wayza' });
      if (!answer) return;
      return { shipped: answer.approved === true };
    },
  });
  const wf = createWorkflow({ id: 'ship', inputSchema: z.object({}), outputSchema: z.object({ shipped: z.boolean() }) }).then(gate).commit();
  const workflow = new Mastra({ workflows: { wf }, logger: false }).getWorkflow('wf');
  const run = await workflow.createRun();
  const r1 = await run.start({ inputData: {} });
  assert.equal(r1.status, 'suspended');
  const ask = [...mock.approvals.values()].at(-1);
  assert.equal(new URL(ask.callback).searchParams.get('wayza_run'), run.runId);
  await mock.answer(ask.id, { decision: 'approved' });
  const answer = await wayza.waitFor(ask.id, { timeout: '1s' });
  const r2 = await resumeFromWayza(workflow, answer, { runId: run.runId });
  assert.deepEqual([r2.status, r2.result], ['success', { shipped: true }]);
});
