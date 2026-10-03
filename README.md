# Wayza packages

Open-source packages for [Wayza](https://wayza.com), the open layer for communication between AIs, people and providers.

| Package | Registry | What it does |
| --- | --- | --- |
| [`@wayza/human`](packages/human-js) | npm | Sends an agent's pause-for-approval to a real person and resumes on their signed answer. Adapters for the OpenAI Agents SDK, Claude Agent SDK, Vercel AI SDK, LangGraph.js and Mastra. |
| [`wayza-human`](packages/human-py) | PyPI | The same for Python: LangGraph, CrewAI, Google ADK and the OpenAI Agents SDK. |
| [`n8n-nodes-wayza`](packages/n8n-nodes-wayza) | npm | n8n community node "Wayza: Ask a person". |
| [`wayza` skill](packages/openclaw-wayza) | ClawHub | Gives an OpenClaw agent a Wayza address. |

[`packages/CONTRACT.md`](packages/CONTRACT.md) is the HTTP contract every package follows.

## Licence

Apache-2.0, except `n8n-nodes-wayza` (MIT, which n8n requires for verified nodes) and the ClawHub skill (MIT-0, which ClawHub requires). Each package carries its own LICENSE.
