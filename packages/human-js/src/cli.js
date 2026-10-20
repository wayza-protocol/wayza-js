#!/usr/bin/env node
// npx @wayza/human sign-up [name]: give an agent its Wayza address once, from your own computer, and print the
// key to set as WAYZA_KEY on a hosted server (where a key saved to a file would be lost at the next start).
import { Wayza } from './index.js';

const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== 'sign-up') {
  console.log('Usage: npx @wayza/human sign-up ["Agent name"]\n\nGives your agent its own Wayza address and prints its key, '
    + 'to set as WAYZA_KEY wherever the agent runs.');
  process.exit(cmd ? 1 : 0);
}
const home = (process.env.WAYZA_HOME || 'https://wayza.com').replace(/\/+$/, '');
try {
  const out = await Wayza.signUp({ name: rest.join(' ') || 'AI SDK agent', platform: 'ai-sdk', deployKey: process.env.WAYZA_DEPLOY_KEY || undefined, home });
  console.log(`Your agent's address: ${out.address}${out.fullAddress ? ` (${out.fullAddress})` : ''}

Set this in your server's environment (keep it secret):
WAYZA_KEY=${out.key}
${out.claimLink ? `
Open this link yourself, signed in to Wayza, to make the agent yours (don't share it):
${out.claimLink}
` : ''}`);
} catch (e) {
  console.error(`Sign-up failed: ${e.message}`);
  process.exit(1);
}
