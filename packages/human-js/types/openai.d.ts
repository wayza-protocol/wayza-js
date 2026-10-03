import type { AdapterOptions, Duration, PlainResult, Result, Sent } from '../index.js';

export interface OpenAIPending extends Sent { callId: string | null }

/** Ask about each interruption, wait, approve/reject, return the state for run(agent, state). */
export function approveWithWayza<S = any>(result: { state: S; interruptions?: any[] } | S, opts: AdapterOptions & { waitTimeout?: Duration }): Promise<S>;
/** Send the asks and return the serialised RunState plus pending asks to save. */
export function sendForApproval(result: { state: { toString(): string }; interruptions?: any[] }, opts: AdapterOptions): Promise<{ state: string; pending: OpenAIPending[] }>;
/** Apply answers to a restored RunState once every ask has settled. */
export function resumeFromWayza<S = any>(state: S, pending: OpenAIPending[], opts?: AdapterOptions & { answers?: Result[] }): Promise<{ ready: boolean; state: S; waiting: OpenAIPending[]; results: PlainResult[] }>;
