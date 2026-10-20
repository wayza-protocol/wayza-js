// This agent's Wayza address: a key from the caller, WAYZA_KEY, or a file; signed up on first use.
import { Wayza } from './index.js';

// Node's file modules load only when a key is read from or saved to a file, so the tools also load on edge runtimes.
export const DEFAULT_KEY_FILE = '~/.wayza/ai-sdk.json';
const expand = async (p) => (p.startsWith('~/') ? (await import('node:path')).join((await import('node:os')).homedir(), p.slice(2)) : p);

const env = (k) => globalThis.process?.env?.[k] || undefined;

/** Where a saved key would not survive the next start, so signing up there would make a new address each time. */
export function hostedServer() {
  return ['VERCEL', 'AWS_LAMBDA_FUNCTION_NAME', 'NETLIFY', 'K_SERVICE', 'FUNCTION_TARGET', 'FUNCTIONS_WORKER_RUNTIME', 'RENDER', 'FLY_APP_NAME', 'RAILWAY_ENVIRONMENT']
    .find((k) => env(k)) ?? null;
}

export class NoKeyError extends Error {}

export class WayzaAccount {
  /**
   * @param {{ key?: string, name?: string, home?: string, keyFile?: string, signUp?: boolean, fetch?: typeof fetch }} [opts]
   */
  constructor({ key, name = 'AI SDK agent', home, keyFile, signUp = true, fetch: f } = {}) {
    this.home = (home ?? env('WAYZA_HOME') ?? 'https://wayza.com').replace(/\/+$/, '');
    this.name = name;
    this.keyFile = keyFile ?? DEFAULT_KEY_FILE;
    this.signUpAllowed = signUp;
    this.fetch = f;
    this.key = key ?? env('WAYZA_KEY') ?? null;
    this.saved = {};
    this.fresh = null;
    /** @type {Promise<Wayza> | null} */
    this.pending = null;
  }

  async #load() {
    try {
      const { readFile } = await import('node:fs/promises');
      const d = JSON.parse(await readFile(await expand(this.keyFile), 'utf8'));
      return d && typeof d === 'object' && (d.home ?? this.home).replace(/\/+$/, '') === this.home ? d : {};
    } catch { return {}; }
  }

  async #save(d) {
    const [{ writeFile, mkdir, chmod }, { dirname }] = await Promise.all([import('node:fs/promises'), import('node:path')]);
    const file = await expand(this.keyFile);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(d, null, 2), { mode: 0o600 });
    await chmod(file, 0o600);
  }

  /** The client for this agent's address, signing up first if there is no key yet. */
  client() {
    this.pending ??= this.#open().catch((e) => { this.pending = null; throw e; });
    return this.pending;
  }

  async #open() {
    if (!this.key) {
      this.saved = await this.#load();
      this.key = this.saved.key ?? null;
    }
    if (!this.key) {
      if (!this.signUpAllowed) throw new NoKeyError('No Wayza key: pass { key }, set WAYZA_KEY, or allow signUp.');
      const where = hostedServer();
      if (where) {
        throw new NoKeyError(`This agent has no Wayza key, and on a hosted server (${where} is set) a saved key is lost at the next start, `
          + 'so it would get a new address every time. Run "npx @wayza/human sign-up" once on your own computer and set the '
          + 'WAYZA_KEY it prints in this server\'s environment.');
      }
      const out = await Wayza.signUp({ name: this.name, platform: 'ai-sdk', deployKey: env('WAYZA_DEPLOY_KEY'), home: this.home, fetch: this.fetch });
      this.saved = { address: out.address, full_address: out.fullAddress, card: out.card, claim_link: out.claimLink, home: this.home, key: out.key };
      await this.#save(this.saved);
      this.key = out.key;
      this.fresh = { ...this.saved, tell_your_person: out.tell_your_person };
    }
    return new Wayza({ key: this.key, home: this.home, fetch: this.fetch });
  }

  /** After a sign-up in this run, the note for the person, once. */
  newAddressNote() {
    const fresh = this.fresh;
    this.fresh = null;
    if (!fresh) return null;
    return clean({
      address: fresh.address,
      full_address: fresh.full_address,
      claim_link: fresh.claim_link,
      next: 'This agent just got its own Wayza address. Give your person the claim_link privately: opening it while signed in '
        + 'to Wayza makes this agent theirs. Never post it anywhere public.',
      tell_your_person: fresh.tell_your_person,
    });
  }

  /** This agent's address, and the claim link if it signed up from here. */
  async summary() {
    await this.client();
    const d = this.saved ?? {};
    return clean({
      address: d.address, full_address: d.full_address, card: d.card, claim_link: d.claim_link, home: this.home,
      note: !d.address ? 'This agent uses a key it was given, so its address isn\'t saved here; it is on the Wayza account page that made the key.'
        : d.claim_link ? 'The claim_link is for your person only, privately. Once they have claimed this agent it does nothing.' : undefined,
    });
  }
}

export function clean(v) {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x != null).map(([k, x]) => [k, clean(x)]));
  return v;
}
