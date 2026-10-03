import type { AdapterOptions, Duration, PlainResult, Result, Sent } from '../index.js';

export interface LangGraphPending extends Sent { interruptId: string | null }
export interface WayzaInterruptAsk { title: string; details?: string; choices?: string[]; freeText?: boolean; to?: string | string[]; needs?: 'any' | 'all' }

export function askHuman(opts: AdapterOptions & { title: string; waitTimeout?: Duration }, config?: any): Promise<PlainResult>;
export function wayzaInterrupt(ask: WayzaInterruptAsk): { wayza: WayzaInterruptAsk };
export function sendForApproval(result: { __interrupt__?: Array<{ id?: string; value?: any }> }, opts: AdapterOptions, config?: any): Promise<{ pending: LangGraphPending[] }>;
export function resumeFromWayza(pending: LangGraphPending[], opts?: AdapterOptions & { answers?: Result[] }): Promise<{ ready: boolean; resume: PlainResult | Record<string, PlainResult> | undefined; waiting: LangGraphPending[] }>;
