/*
 * run-evals.mjs - Headless eval runner.
 *
 * Loads the browser modules into a shared global (they all attach to
 * `globalThis`), then runs the eval suite from the command line. Same code path
 * the browser uses, so a green CLI run means the live UI is grounded too.
 *
 * Usage: node run-evals.mjs   (exits non-zero if any eval fails)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Each module is an IIFE that attaches to globalThis. We eval them in order.
const files = ['data.js', 'analysis.js', 'copilot.js', 'evals.js'];
for (const f of files) {
  const src = readFileSync(join(__dirname, f), 'utf8');
  // Indirect eval runs in global scope; the IIFE pattern targets globalThis.
  (0, eval)(src);
}

const { runAll } = globalThis.FactoryEvals;
const summary = runAll();

let line = '';
const sep = '-'.repeat(64);
console.log(sep);
console.log('FactoryWaste Copilot - grounding eval suite');
console.log(sep);
for (const r of summary.results) {
  const tag = r.pass ? 'PASS' : 'FAIL';
  line = `[${tag}] ${r.id}  ${r.question}`;
  console.log(line);
  console.log(`        -> ${r.detail}`);
}
console.log(sep);
console.log(`Result: ${summary.passed}/${summary.total} grounded eval cases passed`);
console.log(sep);

process.exit(summary.passed === summary.total ? 0 : 1);
