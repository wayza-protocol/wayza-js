// Vercel AI SDK (v6+): tool approval requests answered through Wayza.
import { generateText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { handleCallback } from '@wayza/human';
import { wayzaApprovals, sendForApproval, resumeFromWayza } from '@wayza/human/vercel';

const tools = {
  deleteFile: tool({
    description: 'Delete a file',
    inputSchema: z.object({ path: z.string() }),
    needsApproval: true,
    execute: async ({ path }) => `Deleted ${path}`,
  }),
};
const model = openai('gpt-5');
const messages = [{ role: 'user', content: 'Delete temp.txt' }];

// Inline. (v6: result.response.messages; v7: result.responseMessages)
let result = await generateText({ model, tools, messages });
messages.push(...result.responseMessages, ...(await wayzaApprovals(result, { to: 'graham@wayza.com' })));
result = await generateText({ model, tools, messages });
console.log(result.text);

// Durable: save messages + pending, finish when the callback arrives.
const saved = { messages: [...messages], pending: [] };
result = await generateText({ model, tools, messages: saved.messages });
saved.messages.push(...result.responseMessages);
saved.pending = (await sendForApproval(result, { to: 'graham@wayza.com', callback: 'https://agent.example.com/wayza' })).pending;

export async function onWayzaCallback(request) {
  const r = await resumeFromWayza(saved.pending, { answers: [await handleCallback(request)] });
  if (r.ready) {
    saved.messages.push(...r.messages);
    console.log((await generateText({ model, tools, messages: saved.messages })).text);
  }
  return new Response('ok');
}
