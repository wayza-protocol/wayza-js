import type { AdapterOptions, Duration, PlainResult, Result } from '../index.js';

export function askHuman(ctx: any, opts: AdapterOptions & { title: string; waitTimeout?: Duration }): Promise<PlainResult>;
/** Returns null after suspending; the result once resumed. */
export function wayzaGate(ctx: any, opts: AdapterOptions & { title: string }): Promise<PlainResult | null>;
export function resumeFromWayza(workflowOrRun: any, answer: Result | PlainResult, opts?: { runId?: string; step?: any }): Promise<any>;
