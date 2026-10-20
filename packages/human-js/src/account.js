// This agent's Wayza address: a key from the caller, WAYZA_KEY, or a file; signed up on first use.
import { Wayza } from './index.js';

// Node's file modules load only when a key is read from or saved to a file, so the tools also load on edge runtimes.
export const DEFAULT_KEY_FILE = '~/.wayza/ai-sdk.json';
const expand = async (p) => (p.startsWith('~/') ? (await import(/* webpackIgnore: true */ 'node:path')).join((await import(/* webpackIgnore: true */ 'node:os')).homedir(), p.slice(2)) : p);

const env = (k) => globalThis.process?.env?.[k] || undefined;

const HOSTED = ['VERCEL', 'AWS_LAMBDA_FUNCTION_NAME', 'AWS_EXECUTION_ENV', 'ECS_CONTAINER_METADATA_URI_V4', 'NETLIFY', 'K_SERVICE',
  'FUNCTION_TARGET', 'GAE_SERVICE', 'FUNCTIONS_WORKER_RUNTIME', 'WEBSITE_INSTANCE_ID', 'KUBERNETES_SERVICE_HOST', 'DYNO', 'RENDER',
  'FLY_APP_NAME', 'RAILWAY_ENVIRONMENT', 'DENO_DEPLOYMENT_ID', 'SPACE_ID', 'CI', 'GITHUB_ACTIONS'];

/**
 * What shows this runs on a hosted server, an edge runtime or in a container, where a saved key may not last, so
 * signing up there would make a new address each time; or null.
 */
export async function hostedServer() {
  if (env('WAYZA_SIGN_UP') === '1') return null;   // this machine keeps its files: sign up here anyway
  const found = HOSTED.find((k) => env(k));
  if (found) return found;
  if (globalThis.navigator?.userAgent === 'Cloudflare-Workers' || globalThis.EdgeRuntime) return 'an edge runtime';
  if (!globalThis.process?.versions?.node) return 'a runtime without files';
  try {
    const { existsSync } = await import(/* webpackIgnore: true */ 'node:fs');
    if (existsSync('/.dockerenv')) return 'a container (/.dockerenv)';
  } catch { /* no file system */ }
  return null;
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
      const { readFile } = await import(/* webpackIgnore: true */ 'node:fs/promises');
      const d = JSON.parse(await readFile(await expand(this.keyFile), 'utf8'));
      return d && typeof d === 'object' && (d.home ?? this.home).replace(/\/+$/, '') === this.home ? d : {};
    } catch { return {}; }
  }

  async #save(d) {
    const [{ writeFile, mkdir, chmod }, { dirname }] = await Promise.all([import(/* webpackIgnore: true */ 'node:fs/promises'), import(/* webpackIgnore: true */ 'node:path')]);
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
      const where = await hostedServer();
      if (where) {
        throw new NoKeyError(`This agent has no Wayza key, and on a hosted server (${where}) a saved key can be lost at the next start, `
          + 'so it would get a new address every time. Run "npx @wayza/human sign-up" once on your own computer and set the '
          + 'WAYZA_KEY it prints in this server\'s environment. If this machine does keep its files, set WAYZA_SIGN_UP=1 instead.');
      }
      const out = await Wayza.signUp({ name: this.name, platform: 'ai-sdk', deployKey: env('WAYZA_DEPLOY_KEY'), home: this.home, fetch: this.fetch });
      this.saved = { address: out.address, full_address: out.fullAddress, card: out.card, claim_link: out.claimLink, home: this.home, key: out.key, name: this.name };
      this.key = out.key;
      this.fresh = { ...this.saved, tell_your_person: out.tell_your_person };
      try {
        await this.#save(this.saved);
      } catch (e) {
        // Keep the key for this run rather than signing up again on the next call.
        this.fresh.not_saved = `The key could not be saved to ${this.keyFile} (${e.code ?? e.message}), so this address lasts only while `
          + 'this program runs. To keep one, run "npx @wayza/human sign-up" and set WAYZA_KEY.';
      }
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
      not_saved: fresh.not_saved,
    });
  }

  /** This agent's address. Never the claim link: that was given to the person once, at sign-up. */
  async summary() {
    await this.client();
    const d = this.saved ?? {};
    return clean({
      address: d.address, full_address: d.full_address, card: d.card, home: this.home,
      note: !d.address ? 'This agent uses a key it was given, so its address isn\'t saved here; it is on the Wayza account page that made the key.'
        : d.claim_link ? `The claim link was given to your person once, when this agent signed up; it is also saved in ${this.keyFile} on this computer. Never share it with anyone else.` : undefined,
    });
  }
}

export function clean(v) {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x != null).map(([k, x]) => [k, clean(x)]));
  return v;
}
