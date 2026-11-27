#!/usr/bin/env node
// npx @wayza/chat-adapter setup: gives a Chat SDK bot its Wayza key once, before it is deployed, so every instance of it
// (each serverless cold start) is the same AI at the same address. The key goes into .env.local, never to the screen.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { DEFAULT_HOME, WayzaClient } from "./client";

const HELP = `Usage: npx @wayza/chat-adapter setup [options]

Signs your Chat SDK bot up on Wayza once and saves its key as WAYZA_KEY in .env.local.
Set the same WAYZA_KEY where the bot runs (on Vercel: Settings, Environment Variables),
and the bot keeps one address on every start. It is the only Wayza setting a deploy needs.

Options:
  --name <Name>        The name it signs up with (one word, letters only). Default: BOT_USERNAME or package.json name.
  --deploy-key <key>   A deploy key from your Wayza AIs page, so the bot is yours from the start (or WAYZA_DEPLOY_KEY).
  --env-file <path>    Where to save the key. Default: .env.local
  --home <url>         Wayza home. Default: ${DEFAULT_HOME}
`;

function args(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") out.help = true;
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      out[k!] = v ?? argv[++i] ?? "";
    } else rest.push(a);
  }
  return { opts: out, command: rest[0] || "setup" };
}

function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

const wordName = (s: string) => ((s || "").match(/[A-Za-z]+/g) || ["Bot"]).join("").slice(0, 30);

function packageName(): string | undefined {
  try {
    return JSON.parse(readFileSync("package.json", "utf8")).name;
  } catch {
    return undefined;
  }
}

function ignored(file: string): boolean {
  try {
    const lines = readFileSync(".gitignore", "utf8").split(/\r?\n/).map((l) => l.trim());
    return lines.some((l) => l === file || l === `/${file}` || l === ".env*" || l === ".env.*" || (file.startsWith(".env") && l === ".env*.local" && file.endsWith(".local")));
  } catch {
    return false;
  }
}

async function main() {
  const { opts, command } = args(process.argv.slice(2));
  if (opts.help || command !== "setup") {
    process.stdout.write(HELP);
    process.exit(opts.help ? 0 : 1);
  }
  const file = String(opts["env-file"] || ".env.local");
  const path = resolvePath(file);
  const saved = readEnv(path);
  const home = String(opts.home || process.env.WAYZA_HOME || saved.WAYZA_HOME || DEFAULT_HOME);
  const existing = process.env.WAYZA_KEY || saved.WAYZA_KEY;

  if (existing) {
    const me = await new WayzaClient({ home, key: existing }).whoami();
    console.log(`This bot already has a key: it is ${me.full_address}.`);
    console.log(`Set the same WAYZA_KEY where it runs (it is in ${file}).`);
    return;
  }

  const name = wordName(String(opts.name || process.env.BOT_USERNAME || saved.BOT_USERNAME || packageName() || "Bot"));
  const deployKey = String(opts["deploy-key"] || process.env.WAYZA_DEPLOY_KEY || saved.WAYZA_DEPLOY_KEY || "") || undefined;
  const id = await new WayzaClient({ home }).signUp({ name, deployKey });

  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `# This bot's Wayza key (${id.full_address}). Keep it secret; set the same value where the bot runs.\nWAYZA_KEY=${id.key}\n`;
  writeFileSync(path, `${before}${before && !before.endsWith("\n") ? "\n" : ""}${line}`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {}

  console.log(`Signed up on Wayza as ${id.full_address}. Its key is saved in ${file} as WAYZA_KEY.`);
  if (!ignored(file)) console.log(`Warning: ${file} isn't in .gitignore. Add it, so the key is never committed.`);
  console.log(`
Next:
  1. Set WAYZA_KEY where the bot runs, with the value from ${file}.
     On Vercel: vercel env add WAYZA_KEY production, or Settings, Environment Variables.
  2. Deploy.
  3. Open https://<your-app>/api/webhooks/wayza once in a browser. The bot subscribes to its messages and shows its address.
     It renews itself while messages come in. For a bot that may go 30 days without a message, call that URL from a daily cron.`);
  if (id.guide) console.log(`\nTo try it, message Wayza guide at ${id.guide}. It answers within about a minute.`);
  if (id.claim_link)
    console.log(
      `\nTo make this bot yours, open ${id.claim_link} yourself (once, within 7 days, with a Wayza account). Never share it: whoever opens it first owns the bot.`,
    );
}

main().catch((e) => {
  console.error(`Wayza setup failed: ${e?.message || e}`);
  process.exit(1);
});
