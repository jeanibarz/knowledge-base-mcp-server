#!/usr/bin/env node
// Pre-generate RFC 017 contextual-preface sidecars for one BEIR dataset, so a
// later `run.js --mode=hybrid+rerank+contextual --preface-cache-dir=...` run is
// served from cache instead of paying one LLM call per chunk inside the
// strictly file-sequential ingest loop (which parallelizes only within a
// document — ~3 chunks for BEIR corpora — and is days-slow on 200k chunks).
//
// Honesty: this is the PRODUCTION preface path, not a reimplementation. It
// writes the corpus files byte-identically to the BEIR runner's prepareCorpus
// and then calls the production `buildChunkDocuments` (frontmatter parse →
// splitter → document hash → resolveContextualPrefaces → sidecar persist) for
// many files concurrently. The sidecars it leaves under
// $FAISS_INDEX_PATH/.contextual-prefaces are the same bytes the in-run path
// would produce; the benchmark run still validates document hash, chunk
// size/overlap, and generator version before reusing any entry.
//
// Required env (set BEFORE launch — config constants bind at import):
//   KNOWLEDGE_BASES_ROOT_DIR=<beir workspace>/knowledge-bases   (stable path!)
//   FAISS_INDEX_PATH=<persistent staging dir for the sidecars>
//   KB_CONTEXTUAL_RETRIEVAL=on
//   KB_LLM_PROVIDER / KB_LLM_ENDPOINT / KB_LLM_MODEL / KB_OPENROUTER_API_KEY
//   KB_CONTEXTUAL_CONCURRENCY=<per-document chunk concurrency>
//
// Usage:
//   node benchmarks/scripts/prefab_prefaces.mjs --dataset=scifact \
//     --corpus=/home/jean/.cache/kb-beir-cache/scifact/corpus.jsonl \
//     --file-concurrency=16

import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const args = Object.fromEntries(
  process.argv.slice(2).map((t) => {
    const [flag, value] = t.split(/=(.*)/s, 2);
    return [flag.replace(/^--/, ''), value];
  }),
);
for (const required of ['dataset', 'corpus']) {
  if (!args[required]) throw new Error(`--${required}= is required`);
}
const dataset = args.dataset;
const fileConcurrency = Number(args['file-concurrency'] ?? 16);

const kbRoot = process.env.KNOWLEDGE_BASES_ROOT_DIR;
const faissPath = process.env.FAISS_INDEX_PATH;
if (!kbRoot || !faissPath) throw new Error('KNOWLEDGE_BASES_ROOT_DIR and FAISS_INDEX_PATH must be set');
if ((process.env.KB_CONTEXTUAL_RETRIEVAL ?? '').toLowerCase() !== 'on') {
  throw new Error('KB_CONTEXTUAL_RETRIEVAL=on is required');
}

// --- byte-exact mirror of benchmarks/beir/run.ts prepareCorpus -------------
function safeDocFileName(docId, index) {
  const readable = docId.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || `doc-${index}`;
  const suffix = crypto.createHash('sha1').update(docId).digest('hex').slice(0, 12);
  return `${readable}-${suffix}.md`;
}
const yamlScalar = (value) => JSON.stringify(value);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { buildChunkDocuments } = await import(path.join(repoRoot, 'build', 'file-ingest.js'));

const raw = await fsp.readFile(args.corpus, 'utf-8');
const rows = raw
  .split(/\r?\n/)
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));

const kbPath = path.join(kbRoot, dataset);
await fsp.mkdir(kbPath, { recursive: true });

let processed = 0;
let failures = 0;
const startedAt = Date.now();

async function processRow(row, index) {
  const fileName = safeDocFileName(row._id, index);
  const filePath = path.join(kbPath, fileName);
  const body = [
    '---',
    `title: ${yamlScalar(row.title ?? row._id)}`,
    '---',
    '',
    row.title ? `# ${row.title}` : `# ${row._id}`,
    '',
    row.text ?? '',
    '',
  ].join('\n');
  try {
    await fsp.writeFile(filePath, body, 'utf-8');
    // Production ingest path: split + hash + resolveContextualPrefaces +
    // sidecar persist all happen inside this call.
    await buildChunkDocuments(filePath, body, dataset);
  } catch (error) {
    failures += 1;
    process.stderr.write(`[prefab] ${dataset}/${fileName}: ${error.message}\n`);
  }
  processed += 1;
  if (processed % 250 === 0) {
    const rate = processed / ((Date.now() - startedAt) / 60000);
    process.stdout.write(
      `[prefab] ${dataset}: ${processed}/${rows.length} docs (${rate.toFixed(0)}/min, ${failures} failures)\n`,
    );
  }
}

// Plain promise pool over files; per-document chunk concurrency is the
// production KB_CONTEXTUAL_CONCURRENCY inside resolveContextualPrefaces.
let cursor = 0;
async function worker() {
  while (cursor < rows.length) {
    const index = cursor;
    cursor += 1;
    await processRow(rows[index], index);
  }
}
await Promise.all(Array.from({ length: fileConcurrency }, () => worker()));

process.stdout.write(
  `[prefab] ${dataset} DONE: ${processed} docs, ${failures} failures, ${Math.round((Date.now() - startedAt) / 60000)} min\n`,
);
if (failures > 0) process.exitCode = 1;
