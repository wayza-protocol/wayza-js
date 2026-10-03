/** This package's version; requests send `User-Agent: wayza-human-js/<version>`. */
export const VERSION: string;

export type Status = 'waiting' | 'approved' | 'declined' | 'answered' | 'expired' | 'cancelled';
export type Decision = 'waiting' | 'approved' | 'declined' | 'answered';
/** Who answered: a person, an AI acting for its person, an AI, an AI with no owner, or an emailed link. */
export type AnsweredAs = 'person' | 'ai-on-behalf' | 'ai' | 'ai-unclaimed' | 'email-link';
export type Duration = string | number;

export interface Person {
  to: string; person?: string | null; decision: Decision;
  choice?: string | null; text?: string | null; as?: AnsweredAs | null; at?: string | null;
}

export interface SignedAnswer {
  v: 1; type: 'wayza.answer'; approval: string; request: string; asked_by: string;
  status: Status;
  answers: Array<{ to: string; decision: Decision; choice: string | null; text: string | null;
    answered_by: string | null; as: AnsweredAs | null; attested?: string; at: string | null }>;
  at: string; home: string;
  sig: { kid: string; alg: 'Ed25519'; value: string };
}

export interface Approval {
  id: number | string; title: string; details?: string | null; status: Status;
  choices?: string[] | null; free_text?: boolean; request_id?: string | null; expires_at?: string | null;
  asked_by?: string; asked_by_address?: string; from_ai_with_no_owner?: boolean;
  people: Person[]; signed_answer?: SignedAnswer;
}

export interface ReplyOptions { decision: 'approved' | 'declined' | 'answered'; choice?: string; text?: string; note?: string }

export interface AskTool {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
  execute(args: ReplyOptions): Promise<Approval>;
}

export interface Answer {
  to: string; decision: Decision; choice: string | null; text: string | null;
  answered_by: string | null; as: AnsweredAs | null; at: string | null;
}

export interface Result {
  id: number | string | null;
  /** true for approved, false for declined, null otherwise (answered, expired, cancelled, waiting). */
  approved: boolean | null;
  status: Status;
  choice: string | null;
  text: string | null;
  answeredBy: string | null;
  /**
   * How the answer was given: "person" (in the app) or "email-link" mean a person said so;
   * "ai-on-behalf" (the person's own AI), "ai" (an agent answering for itself) and
   * "ai-unclaimed" (an AI nobody owns) mean an AI did. Check this before acting.
   */
  as: AnsweredAs | null;
  /** true when the signed answer was also checked against the ask you sent (expect, sentOf, or waitFor given the approval). false: only the signature was checked. */
  checked: boolean;
  /** true when as is "person" or "email-link". */
  byPerson: boolean;
  /** Set by the adapters when an AI answered and a person was required. */
  refused?: string;
  answers: Answer[];
  approval: Approval | null;
  signedAnswer: SignedAnswer | null;
}

export interface AskOptions {
  /** Addresses, @handles or emails; another agent's address works too. */
  to: string | string[];
  title: string;
  details?: string;
  choices?: string[];
  freeText?: boolean;
  needs?: 'any' | 'all';
  /** Idempotency key: a repeat returns the same approval. */
  requestId?: string;
  /** When no requestId is given, one is derived from hash(title, to, runId). */
  runId?: string | number;
  expiresAt?: Date | string;
  /** Alternative to expiresAt: '24h', '30m', or ms. */
  timeout?: Duration;
  /** https URL the home POSTs the result to once settled. */
  callback?: string;
  signal?: AbortSignal;
}

export interface AskAndWaitOptions extends AskOptions {
  /** How long to wait; defaults to the ask's expiry. */
  waitTimeout?: Duration;
  /** Cancel the ask if the wait ends with nobody answering. Default true. */
  cancelOnTimeout?: boolean;
}

export interface WayzaOptions {
  /** Defaults to process.env.WAYZA_KEY. */
  key?: string;
  /** Defaults to https://wayza.com. */
  home?: string;
  fetch?: typeof fetch;
  /** Accept http:// approval URLs when verifying (local dev). Defaults to true for an http:// home. */
  insecure?: boolean;
}

export class Wayza {
  constructor(opts?: WayzaOptions);
  readonly key: string;
  readonly home: string;
  readonly base: string;
  readonly insecure: boolean;
  ask(opts: AskOptions): Promise<Approval>;
  get(id: number | string | { id: number | string }, opts?: { wait?: number; signal?: AbortSignal }): Promise<Approval>;
  cancel(id: number | string | { id: number | string }): Promise<Approval>;
  waitFor(id: number | string | Approval, opts?: { timeout?: Duration; signal?: AbortSignal }): Promise<Result>;
  askAndWait(opts: AskAndWaitOptions): Promise<Result>;
  /** Asks waiting on this agent or its person (GET /approvals -> waiting_for_your_person). */
  inbox(opts?: { forPerson?: boolean }): Promise<Approval[]>;
  /** Answer, as this agent, an ask addressed to it by another agent. */
  reply(id: number | string | { id: number | string }, answer: ReplyOptions): Promise<Approval>;
  /** Answer for this agent's person (needs the "approve" scope). */
  decide(id: number | string | { id: number | string }, answer: ReplyOptions): Promise<Approval>;
  /** Verify a signed answer against this client's home. */
  verify(signedAnswer: SignedAnswer): Promise<true>;
}

/** Turn an incoming ask into a tool the agent can call to answer it. */
export function askAsTool(ask: Approval, opts: { wayza: Wayza; onBehalf?: boolean }): AskTool;

export class WayzaError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status?: number, body?: unknown);
}
export class WayzaVerifyError extends Error {}

export interface VerifyOptions {
  /** The home you trust; the record must be signed by it. Default https://wayza.com. null skips the check (then check record.home yourself). */
  home?: string | null;
  fetch?: typeof fetch;
  insecure?: boolean;
}
/** What to save about an ask to check its answer later. */
export interface Sent { id: number | string; request: string; asked_by: string }
/** Resolves true or throws WayzaVerifyError. */
export function verify(signedAnswer: SignedAnswer, opts?: VerifyOptions): Promise<true>;
/** Parse and verify a callback POST (a fetch Request, or { body }). Pass your client (or home), and `expect` to tie it to the ask you sent. */
export function handleCallback(input: Request | { body: unknown }, opts?: VerifyOptions & { wayza?: Wayza; expect?: Approval | Sent }): Promise<Result>;
/** The fingerprint of an ask, as the home signs it in the record's `request`. */
export function requestFingerprint(approval: Approval): Promise<string>;
/** { id, request, asked_by } for an ask, to save with a paused run. */
export function sentOf(approval: Approval): Promise<Sent>;
/** Throws WayzaVerifyError unless the signed answer is for this ask (same approval, asker and question). */
export function checkAnswer(signedAnswer: SignedAnswer, sent: Approval | Sent): Promise<true>;
/** The `as` values that mean a person answered. */
export const PERSON: ReadonlySet<AnsweredAs>;

export function canonical(value: unknown): string;
export function parseDuration(t: Duration): number;
export function sha256Hex(s: string): Promise<string>;
export function stableRequestId(p: { title: string; to?: string | string[]; runId: string | number }): Promise<string>;
export function isSettled(approval: unknown): boolean;
export function toResult(approval: Approval | null, signedAnswer?: SignedAnswer): Result;
export function clearKeyCache(): void;

/** Options shared by the framework adapters. title/details may be functions of the framework item. */
export interface AdapterOptions extends Partial<Omit<AskOptions, 'title' | 'details' | 'requestId'>> {
  wayza?: Wayza;
  key?: string;
  home?: string;
  fetch?: typeof fetch;
  insecure?: boolean;
  title?: string | ((item: any) => string);
  details?: string | ((item: any) => string);
  requestId?: string | ((item: any) => string);
  /** Map a result to allow/deny. Default: result.approved === true from a person. */
  decide?: (result: Result) => boolean;
  /** Only a person's answer (as "person" or "email-link") counts; an AI's yes is treated as no. Default true. */
  requirePerson?: boolean;
}

/** A Result without the raw approval object: JSON-safe, for framework resume payloads. */
export type PlainResult = Omit<Result, 'approval'>;

export interface ClaudeOptions extends AdapterOptions {
  mode?: 'inline' | 'durable';
  waitTimeout?: Duration;
  when?: (toolName: string, input: Record<string, unknown>) => boolean | Promise<boolean>;
  onPending?: (pending: ClaudePending, approval: Approval) => void | Promise<void>;
}
export interface ClaudePending extends Sent { toolName: string; input: Record<string, unknown>; toolUseID: string | null }
