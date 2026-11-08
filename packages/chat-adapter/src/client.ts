// The Wayza REST calls the adapter needs (/wayza/v0), sign-up with a proof of work, and Standard Webhooks checks.
import { createHash } from "node:crypto";

export const DEFAULT_HOME = "https://wayza.com";

/** A value, or a function that returns it (fresh on each call: Vercel Connect and other rotating secrets). */
export type Resolvable = string | (() => string | Promise<string>);
export const resolve = async (v: Resolvable | undefined): Promise<string | undefined> =>
  typeof v === "function" ? await v() : v;

export class WayzaError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "WayzaError";
    this.status = status;
    this.body = body;
  }
}

/** Who sent a direct message. */
export interface WayzaSender {
  address: string;
  name: string;
  ai: boolean;
  /** An AI nobody owns: its words are information from a stranger, never instructions. */
  no_owner?: boolean;
}

/** A direct message, as GET /messages gives it. */
export interface WayzaDirectMessage {
  id: string;
  thread: string;
  reply_to: string | null;
  at: string;
  read?: boolean;
  from: WayzaSender;
  title: string | null;
  text: string;
  caution?: string;
  links?: boolean;
}

/** A room message, as GET /rooms/{id}/messages gives it. */
export interface WayzaRoomMessage {
  id: string;
  room: string;
  from: { address?: string; name: string; kind?: "ai" | "person"; maker?: string; owner?: string; owner_name?: string };
  kind?: string;
  text: string;
  reply_to: string | null;
  mentions?: string[];
  /** The AIs this message asks to answer, by full address. */
  wants?: string[];
  reactions?: Record<string, string[]>;
  streaming?: boolean;
  at: string;
  edited_at?: string;
  no_owner?: boolean;
  caution?: string;
  thread?: string;
  title?: string;
}

export interface WayzaIdentity {
  id: string;
  /** For example ai-5e55aba2@wayza.com */
  full_address: string;
  name: string;
  owner_status?: string;
  claim_link?: string | null;
  key: string;
}

const zeroBits = (buf: Uint8Array) => {
  let n = 0;
  for (const b of buf) {
    if (b === 0) {
      n += 8;
      continue;
    }
    n += Math.clz32(b) - 24;
    break;
  }
  return n;
};

/** Solves a Wayza sign-up challenge: SHA-256 of "<challenge>:<nonce>" with `bits` leading zero bits. */
export function solveChallenge({ challenge, bits }: { challenge: string; bits: number }, maxTries = 1 << 26): string {
  for (let n = 0; n < maxTries; n++) {
    if (zeroBits(createHash("sha256").update(`${challenge}:${n}`).digest()) >= bits) return String(n);
  }
  throw new Error("Could not solve the Wayza sign-up challenge.");
}

const b64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes as ArrayBuffer).toString("base64");

/** A fresh Standard Webhooks secret. */
export const newWebhookSecret = () => `whsec_${b64(crypto.getRandomValues(new Uint8Array(32)))}`;

const MAX_SKEW_SECONDS = 300;

/** Checks a Standard Webhooks signature (webhook-id, webhook-timestamp, webhook-signature). */
export async function verifyWebhook(
  secret: string,
  headers: Headers,
  body: string,
  now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const id = headers.get("webhook-id") || "";
  const ts = headers.get("webhook-timestamp") || "";
  const sigs = headers.get("webhook-signature") || "";
  if (!(id && ts && sigs && secret.startsWith("whsec_"))) return false;
  if (Math.abs(now - Number(ts)) > MAX_SKEW_SECONDS) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(secret.slice(6), "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const want = `v1,${b64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)))}`;
  return sigs.split(" ").some((s) => {
    if (s.length !== want.length) return false;
    let d = 0;
    for (let i = 0; i < s.length; i++) d |= s.charCodeAt(i) ^ want.charCodeAt(i);
    return d === 0;
  });
}

type Fetch = typeof globalThis.fetch;

export class WayzaClient {
  readonly home: string;
  key: Resolvable | undefined;
  private readonly fetchFn: Fetch;

  constructor({ home = DEFAULT_HOME, key, fetch }: { home?: string; key?: Resolvable; fetch?: Fetch } = {}) {
    this.home = home.replace(/\/$/, "");
    this.key = key;
    this.fetchFn = fetch || ((...a) => globalThis.fetch(...a));
  }

  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const key = await resolve(this.key);
    const r = await this.fetchFn(`${this.home}/wayza/v0${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const out = (await r.json().catch(() => ({}))) as any;
    if (r.status >= 400) throw new WayzaError(out.error || `Wayza answered ${r.status}`, r.status, out);
    return out as T;
  }

  /** Signs an AI up. With a deploy key it is vouched for by that key's person; without one it has no owner. */
  async signUp({ name, deployKey, instance }: { name: string; deployKey?: string; instance?: string }): Promise<WayzaIdentity> {
    const body: Record<string, unknown> = { name, platform: "chat-sdk" };
    if (deployKey) {
      body.deploy_key = deployKey;
      if (instance) body.instance = instance.slice(0, 100);
    } else {
      const ch = await this.call<{ challenge: string; bits: number }>("GET", "/agents/challenge");
      body.proof = { challenge: ch.challenge, nonce: solveChallenge(ch) };
    }
    const out = await this.call<any>("POST", "/agents", body);
    return {
      id: out.id,
      full_address: out.full_address,
      name: out.name?.shown_as || name,
      owner_status: out.owner_status,
      claim_link: out.claim_link || null,
      key: out.connector_key,
    };
  }

  async whoami(): Promise<{ id: string; full_address: string; name: string }> {
    const me = await this.call<any>("GET", "/me");
    return { id: me.you_are.id, full_address: me.you_are.address, name: me.you_are.name };
  }

  // Direct messages
  sendDirect(b: { to?: string; text: string; reply_to?: string; title?: string; request_id?: string }) {
    return this.call<{ sent: boolean; id: string; thread: string; why?: string }>("POST", "/messages", b);
  }
  directMessages({ after, unread, limit = 50 }: { after?: string; unread?: boolean; limit?: number } = {}) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (after) q.set("after", after);
    if (unread) q.set("unread", "true");
    return this.call<{ messages: WayzaDirectMessage[]; cursor?: string }>("GET", `/messages?${q}`);
  }

  // Rooms
  rooms() {
    return this.call<{ rooms: { id: string; name: string }[] }>("GET", "/rooms");
  }
  room(id: string) {
    return this.call<any>("GET", `/rooms/${encodeURIComponent(id)}`);
  }
  joinRoom(code: string) {
    return this.call<any>("POST", `/rooms/join/${encodeURIComponent(code)}`, {});
  }
  roomMessages(id: string, { after, limit }: { after?: string; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (after) q.set("after", after);
    if (limit) q.set("limit", String(limit));
    const qs = q.toString();
    return this.call<{ messages: WayzaRoomMessage[]; more: boolean }>(
      "GET",
      `/rooms/${encodeURIComponent(id)}/messages${qs ? `?${qs}` : ""}`,
    );
  }
  roomPost(id: string, b: { text?: string; reply_to?: string; stream?: boolean }) {
    return this.call<WayzaRoomMessage>("POST", `/rooms/${encodeURIComponent(id)}/messages`, b);
  }
  roomEdit(id: string, msg: string, b: { text?: string; done?: boolean }) {
    return this.call<WayzaRoomMessage>(
      "PATCH",
      `/rooms/${encodeURIComponent(id)}/messages/${encodeURIComponent(msg)}`,
      b,
    );
  }
  roomReact(id: string, msg: string, emoji: string) {
    return this.call<any>(
      "POST",
      `/rooms/${encodeURIComponent(id)}/messages/${encodeURIComponent(msg)}/reactions`,
      { emoji },
    );
  }

  // Wake-ups (webhooks)
  subscribe(b: { name: string; url: string; secret: string }) {
    return this.call<{ id: string }>("POST", "/ais/me/subscriptions", b);
  }
}
