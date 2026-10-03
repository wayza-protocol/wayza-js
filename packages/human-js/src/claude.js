// Claude Agent SDK (TypeScript): `query({ prompt, options: { canUseTool } })` calls
// canUseTool(toolName, input, { signal, toolUseID, ... }) and expects
// { behavior: 'allow', updatedInput } or { behavior: 'deny', message, interrupt? }.
import { client, askOptions, decide, denial, json, canonicalKey, checked } from './adapter.js';
import { sentOf } from './index.js';

// The SDK may pass its own prompt sentence (`title`) and subtitle (`description`).
function defaults(toolName, input, ctx) {
  return {
    title: ctx.title ?? `Claude wants to use ${toolName}`,
    details: [ctx.description, ctx.decisionReason, `Input:\n${json(input)}`].filter(Boolean).join('\n\n'),
  };
}

/**
 * A canUseTool callback that asks a person through Wayza.
 *
 *   query({ prompt, options: { canUseTool: wayzaCanUseTool({ to: 'you@example.com' }) } })
 *
 * Inline (default): waits for the answer, then allows or denies.
 * Durable (`mode: 'durable'`): sends the ask (use `callback`), calls `onPending`, and
 * denies with `interrupt: true` so the query stops. The SDK has no serialisable pause,
 * so you resume the session later (`options.resume = sessionId`) with
 * `allowApproved(answer, pending)` as canUseTool and `resumePrompt(answer)` as prompt.
 *
 * `when(toolName, input)` returning false lets a call through without asking.
 * @param {import('../index.js').ClaudeOptions} opts
 */
export function wayzaCanUseTool(opts) {
  return async (toolName, input, ctx = {}) => {
    if (opts.when && !(await opts.when(toolName, input))) return { behavior: 'allow', updatedInput: input };
    const wayza = client(opts);
    const item = { toolName, input, toolUseID: ctx.toolUseID };
    const ask = askOptions(opts, item, defaults(toolName, input, ctx), ctx.toolUseID ?? canonicalKey(toolName, input));
    if (opts.mode === 'durable') {
      const approval = await wayza.ask({ ...ask, signal: ctx.signal });
      const pending = { ...(await sentOf(approval)), toolName, input, toolUseID: ctx.toolUseID ?? null };
      await opts.onPending?.(pending, approval);
      return {
        behavior: 'deny',
        interrupt: true,
        message: `Waiting for a person to approve ${toolName} via Wayza (approval ${approval.id}). Stop here; the session will resume when they answer.`,
      };
    }
    const answer = await wayza.askAndWait({ ...ask, waitTimeout: opts.waitTimeout, signal: ctx.signal });
    return decide(opts, answer)
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: denial(answer) };
  };
}

/**
 * Durable resume: a canUseTool that allows exactly the approved call (same tool and
 * input) when the answer says yes, and hands everything else to `fallback`
 * (default: ask again through Wayza with `opts`, or deny if no opts). The answer is
 * verified against your home (`fallback.wayza`/`fallback.home`, default wayza.com)
 * and checked against the saved ask first.
 *
 *   options.canUseTool = await allowApproved(answer, pending, { to: 'you@example.com' })
 *
 * @param {any} answer a result from handleCallback() for pending.id
 * @param {{ id: any, request: string, asked_by: string, toolName: string, input: any }} pending
 * @param {import('../index.js').ClaudeOptions | ((toolName: string, input: any, ctx: any) => Promise<any>)} [fallback]
 * @param {{ wayza?: any, home?: string, insecure?: boolean, requirePerson?: boolean }} [check] where to verify, when fallback is not an options object
 */
export async function allowApproved(answer, pending, fallback, check = {}) {
  const opts = { ...(typeof fallback === 'object' ? fallback : {}), ...check };
  await checked(opts, pending, answer);
  const approved = decide(opts, answer);
  const key = canonicalKey(pending.toolName, pending.input);
  const next = typeof fallback === 'function' ? fallback
    : fallback ? wayzaCanUseTool(fallback)
      : async (toolName) => ({ behavior: 'deny', message: `${toolName} was not approved via Wayza.` });
  let used = false;
  return async (toolName, input, ctx) => {
    if (!used && approved && canonicalKey(toolName, input) === key) {
      used = true;
      return { behavior: 'allow', updatedInput: input };
    }
    return next(toolName, input, ctx);
  };
}

/** A prompt for resuming the session after the person answered. */
export function resumePrompt(answer, pending) {
  const tool = pending?.toolName ?? 'the tool';
  return decide({}, answer)
    ? `The person approved ${tool} via Wayza${answer.answeredBy ? ` (${answer.answeredBy})` : ''}. Continue: run it now with the same input.`
    : `The request to use ${tool} was not approved: ${denial(answer)} Do not retry it; continue without it.`;
}
