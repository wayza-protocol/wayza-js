// Mastra: a workflow step suspends until a person answers through Wayza.
import { Mastra } from '@mastra/core';
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { handleCallback } from '@wayza/human';
import { askHuman, wayzaGate, resumeFromWayza } from '@wayza/human/mastra';

const deploy = createStep({
  id: 'deploy',
  inputSchema: z.object({ version: z.string() }),
  outputSchema: z.object({ deployed: z.boolean() }),
  suspendSchema: z.object({ wayza: z.any() }),
  resumeSchema: z.object({ wayza: z.any() }),
  execute: async (ctx) => {
    // Durable: suspends the run; resumes with the verified answer.
    const answer = await wayzaGate(ctx, {
      to: 'you@example.com', title: `Deploy ${ctx.inputData.version} to production?`,
      callback: 'https://agent.example.com/wayza', // gets ?wayza_run=<runId>
    });
    if (!answer) return;
    return { deployed: answer.approved === true };
  },
});

const announce = createStep({
  id: 'announce',
  inputSchema: z.object({ deployed: z.boolean() }),
  outputSchema: z.object({ announced: z.boolean() }),
  // Inline: a short wait inside the step.
  execute: async (ctx) => ({
    announced: ctx.inputData.deployed && (await askHuman(ctx, { to: 'you@example.com', title: 'Post the release note?', timeout: '5m' })).approved === true,
  }),
});

const release = createWorkflow({ id: 'release', inputSchema: z.object({ version: z.string() }), outputSchema: z.object({ announced: z.boolean() }) })
  .then(deploy).then(announce).commit();
const mastra = new Mastra({ workflows: { release } }); // add storage so runs survive restarts

const run = await mastra.getWorkflow('release').createRun();
await run.start({ inputData: { version: '2.4.0' } }); // status: 'suspended'

export async function onWayzaCallback(request) {
  const answer = await handleCallback(request);
  const runId = new URL(request.url).searchParams.get('wayza_run');
  console.log(await resumeFromWayza(mastra.getWorkflow('release'), answer, { runId }));
  return new Response('ok');
}
