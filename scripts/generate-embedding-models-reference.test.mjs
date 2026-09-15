import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  checkEmbeddingModelsReference,
  EMBEDDING_MODELS_REFERENCE_PATH,
  generateEmbeddingModelsReferenceMarkdown,
  writeEmbeddingModelsReference,
} from './generate-embedding-models-reference.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The generated markdown reads these from `root`; copying the live ones into a
// temp root lets a test corrupt exactly one benchmark artifact and prove the
// generator fails loud (the `{ root }` injection the implementation already
// exposes for this purpose).
const FIXTURE_FILES = [
  'src/config/provider.ts',
  'src/embedding-provider.ts',
  'src/cost-estimates.ts',
  'benchmarks/results/mteb/qwen3.json',
  'benchmarks/results/mteb/nomic.json',
  'benchmarks/results/beir/matrix/qwen3/beir-matrix.json',
  'benchmarks/results/beir/matrix/nomic/beir-matrix.json',
];

const QWEN3_MTEB = 'benchmarks/results/mteb/qwen3.json';

async function buildFixtureRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-embedding-models-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const rel of FIXTURE_FILES) {
    const dest = path.join(root, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(path.join(REPO_ROOT, rel), dest);
  }
  return root;
}

async function readJson(relPath) {
  return JSON.parse(await fs.readFile(path.join(REPO_ROOT, relPath), 'utf8'));
}

// Locate the single matrix row that documents a given model id, so a value is
// asserted against the row it belongs to — not merely present somewhere in the
// document (which would let a qwen3↔nomic mapping swap pass silently).
function rowFor(markdown, modelId) {
  const row = markdown.split('\n').find((line) => line.startsWith('|') && line.includes(modelId));
  assert.ok(row, `expected a table row containing "${modelId}"`);
  return row;
}

test('matrix gains a measured-quality column (#942)', async () => {
  const markdown = await generateEmbeddingModelsReferenceMarkdown();
  assert.match(markdown, /\| Provider \| Model name \| Model id \| Vector dimensions \| Task prefixes \| Measured retrieval quality \| Repo status \| Switch-over notes \|/);
});

test('each measured row renders its own artifact values, links, and the local-run caveat (#942)', async () => {
  const markdown = await generateEmbeddingModelsReferenceMarkdown();

  // Values are computed from the JSON (not hand-typed) and asserted within the
  // specific row, so both a number drift and a row/model mapping swap fail.
  const cases = [
    {
      modelId: 'ollama__dengcao-Qwen3-Embedding-0.6B-Q8_0',
      mtebPath: 'benchmarks/results/mteb/qwen3.json',
      beirPath: 'benchmarks/results/beir/matrix/qwen3/beir-matrix.json',
      beirReport: '../../benchmarks/results/beir/matrix/qwen3/beir-matrix.md',
      mtebLink: '../../benchmarks/results/mteb/qwen3.json',
    },
    {
      modelId: 'ollama__nomic-embed-text /',
      mtebPath: 'benchmarks/results/mteb/nomic.json',
      beirPath: 'benchmarks/results/beir/matrix/nomic/beir-matrix.json',
      beirReport: '../../benchmarks/results/beir/matrix/nomic/beir-matrix.md',
      mtebLink: '../../benchmarks/results/mteb/nomic.json',
    },
  ];

  for (const c of cases) {
    const mteb = await readJson(c.mtebPath);
    const beir = await readJson(c.beirPath);
    const dense = beir.perMode.find((mode) => mode.mode === 'dense');
    const mtebScore = mteb.mean_main_score.toFixed(3);
    const beirScore = dense.multiDomainMeanNdcgAt10.toFixed(3);

    const row = rowFor(markdown, c.modelId);
    assert.ok(row.includes(`MTEB mean [${mtebScore}](${c.mtebLink}) (${mteb.tasks.length} tasks)`), `MTEB cell for ${c.modelId}: ${row}`);
    assert.ok(row.includes(`BEIR dense nDCG@10 [${beirScore}](${c.beirReport}) (${dense.datasetsEvaluated} datasets)`), `BEIR cell for ${c.modelId}: ${row}`);
    assert.match(row, /local run, not an official leaderboard submission/);
  }
});

test('models without committed results render "Not measured", never a blank/zero (#942)', async () => {
  const markdown = await generateEmbeddingModelsReferenceMarkdown();

  for (const modelId of [
    'openai__text-embedding-3-small',
    'openai__text-embedding-3-large',
    'huggingface__BAAI-bge-small-en-v1.5',
    'huggingface__nomic-ai-nomic-embed-text-v1.5',
  ]) {
    const row = rowFor(markdown, modelId);
    assert.match(row, /\| Not measured \|/, `${modelId} should render "Not measured"`);
    assert.doesNotMatch(row, /MTEB mean|BEIR dense/, `${modelId} should carry no measured value`);
  }
});

test('a missing mapped artifact fails loud, not a silent "Not measured" (#942)', async (t) => {
  const root = await buildFixtureRoot(t);
  await fs.rm(path.join(root, QWEN3_MTEB));
  await assert.rejects(() => generateEmbeddingModelsReferenceMarkdown({ root }));
});

test('a malformed mapped artifact fails loud with a parse error (#942)', async (t) => {
  const root = await buildFixtureRoot(t);
  await fs.writeFile(path.join(root, QWEN3_MTEB), '{ not: valid json', 'utf8');
  await assert.rejects(
    () => generateEmbeddingModelsReferenceMarkdown({ root }),
    /Unable to parse .* as JSON/,
  );
});

test('a non-numeric headline metric fails loud (#942)', async (t) => {
  const root = await buildFixtureRoot(t);
  const broken = { ...(await readJson(QWEN3_MTEB)), mean_main_score: 'not-a-number' };
  await fs.writeFile(path.join(root, QWEN3_MTEB), JSON.stringify(broken), 'utf8');
  await assert.rejects(
    () => generateEmbeddingModelsReferenceMarkdown({ root }),
    /Expected a finite number/,
  );
});

test('drift gate is satisfied by a freshly generated file and rejects a stale one (#942)', async (t) => {
  const root = await buildFixtureRoot(t);
  await writeEmbeddingModelsReference({ root });

  const fresh = await checkEmbeddingModelsReference({ root });
  assert.deepEqual(fresh, { ok: true, exists: true });

  await fs.appendFile(path.join(root, EMBEDDING_MODELS_REFERENCE_PATH), '\nstale drift\n', 'utf8');
  const stale = await checkEmbeddingModelsReference({ root });
  assert.equal(stale.ok, false);
  assert.equal(stale.exists, true);
});
