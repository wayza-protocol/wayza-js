import type { ClaudeOptions, ClaudePending, Result } from '../index.js';

export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean };
export type CanUseTool = (toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal; toolUseID: string; [k: string]: unknown }) => Promise<PermissionResult>;

export function wayzaCanUseTool(opts: ClaudeOptions): CanUseTool;
export function allowApproved(answer: Result, pending: ClaudePending, fallback?: ClaudeOptions | CanUseTool, check?: { wayza?: any; home?: string; insecure?: boolean; requirePerson?: boolean }): Promise<CanUseTool>;
export function resumePrompt(answer: Result, pending?: ClaudePending): string;
export type { ClaudeOptions, ClaudePending };
