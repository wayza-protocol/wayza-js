// Mastra workflows: a step's execute({ inputData, resumeData, suspendData, suspend, runId })
// calls `await suspend(payload)` to pause; the run's result has status 'suspended', and
// `run.resume({ step?, resumeData })` re-runs the step with `resumeData`. After a
// restart, `await workflow.createRun({ runId })` gets the run back.
import { client, askOptions, plain, gated, checked } from './adapter.js';
import { sentOf } from './index.js';

/**
 * Inline: ask and wait inside a step. The requestId comes from the run id and title,
 * so a retried step returns the same approval.
 *
 *   const answer = await askHuman(ctx, { to: 'graham@wayza.com', title: 'Ship it?' });
 *
 * @param {any} ctx the step's execute context
 * @param {import('../index.js').AdapterOptions & { title: string, waitTimeout?: string|number }} opts
 */
export async function askHuman(ctx, opts) {
  const answer = await client(opts).askAndWait({
    ...askOptions(opts, ctx, { title: opts.title }, opts.runId ?? ctx?.runId),
    waitTimeout: opts.waitTimeout, signal: opts.signal ?? ctx?.abortSignal,
  });
  return plain(gated(opts, answer));
}

/**
 * Durable gate inside a step. First run: sends the ask and suspends the step with
 * `{ wayza: { id, request, asked_by } }`, returning null. On resume: returns the Wayza
 * result, after verifying it is signed by your home and answers the ask this run sent.
 *
 *   execute: async (ctx) => {
 *     const answer = await wayzaGate(ctx, { to: 'graham@wayza.com', title: 'Ship it?', callback });
 *     if (!answer) return;              // suspended
 *     return { shipped: answer.approved === true };
 *   }
 *
 * A string `callback` gets `wayza_run=<runId>` appended so your handler knows which run to resume.
 * @param {any} ctx
 * @param {import('../index.js').AdapterOptions & { title: string }} opts
 */
export async function wayzaGate(ctx, opts) {
  const answer = ctx?.resumeData?.wayza;
  if (answer) {
    // Resume data comes from outside: verify it against our home and the ask this run sent.
    const sent = ctx.suspendData?.wayza ?? ctx.suspendPayload?.wayza;
    if (!sent?.id) throw new Error('Resumed with a Wayza answer, but this step did not suspend on an ask');
    return plain(gated(opts, await checked(opts, sent, answer)));
  }
  const runId = opts.runId ?? ctx?.runId;
  let callback = opts.callback;
  if (typeof callback === 'string' && runId) {
    const u = new URL(callback);
    u.searchParams.set('wayza_run', runId);
    callback = u.toString();
  }
  const approval = await client(opts).ask(askOptions({ ...opts, callback }, ctx, { title: opts.title }, runId));
  await ctx.suspend({ wayza: { ...(await sentOf(approval)), title: approval.title } });
  return null;
}

/**
 * Durable, on callback: resume the run with the verified answer.
 *
 *   const answer = await handleCallback(req);
 *   await resumeFromWayza(workflow, answer, { runId: new URL(req.url).searchParams.get('wayza_run') });
 *
 * @param {any} workflow a Mastra workflow (has createRun), or a Run (has resume)
 * @param {any} answer a result from handleCallback()
 * @param {{ runId?: string, step?: any }} [opts]
 */
export async function resumeFromWayza(workflow, answer, { runId, step } = {}) {
  const run = typeof workflow.resume === 'function' ? workflow : await workflow.createRun({ runId });
  return run.resume({ ...(step && { step }), resumeData: { wayza: plain(answer) } });
}
