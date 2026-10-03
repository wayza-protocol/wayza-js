// `node --test packages/human-js/test/` resolves the folder to this file on Node 22+,
// which no longer expands directories; it loads every *.test.js here.
import { readdirSync } from 'node:fs';

for (const f of readdirSync(new URL('.', import.meta.url)).filter((f) => f.endsWith('.test.js')).sort()) {
  await import(new URL(f, import.meta.url));
}
