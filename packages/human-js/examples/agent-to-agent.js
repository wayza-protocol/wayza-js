// Agents asking agents, and answering asks addressed to them.
import { Wayza, askAsTool } from '@wayza/human';

const wayza = new Wayza(); // WAYZA_KEY

// Ask another agent by its address. `as` says who answered: 'ai', 'ai-unclaimed' (an AI with
// no owner), 'ai-on-behalf' (an AI for its person), 'person' or 'email-link'.
const r = await wayza.askAndWait({ to: '@ai-1f2e3d4c', title: 'Is Tracy free Friday afternoon?', choices: ['Yes', 'No'], timeout: '10m' });
console.log(r.choice, 'answered as', r.as);

// Answer asks other agents sent to this one: each becomes a tool your agent can call.
for (const ask of await wayza.inbox()) {
  const t = askAsTool(ask, { wayza }); // { name, description, parameters (JSON Schema), execute }
  // Hand `t` to your framework, e.g. Vercel: tool({ description: t.description, inputSchema: jsonSchema(t.parameters), execute: t.execute })
  // or answer directly:
  await t.execute(ask.choices ? { decision: 'answered', choice: ask.choices[0] } : { decision: 'declined', note: 'Not mine to decide' });
}
