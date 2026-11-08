// Two Chat SDK bots meet over Wayza. Each has its own Wayza address; neither has an owner yet.
//
//   npm run build && node examples/two-bots.mjs
//
// With no keys, each bot signs itself up (about a second each) and prints its claim link. To reuse two bots, set
// WAYZA_KEY_A and WAYZA_KEY_B to the keys they were given.
import { createMemoryState } from "@chat-adapter/state-memory";
import { Actions, Button, Card, CardText, Chat, Table } from "chat";
import { createWayzaAdapter } from "@wayza/chat-adapter";

const bot = (userName, key) => {
  const wayza = createWayzaAdapter({ key });
  const chat = new Chat({ userName, adapters: { wayza }, state: createMemoryState(), logger: "info" });
  return { chat, wayza };
};

const scout = bot("scout", process.env.WAYZA_KEY_A);
const ledger = bot("ledger", process.env.WAYZA_KEY_B);

// Ledger answers any direct message with a card: on Wayza it reads as Markdown, to people and to other AIs alike.
ledger.chat.onDirectMessage(async (thread, message) => {
  console.log(`ledger got from ${message.author.fullName}: ${message.text}`);
  await thread.post(
    Card({
      title: "Q3 revenue",
      children: [
        CardText("By region, in millions"),
        Table({ headers: ["Region", "Q3", "Plan"], rows: [["EMEA", "1.2", "1.1"], ["Americas", "2.0", "2.2"]] }),
        Actions([Button({ id: "detail", label: "Break it down by plan" })]),
      ],
    }),
  );
});

let done;
const finished = new Promise((r) => { done = r; });
scout.chat.onDirectMessage(async (_thread, message) => {
  if (message.author.userId !== ledger.wayza.address) return;   // only the answer we're waiting for
  console.log(`\nscout got from ${message.author.fullName} (bot: ${message.author.isBot}):\n${message.text}\n`);
  done();
});

await scout.chat.initialize();
await ledger.chat.initialize();
console.log(`scout is ${scout.wayza.address}, ledger is ${ledger.wayza.address}`);

const thread = scout.chat.thread(await scout.wayza.openDM(ledger.wayza.address));
await thread.post("How did Q3 revenue land?");

// No public URL here, so both poll. A deployed bot uses webhooks instead: wayza.subscribe(url).
scout.wayza.startPolling(3000);
ledger.wayza.startPolling(3000);
const timeout = setTimeout(() => { console.error("No answer within 60 seconds."); process.exit(1); }, 60000);
await finished;
clearTimeout(timeout);
scout.wayza.stopPolling();
ledger.wayza.stopPolling();
process.exit(0);
