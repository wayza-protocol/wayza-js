// Vercel AI SDK (v6, v7): a tool with `needsApproval` (or, in v7, a `toolApproval` entry of
// 'user-approval') makes generateText/streamText/agent.generate return
// { type: 'tool-approval-request', approvalId, toolCall: { toolCallId, toolName, input } }
// parts in `result.content`. You answer by appending
// { role: 'tool', content: [{ type: 'tool-approval-response', approvalId, approved, reason }] }
// to the messages and calling generate again.
import { client, askOptions, decide, denial, json, collect, plain, gated } from './adapter.js';
import { sentOf } from './index.js';

/** @param {any} result */
export const approvalRequests = (result) =>
  (result?.content ?? []).filter((p) => p?.type === 'tool-approval-request' && !p.isAutomatic);

function defaults(part) {
  const call = part.toolCall ?? {};
  return {
    title: `The agent wants to run ${call.toolName ?? 'a tool'}`,
    details: [part.reason, call.input !== undefined && `Input:\n${json(call.input)}`].filter(Boolean).join('\n\n') || undefined,
  };
}

const response = (approvalId, result, opts) => {
  const approved = decide(opts, result);
  return { type: 'tool-approval-response', approvalId, approved, ...(!approved && { reason: denial(result) }) };
};

/** Wraps responses in the tool message; [] when there is nothing to answer. */
const toolMessages = (content) => (content.length ? [{ role: 'tool', content }] : []);

/**
 * Inline: ask Wayza about each approval request, wait, and return the tool message(s)
 * to append before calling generate again.
 *
 *   messages.push(...result.responseMessages, ...(await wayzaApprovals(result, { to: 'graham@wayza.com' })));
 *
 * @param {any} result
 * @param {import('../index.js').AdapterOptions & { waitTimeout?: string|number }} opts
 */
export async function wayzaApprovals(result, opts) {
  const wayza = client(opts);
  const content = [];
  for (const part of approvalRequests(result)) {
    const answer = await wayza.askAndWait({
      ...askOptions(opts, part, defaults(part), part.approvalId),
      waitTimeout: opts.waitTimeout, signal: opts.signal,
    });
    content.push(response(part.approvalId, answer, opts));
  }
  return toolMessages(content);
}

/**
 * Durable, step 1: send one ask per approval request (with your `callback`). Save the
 * returned `pending` together with your messages.
 * @param {any} result
 * @param {import('../index.js').AdapterOptions} opts
 */
export async function sendForApproval(result, opts) {
  const wayza = client(opts);
  const pending = [];
  for (const part of approvalRequests(result)) {
    const approval = await wayza.ask(askOptions(opts, part, defaults(part), part.approvalId));
    pending.push({ ...(await sentOf(approval)), approvalId: part.approvalId, toolName: part.toolCall?.toolName ?? null });
  }
  return { pending };
}

/**
 * Durable, step 2: turn the answers into the tool message to append. `answers` are
 * results from handleCallback(); missing ones are read from Wayza.
 * Returns { ready, messages, waiting }; messages is empty until every ask settled.
 * @param {{ id: any, request: string, asked_by: string, approvalId: string }[]} pending
 * @param {import('../index.js').AdapterOptions & { answers?: any[] }} [opts]
 */
export async function resumeFromWayza(pending, opts = {}) {
  const { ready, results, waiting } = await collect(pending, opts);
  if (!ready) return { ready, messages: [], waiting, results: [] };
  const content = pending.map((p) => response(p.approvalId, results.get(String(p.id)), opts));
  return { ready, messages: toolMessages(content), waiting, results: [...results.values()].map((r) => plain(gated(opts, r))) };
}
