// Claude Agent SDK: canUseTool asks a person through Wayza.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { handleCallback } from '@wayza/human';
import { wayzaCanUseTool, allowApproved, resumePrompt } from '@wayza/human/claude';

// Inline: each tool call that needs permission waits for the person's answer.
for await (const message of query({
  prompt: 'Tidy up /tmp/reports and delete anything older than a week',
  options: { canUseTool: wayzaCanUseTool({ to: 'you@example.com', timeout: '15m', when: (tool) => tool !== 'Read' }) },
})) {
  if ('result' in message) console.log(message.result);
}

// Durable: stop the query while the person thinks about it, resume the session later.
let sessionId, pending;
for await (const message of query({
  prompt: 'Deploy the staging branch',
  options: {
    canUseTool: wayzaCanUseTool({
      to: 'you@example.com', mode: 'durable', callback: 'https://agent.example.com/wayza',
      onPending: (p) => { pending = p; }, // save it with the session id
    }),
  },
})) {
  if (message.session_id) sessionId = message.session_id;
}

export async function onWayzaCallback(request) {
  const answer = await handleCallback(request);
  for await (const message of query({
    prompt: resumePrompt(answer, pending),
    options: { resume: sessionId, canUseTool: await allowApproved(answer, pending, { to: 'you@example.com' }) },
  })) {
    if ('result' in message) console.log(message.result);
  }
  return new Response('ok');
}
