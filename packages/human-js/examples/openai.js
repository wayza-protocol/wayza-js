// OpenAI Agents SDK: a tool with needsApproval, answered by a person through Wayza.
import { Agent, run, tool, RunState } from '@openai/agents';
import { z } from 'zod';
import { handleCallback } from '@wayza/human';
import { approveWithWayza, sendForApproval, resumeFromWayza } from '@wayza/human/openai';

const refund = tool({
  name: 'refund',
  description: 'Refund an order',
  parameters: z.object({ order: z.string(), amount: z.number() }),
  needsApproval: true,
  execute: async ({ order, amount }) => `Refunded £${amount} on ${order}`,
});
const agent = new Agent({ name: 'Support', instructions: 'Help with orders.', tools: [refund] });

// Inline: wait in-process for the answer (fine for short waits).
let result = await run(agent, 'Refund £40 on order 1182, it arrived broken.');
while (result.interruptions?.length) {
  result = await run(agent, await approveWithWayza(result, { to: 'graham@wayza.com', timeout: '30m' }));
}
console.log(result.finalOutput);

// Durable: send the ask, save the run, and resume when the callback arrives.
const db = new Map();
result = await run(agent, 'Refund £15 on order 1190.');
if (result.interruptions?.length) {
  const saved = await sendForApproval(result, { to: 'graham@wayza.com', callback: 'https://agent.example.com/wayza' });
  db.set('run-1190', saved); // { state: RunState string, pending: [{ id, request, asked_by, callId }] }
}

// In your POST /wayza handler:
export async function onWayzaCallback(request) {
  const answer = await handleCallback(request); // verifies it is signed by wayza.com
  const saved = db.get('run-1190');
  const state = await RunState.fromString(agent, saved.state);
  const { ready } = await resumeFromWayza(state, saved.pending, { answers: [answer] });
  if (ready) console.log((await run(agent, state)).finalOutput);
  return new Response('ok');
}
