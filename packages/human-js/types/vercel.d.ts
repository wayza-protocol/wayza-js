import type { AdapterOptions, Duration, PlainResult, Result, Sent } from '../index.js';

export interface ToolApprovalResponse { type: 'tool-approval-response'; approvalId: string; approved: boolean; reason?: string }
export interface ToolMessage { role: 'tool'; content: ToolApprovalResponse[] }
export interface VercelPending extends Sent { approvalId: string; toolName: string | null }

export function approvalRequests(result: { content?: any[] }): any[];
/** Returns [] or one tool message to append to your messages. */
export function wayzaApprovals(result: { content?: any[] }, opts: AdapterOptions & { waitTimeout?: Duration }): Promise<ToolMessage[]>;
export function sendForApproval(result: { content?: any[] }, opts: AdapterOptions): Promise<{ pending: VercelPending[] }>;
export function resumeFromWayza(pending: VercelPending[], opts?: AdapterOptions & { answers?: Result[] }): Promise<{ ready: boolean; messages: ToolMessage[]; waiting: VercelPending[]; results: PlainResult[] }>;
