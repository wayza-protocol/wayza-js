// OpenAI Agents SDK (JS): tools with `needsApproval` stop the run with
// `result.interruptions` (RunToolApprovalItem[]); you call `state.approve(item)` or
// `state.reject(item)` and `run(agent, state)` again. RunState serialises with
// `state.toString()` and comes back with `RunState.fromString(agent, str)`.
import { client, askOptions, decide, denial, json, collect, plain, gated } from './adapter.js';
import { sentOf } from './index.js';

const callIdOf = (item) => item?.rawItem?.callId ?? item?.rawItem?.id ?? null;

function defaults(item) {
  const agent = item?.agent?.name ? `${item.agent.name} wants` : 'The agent wants';
  return {
    title: `${agent} to run ${item?.name ?? item?.rawItem?.name ?? 'a tool'}`,
    details: item?.arguments != null ? `Arguments:\n${json(item.arguments)}` : undefined,
  };
}

const interruptionsOf = (resultOrState) =>
  resultOrState?.interruptions ?? resultOrState?.getInterruptions?.() ?? [];
const stateOf = (resultOrState) => resultOrState?.state ?? resultOrState;

function apply(state, item, result, opts) {
  if (decide(opts, result)) state.approve(item);
  else state.reject(item, { message: denial(result) });
}

/**
 * Inline: ask Wayza about every pending interruption, wait for the answers, approve or
 * reject each one, and return the state to pass back to `run(agent, state)`.
 *
 *   result = await run(agent, await approveWithWayza(result, { to: 'graham@wayza.com' }));
 *
 * @param {any} result a RunResult (or a RunState)
 * @param {import('../index.js').AdapterOptions & { waitTimeout?: string|number }} opts
 */
export async function approveWithWayza(result, opts) {
  const wayza = client(opts);
  const state = stateOf(result);
  for (const item of interruptionsOf(result)) {
    const answer = await wayza.askAndWait({
      ...askOptions(opts, item, defaults(item), callIdOf(item)),
      waitTimeout: opts.waitTimeout, signal: opts.signal,
    });
    apply(state, item, answer, opts);
  }
  return state;
}

/**
 * Durable, step 1: send one ask per interruption (with your `callback`) and return
 * `{ state, pending }` to save. `state` is `result.state.toString()`.
 * @param {any} result
 * @param {import('../index.js').AdapterOptions} opts
 */
export async function sendForApproval(result, opts) {
  const wayza = client(opts);
  const pending = [];
  for (const item of interruptionsOf(result)) {
    const approval = await wayza.ask(askOptions(opts, item, defaults(item), callIdOf(item)));
    pending.push({ ...(await sentOf(approval)), callId: callIdOf(item) });
  }
  return { state: stateOf(result).toString(), pending };
}

/**
 * Durable, step 2 (in your callback handler, or on a timer): apply the answers to a
 * restored RunState. `answers` are results from `handleCallback()`; any pending ask
 * without one is read from Wayza. Nothing is applied until every ask is settled.
 *
 *   const state = await RunState.fromString(agent, saved.state);
 *   const { ready } = await resumeFromWayza(state, saved.pending, { answers: [await handleCallback(req)] });
 *   if (ready) result = await run(agent, state);
 *
 * @param {any} state a RunState
 * @param {{ id: any, request: string, asked_by: string, callId: string|null }[]} pending
 * @param {import('../index.js').AdapterOptions & { answers?: any[] }} [opts]
 */
export async function resumeFromWayza(state, pending, opts = {}) {
  const { ready, results, waiting } = await collect(pending, opts);
  if (!ready) return { ready, state, waiting, results: [] };
  const items = interruptionsOf(state);
  for (const p of pending) {
    const item = items.find((i) => callIdOf(i) === p.callId);
    if (item) apply(state, item, results.get(String(p.id)), opts);
  }
  return { ready, state, waiting, results: [...results.values()].map((r) => plain(gated(opts, r))) };
}
