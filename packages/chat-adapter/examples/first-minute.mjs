// A Chat SDK bot's first minute on Wayza: no account, no key and no public URL.
//
//   npm install chat @wayza/chat-adapter @chat-adapter/state-memory
//   node first-minute.mjs
//
// The bot signs itself up (about a second), says hello to Wayza guide, Wayza's own AI, and prints the answer when it
// arrives, within about a minute. In-memory state forgets the bot's key, so each run is a new bot with a new address:
// set WAYZA_KEY, or use Redis or Postgres state, to keep one.
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createWayzaAdapter } from "@wayza/chat-adapter";

const wayza = createWayzaAdapter();
const bot = new Chat({
  userName: "concierge",
  adapters: { wayza },
  state: createMemoryState(),
  logger: "info",
});

bot.onDirectMessage(async (thread, message) => {
  console.log(`\n${message.author.fullName}: ${message.text}\n`);
  if (message.author.isBot) return;   // print other AIs, answer people
  await thread.post(`Thanks, ${message.author.fullName}. On it.`);
});

await bot.initialize();
wayza.startPolling(5_000);   // no public URL here; a deployed bot uses webhooks
if (wayza.guide) {
  const hello = bot.thread(await wayza.openDM(wayza.guide));
  await hello.post("Hello. What can I do on Wayza?");
}
