// LangGraph.js: a node calls `interrupt(value)` (from @langchain/langgraph); with a
// checkpointer and `{ configurable: { thread_id } }` the graph pauses and
// `graph.invoke()` returns `{ __interrupt__: [{ id, value }] }`. You continue with
// `graph.invoke(new Command({ resume }), config)`, and `interrupt()` returns `resume`.
import { client, askOptions, collect, plain, gated } from './adapter.js';
import { sentOf } from './index.js';

const MARK = 'wayza';
const threadOf = (config) => config?.configurable?.thread_id ?? null;

/**
 * Inline: call inside a node. Asks and waits, then returns the result. LangGraph
 * re-runs a node from the top on resume or retry; the requestId is derived from the
 * thread id and title, so a re-run returns the same approval instead of asking again.
 *
 *   const answer = await askHuman({ to: 'graham@wayza.com', title: 'Send the email?' }, config);
 *
 * @param {import('../index.js').AdapterOptions & { title: string, waitTimeout?: string|number }} opts
 * @param {any} [config] the node's RunnableConfig
 */
export async function askHuman(opts, config) {
  const wayza = client(opts);
  const runId = opts.runId ?? threadOf(config);
  const answer = await wayza.askAndWait({
    ...askOptions(opts, null, { title: opts.title }, runId),
    waitTimeout: opts.waitTimeout, signal: opts.signal ?? config?.signal,
  });
  return plain(gated(opts, answer));
}

/**
 * Durable, in the node: build the interrupt payload. Pass it to your own `interrupt()`;
 * it returns the Wayza result once you resume.
 *
 *   const answer = interrupt(wayzaInterrupt({ title: 'Send the email?', details }));
 *   if (!answer.approved) return { status: 'cancelled' };
 *
 * @param {{ title: string, details?: string, choices?: string[], freeText?: boolean, to?: any, needs?: 'any'|'all' }} ask
 */
export const wayzaInterrupt = (ask) => ({ [MARK]: ask });

/**
 * Durable, after invoke: send an ask for each Wayza interrupt in `result.__interrupt__`
 * (with your `callback`). Save `pending` with the thread id.
 * @param {any} result the value graph.invoke() returned
 * @param {import('../index.js').AdapterOptions} opts
 * @param {any} [config] the invoke config, for the thread id
 */
export async function sendForApproval(result, opts, config) {
  const wayza = client(opts);
  const pending = [];
  for (const intr of result?.__interrupt__ ?? []) {
    const ask = intr?.value?.[MARK];
    if (!ask) continue;
    const runId = `${opts.runId ?? threadOf(config) ?? ''}/${intr.id ?? ''}`;
    const approval = await wayza.ask(askOptions({ ...opts, ...ask }, intr, { title: ask.title }, runId));
    pending.push({ ...(await sentOf(approval)), interruptId: intr.id ?? null });
  }
  return { pending };
}

/**
 * Durable, on callback: gather the answers and build the `resume` value.
 *
 *   const { ready, resume } = await resumeFromWayza(saved.pending, { answers: [await handleCallback(req)] });
 *   if (ready) await graph.invoke(new Command({ resume }), config);
 *
 * One pending interrupt resumes with its result; several resume with a map of
 * interrupt id to result, which is how LangGraph resumes parallel interrupts.
 * @param {{ id: any, request: string, asked_by: string, interruptId: string|null }[]} pending
 * @param {import('../index.js').AdapterOptions & { answers?: any[] }} [opts]
 */
export async function resumeFromWayza(pending, opts = {}) {
  const { ready, results, waiting } = await collect(pending, opts);
  if (!ready) return { ready, resume: undefined, waiting };
  const value = (p) => plain(gated(opts, results.get(String(p.id))));
  const resume = pending.length === 1
    ? value(pending[0])
    : Object.fromEntries(pending.map((p) => [p.interruptId, value(p)]));
  return { ready, resume, waiting };
}
