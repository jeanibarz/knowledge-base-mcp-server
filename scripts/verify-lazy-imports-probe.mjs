#!/usr/bin/env node
// Single-provider probe — invoked by verify-lazy-imports.mjs with
// --experimental-loader=./scripts/lazy-imports-trace-loader.mjs.
//
// Initializes FaissIndexManager with the env's EMBEDDING_PROVIDER, then
// reads the loader's trace file and asserts no INACTIVE provider's module
// URLs appear in it.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Module-URL substrings that mark a provider as loaded. Each provider is
// shipped as a top-level package + drags in its SDK; either is sufficient.
const FINGERPRINTS = {
  huggingface: ['/@langchain/community/embeddings/hf', '/@huggingface/inference/'],
  ollama: ['/@langchain/ollama/', '/ollama/'],
  openai: ['/@langchain/openai/', '/openai/'],
};

const active = process.env.EMBEDDING_PROVIDER ?? '(unset)';
const traceFile = process.env.LAZY_IMPORTS_TRACE_FILE;
if (!traceFile) {
  console.error('LAZY_IMPORTS_TRACE_FILE is not set — driver should set it.');
  process.exit(2);
}

const tempDir = await mkdtemp(path.join(tmpdir(), `kb-lazy-${active}-`));
process.env.KNOWLEDGE_BASES_ROOT_DIR = tempDir;
process.env.FAISS_INDEX_PATH = path.join(tempDir, '.faiss');

const modulePath = path.join(repoRoot, 'build', 'FaissIndexManager.js');
const { FaissIndexManager } = await import(modulePath);

const manager = new FaissIndexManager();
await manager.initialize();

const trace = (await readFile(traceFile, 'utf-8')).split('\n').filter(Boolean);
const matchUrls = (fps) =>
  fps.flatMap((fp) => trace.filter((u) => u.includes(fp)).map((u) => `${fp} → ${path.basename(new URL(u).pathname)}`));

const inactive = Object.keys(FINGERPRINTS).filter((p) => p !== active);
const activeHits = matchUrls(FINGERPRINTS[active] ?? []);
const leaks = Object.fromEntries(inactive.map((p) => [p, matchUrls(FINGERPRINTS[p])]));

console.log(`\n=== EMBEDDING_PROVIDER=${active} ===`);
console.log(`trace size: ${trace.length} resolved module URLs`);
console.log(`active provider: ${activeHits.length} matching URLs`);
const seen = new Set();
for (const h of activeHits) {
  if (seen.has(h)) continue;
  seen.add(h);
  console.log(`  ✓ ${h}`);
}
let leaked = false;
for (const [other, hits] of Object.entries(leaks)) {
  if (hits.length === 0) {
    console.log(`  ✓ ${other}: 0 URLs resolved (lazy)`);
  } else {
    leaked = true;
    console.log(`  ✗ ${other}: ${hits.length} URLs unexpectedly resolved:`);
    const dedupSeen = new Set();
    for (const h of hits) {
      if (dedupSeen.has(h)) continue;
      dedupSeen.add(h);
      console.log(`      ${h}`);
    }
  }
}

if (activeHits.length === 0) {
  console.error(
    `\nFAIL: the active provider (${active}) was not loaded — fingerprint pattern likely needs updating.`,
  );
  process.exit(1);
}
if (leaked) {
  console.error(`\nFAIL: inactive provider modules were loaded for EMBEDDING_PROVIDER=${active}`);
  process.exit(1);
}
process.exit(0);
