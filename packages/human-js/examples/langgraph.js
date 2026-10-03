// LangGraph.js: interrupt() answered by a person through Wayza.
import { StateGraph, Annotation, MemorySaver, interrupt, Command, START, END } from '@langchain/langgraph';
import { handleCallback } from '@wayza/human';
import { askHuman, wayzaInterrupt, sendForApproval, resumeFromWayza } from '@wayza/human/langgraph';

const State = Annotation.Root({ draft: Annotation(), sent: Annotation() });

const graph = new StateGraph(State)
  // Durable: the graph pauses at interrupt(); the checkpointer keeps the state.
  .addNode('review', async (s) => {
    const answer = interrupt(wayzaInterrupt({ title: 'Send this email to the board?', details: s.draft }));
    return { sent: answer.approved === true };
  })
  // Inline: wait inside the node (a re-run reuses the same ask).
  .addNode('followUp', async (s, config) => {
    const answer = await askHuman({ to: 'graham@wayza.com', title: 'Book a follow-up call?', timeout: '10m' }, config);
    return { sent: s.sent && answer.approved !== false };
  })
  .addEdge(START, 'review').addEdge('review', 'followUp').addEdge('followUp', END)
  .compile({ checkpointer: new MemorySaver() });

const config = { configurable: { thread_id: 'email-42' } };
const result = await graph.invoke({ draft: 'Q3 numbers attached.' }, config);
const { pending } = await sendForApproval(result, { to: 'graham@wayza.com', callback: 'https://agent.example.com/wayza' }, config);

export async function onWayzaCallback(request) {
  const { ready, resume } = await resumeFromWayza(pending, { answers: [await handleCallback(request)] });
  if (ready) console.log(await graph.invoke(new Command({ resume }), config));
  return new Response('ok');
}
