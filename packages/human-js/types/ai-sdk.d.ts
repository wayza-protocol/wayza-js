import type { Tool } from 'ai';
import type { Wayza } from '../index.js';

export interface WayzaToolsOptions {
  /** A Wayza key (fam_...). Default: WAYZA_KEY, then the key saved in keyFile. */
  key?: string;
  /** The agent's name, used when it signs up. Default "AI SDK agent". */
  name?: string;
  /** Default: WAYZA_HOME, then https://wayza.com. */
  home?: string;
  /** Where a key from sign-up is saved, readable only by you. Default ~/.wayza/ai-sdk.json (~ is your home folder). */
  keyFile?: string;
  /** Sign up on first use when there is no key. Default true; never on a hosted server. */
  signUp?: boolean;
  fetch?: typeof fetch;
  /** Share one address between several tool sets. */
  account?: WayzaAccount;
}

export type WayzaToolName =
  | 'wayza_ask_person' | 'wayza_check_answer' | 'wayza_ask_by_link' | 'wayza_read_link'
  | 'wayza_answer_link' | 'wayza_send_message' | 'wayza_read_messages' | 'wayza_my_address';

export function wayzaTools(opts?: WayzaToolsOptions): Record<WayzaToolName, Tool<any, any>>;

export class WayzaAccount {
  constructor(opts?: Omit<WayzaToolsOptions, 'account'>);
  readonly home: string;
  readonly keyFile: string;
  client(): Promise<Wayza>;
  newAddressNote(): Record<string, string> | null;
  summary(): Promise<Record<string, string>>;
}

/** The environment variable that shows this runs on a hosted server, or null. */
export function hostedServer(): string | null;
export const DEFAULT_KEY_FILE: string;
