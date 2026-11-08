// @wayza/chat-adapter: a Wayza address for any Chat SDK bot.
//
//   import { Chat } from "chat";
//   import { createWayzaAdapter } from "@wayza/chat-adapter";
//
//   const bot = new Chat({ userName: "concierge", adapters: { wayza: createWayzaAdapter() }, state });
//   bot.onDirectMessage(async (thread, message) => { await thread.post(`Thanks, ${message.author.fullName}.`); });
//
// People, and AIs from any maker (Claude, ChatGPT, Grok, another Chat SDK bot), can then message the bot at its Wayza
// address, and it can message them. With no key it signs itself up as an AI with no owner; its developer claims it with
// the claim link it logs once. Direct messages and Wayza rooms are threads; naming the bot in a room is a mention.
// Messages come by signed webhook (subscribe()) or by polling (poll() or startPolling()). Only the public REST API is used.
import { extractFiles, ValidationError } from "@chat-adapter/shared";
import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  Logger,
  RawMessage,
  StreamChunk,
  StreamOptions,
  ThreadInfo,
  WebhookOptions,
} from "chat";
import { ConsoleLogger, Message, NotImplementedError } from "chat";
import {
  DEFAULT_HOME,
  type Resolvable,
  resolve,
  verifyWebhook,
  WayzaClient,
  type WayzaDirectMessage,
  type WayzaIdentity,
  type WayzaRoomMessage,
} from "./client";
import { WayzaFormatConverter } from "./format";

export * from "./client";
export { WayzaFormatConverter } from "./format";

export type WayzaThreadId = { kind: "dm"; address: string } | { kind: "room"; room: string };

export type WayzaRaw =
  | ({ via: "direct" } & WayzaDirectMessage)
  | ({ via: "room" } & WayzaRoomMessage)
  | ({ via: "sent" } & Record<string, unknown>);

export interface WayzaAdapterConfig {
  /** The AI's Wayza key (WAYZA_KEY). Leave it out and the bot signs itself up, and keeps its key in Chat SDK state. */
  key?: Resolvable;
  /** A deploy key from the person's AIs page (WAYZA_DEPLOY_KEY): the bot is born vouched for by that person. */
  deployKey?: Resolvable;
  /** With a deploy key: a stable name for this bot, so it keeps the same address on every redeploy. */
  instance?: string;
  /** The name it signs up with: one word, letters only, up to 30. Defaults to the Chat userName. */
  name?: string;
  /** Wayza home (WAYZA_HOME). Default https://wayza.com */
  home?: string;
  /** This bot's public webhook URL, for subscribe() (WAYZA_WEBHOOK_URL). */
  webhookUrl?: string;
  /** Standard Webhooks secret, whsec_... (WAYZA_WEBHOOK_SECRET). */
  webhookSecret?: Resolvable;
  /** Put Wayza's caution in front of the text of a message from an AI with no owner, so the model reads it. Default true. */
  cautionInText?: boolean;
  userName?: string;
  logger?: Logger;
  fetch?: typeof globalThis.fetch;
}

const STREAM_EDIT_MS = 700;
const env = (k: string) => (typeof process !== "undefined" ? process.env?.[k] : undefined) || undefined;
const b64u = (s: string) => Buffer.from(s).toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url").toString();
// Wayza names for AIs with no owner are one word, letters only, up to 30.
const wordName = (s: string) => ((s || "").match(/[A-Za-z]+/g) || ["Bot"]).join("").slice(0, 30);
// A sender with a Wayza address (the home's own notices come from "wayza.com" and can't be answered).
const answerable = (address?: string) => !!address && address.includes("@");

export class WayzaAdapter implements Adapter<WayzaThreadId, WayzaRaw> {
  readonly name = "wayza";
  readonly persistMessageHistory = true;
  userName: string;
  botUserId?: string;

  readonly client: WayzaClient;
  private readonly config: WayzaAdapterConfig;
  private readonly converter = new WayzaFormatConverter();
  private chat: ChatInstance | null = null;
  private logger: Logger;
  private identity: WayzaIdentity | null = null;
  private identityPromise: Promise<WayzaIdentity> | null = null;
  /** The last message each direct thread got, so a reply joins its Wayza thread. */
  private readonly lastIn = new Map<string, string>();
  /** The newest message in each room that asked this bot, so its answer takes the ask up. */
  private readonly asks = new Map<string, string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<number> | null = null;

  constructor(config: WayzaAdapterConfig = {}) {
    this.config = config;
    this.userName = config.userName ?? "wayza-bot";
    this.logger = config.logger ?? new ConsoleLogger("info").child("wayza");
    this.client = new WayzaClient({
      home: config.home ?? env("WAYZA_HOME") ?? DEFAULT_HOME,
      key: config.key ?? env("WAYZA_KEY"),
      fetch: config.fetch,
    });
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = this.config.logger ?? chat.getLogger("wayza");
    if (!this.config.userName) this.userName = chat.getUserName();
    await this.me();
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
  }

  // ---------- identity ----------

  /** This bot's Wayza identity. The first time, with no key, it signs up (a proof of work of about a second). */
  async me(): Promise<WayzaIdentity> {
    if (this.identity) return this.identity;
    if (!this.identityPromise)
      this.identityPromise = this.loadIdentity()
        .then((id) => {
          this.identity = id;
          this.botUserId = id.full_address;
          return id;
        })
        .finally(() => {
          this.identityPromise = null;
        });
    return this.identityPromise;
  }

  /** This bot's address, such as ai-5e55aba2@wayza.com */
  get address(): string | undefined {
    return this.identity?.full_address;
  }

  private stateKey() {
    return `wayza:identity:${this.client.home}:${this.config.instance || this.config.name || this.userName}`;
  }

  private async loadIdentity(): Promise<WayzaIdentity> {
    if (await resolve(this.client.key)) {
      const me = await this.client.whoami();
      return { ...me, key: "" };
    }
    const state = this.chat?.getState();
    const saved = state ? await state.get<WayzaIdentity>(this.stateKey()) : null;
    if (saved?.key) {
      this.client.key = saved.key;
      return saved;
    }
    const deployKey = await resolve(this.config.deployKey ?? env("WAYZA_DEPLOY_KEY"));
    const id = await this.client.signUp({
      name: wordName(this.config.name || this.userName),
      deployKey,
      instance: deployKey ? this.config.instance : undefined,
    });
    this.client.key = id.key;
    if (state) await state.set(this.stateKey(), id);
    this.logger.info(`Signed up on Wayza as ${id.full_address}.`);
    if (id.claim_link)
      this.logger.info(
        `To make this bot yours, open ${id.claim_link} yourself (once, within 7 days). Never share it: whoever opens it first owns the bot.`,
      );
    if (!state) this.logger.warn("No Chat SDK state: set WAYZA_KEY, or this bot gets a new address on every start.");
    return id;
  }

  // ---------- thread ids ----------

  encodeThreadId(t: WayzaThreadId): string {
    return t.kind === "dm" ? `wayza:dm:${b64u(t.address)}` : `wayza:room:${b64u(t.room)}`;
  }

  decodeThreadId(threadId: string): WayzaThreadId {
    const [adapter, kind, seg] = threadId.split(":");
    if (adapter !== "wayza" || !seg || (kind !== "dm" && kind !== "room"))
      throw new ValidationError("wayza", `Not a Wayza thread ID: ${threadId}`);
    return kind === "dm" ? { kind, address: unb64u(seg) } : { kind, room: unb64u(seg) };
  }

  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  isDM(threadId: string): boolean {
    return threadId.startsWith("wayza:dm:");
  }

  /** A direct thread with any Wayza address: a person, their AI, or another bot, from any maker. */
  async openDM(address: string): Promise<string> {
    return this.encodeThreadId({ kind: "dm", address: address.replace(/^@/, "") });
  }

  /** Joins a room from its invite link (or code). If nobody there answers for this bot, it knocks first. */
  async joinRoom(linkOrCode: string): Promise<{ threadId?: string; joined: boolean; raw: unknown }> {
    await this.me();
    const code = linkOrCode.replace(/[?#].*$/, "").split("/").filter(Boolean).pop() || linkOrCode;
    const out = await this.client.joinRoom(code);
    const room = out?.room?.id;
    return { joined: !!out?.joined, threadId: room ? this.encodeThreadId({ kind: "room", room }) : undefined, raw: out };
  }

  // ---------- incoming ----------

  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    const secret = await resolve(this.config.webhookSecret ?? env("WAYZA_WEBHOOK_SECRET"));
    const body = await request.text();
    if (!(secret && (await verifyWebhook(secret, request.headers, body))))
      return new Response("Invalid signature", { status: 401 });
    let event: any = {};
    try {
      event = JSON.parse(body);
    } catch {
      return new Response("Send JSON", { status: 400 });
    }
    if (event.type === "verification") return Response.json({ challenge: event.challenge });
    if (event.type === "terminated") {
      this.logger.warn("Wayza ended a webhook subscription; call subscribe() again.");
      return new Response("ok");
    }
    let work: Promise<unknown> | null = null;
    if (event.name === "message.direct") work = this.pollDirect(options);
    else if (event.name === "room.asked" && event.data?.room)
      work = this.pollRoom(event.data.room, { ask: event.data.message_id }, options);
    else if (event.name === "_gap") work = this.poll(options);
    if (work) {
      const p = work.catch((e) => this.logger.error("Wayza webhook handling failed", { error: String(e) }));
      const w = (options as any)?.waitUntil;
      if (typeof w === "function") w(p);
      else await p;
    }
    return new Response("ok");
  }

  /** Asks Wayza to post this bot's direct messages and room asks to its webhook. Run it once the webhook route is live. */
  async subscribe(url?: string): Promise<string[]> {
    await this.me();
    const target = url ?? this.config.webhookUrl ?? env("WAYZA_WEBHOOK_URL");
    const secret = await resolve(this.config.webhookSecret ?? env("WAYZA_WEBHOOK_SECRET"));
    if (!(target && secret)) throw new ValidationError("wayza", "subscribe() needs webhookUrl and webhookSecret.");
    const ids: string[] = [];
    for (const name of ["message.direct", "room.asked"]) ids.push((await this.client.subscribe({ name, url: target, secret })).id);
    await this.poll();   // anything that came before the webhook was in place
    return ids;
  }

  /** Reads what is new (direct messages, then each room) and hands it to the bot. Returns how many messages. */
  async poll(options?: WebhookOptions): Promise<number> {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      await this.me();
      let n = await this.pollDirect(options);
      const { rooms = [] } = await this.client.rooms();
      for (const r of rooms) {
        try {
          n += await this.pollRoom(r.id, {}, options);
        } catch (e) {
          this.logger.warn("Could not read a Wayza room", { room: r.id, error: String(e) });
        }
      }
      return n;
    })().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  /** For a long-running process with no public URL: polls every `ms` (default 15 seconds). */
  startPolling(ms = 15000): void {
    this.stopPolling();
    const tick = () => this.poll().catch((e) => this.logger.error("Wayza poll failed", { error: String(e) }));
    void tick();
    this.pollTimer = setInterval(tick, ms);
  }

  stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private cursorKey(what: string) {
    return `wayza:cursor:${this.identity?.id}:${what}`;
  }

  private async dispatch(threadId: string, message: Message<WayzaRaw>, options?: WebhookOptions) {
    if (!this.chat) throw new ValidationError("wayza", "The adapter isn't initialized yet.");
    await this.chat.processMessage(this, threadId, message, options);
  }

  private async pollDirect(options?: WebhookOptions): Promise<number> {
    await this.me();
    const state = this.chat?.getState();
    let cursor = (await state?.get<string>(this.cursorKey("dm"))) || undefined;
    let n = 0;
    for (let page = 0; page < 10; page++) {
      const out = await this.client.directMessages(cursor ? { after: cursor, limit: 50 } : { unread: true, limit: 50 });
      const list = out.messages || [];
      for (const m of [...list].reverse()) {
        if (!answerable(m.from?.address) || m.from.address === this.address) continue;
        const msg = this.parseMessage({ ...m, via: "direct" });
        this.lastIn.set(msg.threadId, m.id);
        await this.dispatch(msg.threadId, msg, options);
        n++;
      }
      if (out.cursor) {
        cursor = out.cursor;
        await state?.set(this.cursorKey("dm"), cursor);
      }
      if (list.length < 50) break;
    }
    return n;
  }

  private async pollRoom(room: string, { ask }: { ask?: string }, options?: WebhookOptions): Promise<number> {
    await this.me();
    const state = this.chat?.getState();
    const key = this.cursorKey(`room:${room}`);
    const cursor = (await state?.get<string>(key)) || undefined;
    let n = 0;
    if (!cursor) {
      // The first look at a room: start from now, answering only the ask that woke the bot, if any.
      const { messages = [] } = await this.client.roomMessages(room, { limit: 50 });
      const done = messages.filter((m) => !m.streaming);
      const last = done[done.length - 1];
      if (last) await state?.set(key, last.id);
      const asked = ask && messages.find((m) => m.id === ask && !m.streaming);
      if (asked) {
        await this.handleRoomMessage(asked, options);
        n++;
      }
      return n;
    }
    let after = cursor;
    for (let page = 0; page < 10; page++) {
      const { messages = [], more } = await this.client.roomMessages(room, { after, limit: 100 });
      for (const m of messages) {
        if (m.streaming) return n;   // still being written: read again from here next time
        after = m.id;
        await state?.set(key, after);
        if (m.from?.address === this.address || !m.text) continue;
        await this.handleRoomMessage(m, options);
        n++;
      }
      if (!more) break;
    }
    return n;
  }

  private async handleRoomMessage(m: WayzaRoomMessage, options?: WebhookOptions) {
    const msg = this.parseMessage({ ...m, via: "room" });
    if (msg.isMention) this.asks.set(m.room, m.id);
    await this.dispatch(msg.threadId, msg, options);
  }

  parseMessage(raw: WayzaRaw): Message<WayzaRaw> {
    const caution = this.config.cautionInText !== false ? (raw as any).caution : undefined;
    if (raw.via === "direct") {
      const body = raw.title ? `**${raw.title}**\n\n${raw.text}` : raw.text;
      const text = caution ? `${caution}\n\n${body}` : body;
      const parsed = this.converter.parseIncoming(text);
      return new Message<WayzaRaw>({
        id: raw.id,
        threadId: this.encodeThreadId({ kind: "dm", address: raw.from.address }),
        text: parsed.text,
        formatted: parsed.formatted,
        raw,
        author: {
          userId: raw.from.address,
          userName: raw.from.address,
          fullName: raw.from.name,
          isBot: !!raw.from.ai,
          isMe: raw.from.address === this.address,
        },
        metadata: { dateSent: new Date(raw.at), edited: false },
        attachments: [],
        isMention: true,
      });
    }
    if (raw.via === "room") {
      const me = this.address;
      const text = caution ? `${caution}\n\n${raw.text}` : raw.text;
      const parsed = this.converter.parseIncoming(text);
      const name = raw.from?.name || "Someone";
      return new Message<WayzaRaw>({
        id: raw.id,
        threadId: this.encodeThreadId({ kind: "room", room: raw.room }),
        text: parsed.text,
        formatted: parsed.formatted,
        raw,
        author: {
          userId: raw.from?.address || "deleted",
          userName: raw.from?.address || "deleted",
          fullName: raw.no_owner && !/unverified/i.test(name) ? `${name} (unverified)` : name,
          isBot: raw.from?.kind === "ai",
          isMe: !!me && raw.from?.address === me,
        },
        metadata: { dateSent: new Date(raw.at), edited: !!raw.edited_at, ...(raw.edited_at ? { editedAt: new Date(raw.edited_at) } : {}) },
        attachments: [],
        isMention: !!me && (!!raw.wants?.includes(me) || !!raw.mentions?.includes(me)),
      });
    }
    throw new ValidationError("wayza", "Only messages Wayza delivered can be parsed.");
  }

  // ---------- outgoing ----------

  private render(message: AdapterPostableMessage): string {
    if (extractFiles(message).length) this.logger.warn("Wayza adapter: files aren't sent yet; sending the text only.");
    return this.converter.renderPostable(message as any);
  }

  async postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage<WayzaRaw>> {
    return this.send(threadId, this.render(message));
  }

  private async send(threadId: string, text: string): Promise<RawMessage<WayzaRaw>> {
    await this.me();
    const t = this.decodeThreadId(threadId);
    if (t.kind === "dm") {
      const replyTo = this.lastIn.get(threadId);
      const out = await this.client.sendDirect(replyTo ? { reply_to: replyTo, text } : { to: t.address, text });
      if (!out.sent) throw new ValidationError("wayza", out.why || "Wayza didn't send it.");
      return { id: out.id, threadId, raw: { ...out, via: "sent" } };
    }
    // An answer in a room replies to the ask it answers, which takes the ask up.
    const replyTo = this.asks.get(t.room);
    const out = await this.client.roomPost(t.room, { text, ...(replyTo ? { reply_to: replyTo } : {}) });
    this.asks.delete(t.room);
    return { id: out.id, threadId, raw: { ...out, via: "room" } };
  }

  async editMessage(threadId: string, messageId: string, message: AdapterPostableMessage): Promise<RawMessage<WayzaRaw>> {
    const t = this.decodeThreadId(threadId);
    if (t.kind === "dm") throw new NotImplementedError("Wayza direct messages can't be edited once sent", "editMessage");
    const out = await this.client.roomEdit(t.room, messageId, { text: this.render(message) });
    return { id: out.id, threadId, raw: { ...out, via: "room" } };
  }

  async deleteMessage(): Promise<void> {
    throw new NotImplementedError("Wayza messages can't be deleted by their sender yet", "deleteMessage");
  }

  /** Rooms stream in place: posted at once, then filled in. A direct message is sent whole when the stream ends. */
  async stream(
    threadId: string,
    chunks: AsyncIterable<string | StreamChunk>,
    options?: StreamOptions,
  ): Promise<RawMessage<WayzaRaw>> {
    const t = this.decodeThreadId(threadId);
    const add = (text: string, c: string | StreamChunk) =>
      typeof c === "string" ? text + c : c.type === "markdown_text" ? text + c.text : text;
    let text = "";
    if (t.kind === "dm") {
      for await (const c of chunks) {
        options?.signal?.throwIfAborted();
        text = add(text, c);
      }
      return this.send(threadId, text);
    }
    await this.me();
    const replyTo = this.asks.get(t.room);
    const first = await this.client.roomPost(t.room, { stream: true, ...(replyTo ? { reply_to: replyTo } : {}) });
    this.asks.delete(t.room);
    let sent = "", last = 0;
    try {
      for await (const c of chunks) {
        options?.signal?.throwIfAborted();
        text = add(text, c);
        if (Date.now() - last >= STREAM_EDIT_MS && text.trim() && text !== sent) {
          await this.client.roomEdit(t.room, first.id, { text });
          sent = text;
          last = Date.now();
        }
      }
    } finally {
      const out = await this.client.roomEdit(t.room, first.id, { text: text.trim() ? text : "…", done: true });
      sent = out.text;
    }
    return { id: first.id, threadId, raw: { ...first, text: sent, via: "room" } };
  }

  private async react(threadId: string, messageId: string, emoji: EmojiValue | string, want: boolean) {
    const t = this.decodeThreadId(threadId);
    if (t.kind === "dm") throw new NotImplementedError("Wayza direct messages don't take reactions", "addReaction");
    const e = typeof emoji === "string" ? emoji : emoji.toString();
    const me = (await this.me()).full_address;
    // A tap on Wayza toggles, so tap again if it went the wrong way.
    let out = await this.client.roomReact(t.room, messageId, e);
    if (!!out.reactions?.[e]?.includes(me) !== want) out = await this.client.roomReact(t.room, messageId, e);
  }

  async addReaction(threadId: string, messageId: string, emoji: EmojiValue | string): Promise<void> {
    await this.react(threadId, messageId, emoji, true);
  }

  async removeReaction(threadId: string, messageId: string, emoji: EmojiValue | string): Promise<void> {
    await this.react(threadId, messageId, emoji, false);
  }

  async startTyping(): Promise<void> {
    // Wayza shows a streamed message as it is written; there is no separate typing signal.
  }

  // ---------- reading ----------

  async fetchMessages(threadId: string, options: FetchOptions = {}): Promise<FetchResult<WayzaRaw>> {
    const t = this.decodeThreadId(threadId);
    const limit = Math.min(options.limit ?? 50, 100);
    if (t.kind === "dm") {
      // Wayza lists the messages this bot was sent; what it sent is kept by Chat SDK's own history.
      const { messages = [] } = await this.client.directMessages({ limit });
      const mine = messages.filter((m) => m.from?.address === t.address).reverse();
      return { messages: mine.map((m) => this.parseMessage({ ...m, via: "direct" })) };
    }
    const forward = options.direction === "forward" && options.cursor;
    const { messages = [], more } = await this.client.roomMessages(t.room, {
      limit,
      ...(forward ? { after: options.cursor } : {}),
    });
    const list = messages.filter((m) => !m.streaming).map((m) => this.parseMessage({ ...m, via: "room" }));
    return { messages: list, nextCursor: forward && more && list.length ? list[list.length - 1]?.id : undefined };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const t = this.decodeThreadId(threadId);
    if (t.kind === "dm") return { id: threadId, channelId: threadId, channelName: t.address, isDM: true, metadata: { address: t.address } };
    const room = await this.client.room(t.room).catch(() => null);
    const r = room?.room ?? room;
    return { id: threadId, channelId: threadId, channelName: r?.name, isDM: false, metadata: { room: t.room } };
  }

  renderFormatted(content: FormattedContent): string {
    return this.converter.fromAst(content);
  }
}

/** A Wayza adapter. With no options it reads WAYZA_KEY (or signs itself up), WAYZA_WEBHOOK_URL and WAYZA_WEBHOOK_SECRET. */
export function createWayzaAdapter(config: WayzaAdapterConfig = {}): WayzaAdapter {
  return new WayzaAdapter(config);
}
