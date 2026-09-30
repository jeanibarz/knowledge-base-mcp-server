import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  BENCHMARK_RESULTS_REFERENCE_PATH,
  CANONICAL_ARTIFACTS,
  checkBenchmarkResultsReference,
  generateBenchmarkResultsReferenceMarkdown,
  writeBenchmarkResultsReference,
} from './generate-benchmark-results-reference.mjs';

async function seedFixtureRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-bench-results-'));
  const write = async (relativePath, data) => {
    const absolute = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  };

  await write(CANONICAL_ARTIFACTS.mteb[0].path, {
    kb_model: 'nomic-embed-text',
    mteb_model_id: 'nomic-embed-text',
    mteb_version: '1.19.10',
    mean_main_score: 0.353055,
    tasks: [
      { task: 'NFCorpus', split: 'test', main_score: 0.18203 },
      { task: 'SciFact', split: 'test', main_score: 0.52408 },
    ],
  });
  await write(CANONICAL_ARTIFACTS.mteb[1].path, {
    kb_model: 'qwen3',
    mteb_model_id: 'dengcao/Qwen3-Embedding-0.6B:Q8_0',
    mteb_version: '1.19.10',
    mean_main_score: 0.487265,
    tasks: [
      { task: 'NFCorpus', split: 'test', main_score: 0.29701 },
      { task: 'SciFact', split: 'test', main_score: 0.67752 },
    ],
  });

  const beir = (model, sha, ndcg) => ({
    git_sha: sha,
    generated_at: '2026-06-08T00:00:00.000Z',
    datasets: ['scifact', 'nfcorpus'],
    env: { embedding_provider: 'ollama', embedding_model: model },
    perMode: [
      {
        mode: 'dense',
        datasetsEvaluated: 2,
        datasetsRequested: 2,
        multiDomainMeanNdcgAt10: ndcg,
        multiDomainMeanPrecisionAt10: 0.07,
        multiDomainMeanRecallAt10: 0.34,
      },
    ],
  });
  await write(CANONICAL_ARTIFACTS.beirMatrix[0].path, beir('nomic-embed-text', '04f3eb8', 0.2547));
  await write(CANONICAL_ARTIFACTS.beirMatrix[1].path, beir('dengcao/Qwen3-Embedding-0.6B:Q8_0', '869d527', 0.3734));

  const bright = (model, sha, ndcg) => ({
    git_sha: sha,
    generated_at: '2026-06-11T00:00:00.000Z',
    provider: 'ollama',
    model,
    split: 'test',
    points: [{ task: 'biology', mode: 'dense', ndcgAt10: ndcg, precisionAt10: 0.078, recallAt10: 0.22, queriesEvaluated: 103 }],
  });
  await write(CANONICAL_ARTIFACTS.bright[0].path, bright('nomic-embed-text', 'abe8012', 0.1767));
  await write(CANONICAL_ARTIFACTS.bright[1].path, bright('dengcao/Qwen3-Embedding-0.6B:Q8_0', 'ee23284', 0.1594));

  return root;
}

test('renders small-model headline numbers with artifact provenance (#943)', async (t) => {
  const root = await seedFixtureRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const output = await generateBenchmarkResultsReferenceMarkdown({ root });

  // Whole rows/lines, so a column swap or a model/number mix-up fails the test —
  // not just "the digits appear somewhere".
  assert.ok(output.includes('### nomic — nomic-embed-text'), 'MTEB nomic heading');
  assert.ok(output.includes('- **Mean main_score (all tasks):** 0.3531'), 'MTEB nomic mean over all tasks');
  assert.ok(output.includes('| <code>NFCorpus</code> | <code>test</code> | 0.1820 |'), 'MTEB nomic NFCorpus row');
  assert.ok(output.includes('| <code>SciFact</code> | <code>test</code> | 0.5241 |'), 'MTEB nomic SciFact row');
  assert.ok(output.includes('### qwen3 — dengcao/Qwen3-Embedding-0.6B:Q8_0'), 'MTEB qwen3 heading');
  assert.ok(output.includes('- **Mean main_score (all tasks):** 0.4873'), 'MTEB qwen3 mean over all tasks');
  assert.ok(output.includes('| <code>SciFact</code> | <code>test</code> | 0.6775 |'), 'MTEB qwen3 SciFact row');
  // BEIR per-mode multi-domain headline, tied to the right model/commit.
  assert.ok(output.includes('### nomic — ollama / nomic-embed-text'), 'BEIR nomic heading');
  assert.ok(output.includes('- **Repo commit at run time:** <code>04f3eb8</code>'), 'BEIR nomic provenance');
  assert.ok(output.includes('| <code>dense</code> | 2/2 | 0.2547 | 0.0700 | 0.3400 |'), 'BEIR nomic dense row');
  assert.ok(output.includes('| <code>dense</code> | 2/2 | 0.3734 | 0.0700 | 0.3400 |'), 'BEIR qwen3 dense row');
  // BRIGHT per-task row with the query count.
  assert.ok(
    output.includes('| <code>biology</code> | <code>dense</code> | 0.1767 | 0.0780 | 0.2200 | 103 |'),
    'BRIGHT nomic row',
  );
  assert.ok(output.includes('- **Repo commit at run time:** <code>ee23284</code>'), 'BRIGHT qwen3 provenance');
  // Not-an-official-leaderboard disclaimer and the metric legend are present.
  assert.match(output, /not official leaderboard/);
  assert.match(output, /All scores run from 0 to 1, and higher is better\./);
});

test('falls back to n/a and escapes table-breaking characters (#943)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-bench-results-sparse-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (relativePath, data) => {
    const absolute = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  };

  // MTEB with a missing mean, no mteb_model_id (fall back to kb_model), and a
  // task that isn't present (NFCorpus) — every gap should render `n/a`.
  await write(CANONICAL_ARTIFACTS.mteb[0].path, {
    kb_model: 'fallback-model',
    mteb_version: '1.19.10',
    tasks: [{ task: 'SciFact', main_score: 0.5 }],
  });
  await write(CANONICAL_ARTIFACTS.mteb[1].path, { kb_model: 'x', mteb_model_id: 'x', mteb_version: 'v', mean_main_score: 0.1, tasks: [] });
  // A model id containing a pipe must not break the Markdown table.
  await write(CANONICAL_ARTIFACTS.beirMatrix[0].path, {
    env: { embedding_provider: 'ollama', embedding_model: 'weird|model' },
    perMode: [],
  });
  // A mode with zero datasets evaluated must not render a producer 0 as a score.
  await write(CANONICAL_ARTIFACTS.beirMatrix[1].path, {
    env: {},
    perMode: [
      { mode: 'late', datasetsEvaluated: 0, datasetsRequested: 5, multiDomainMeanNdcgAt10: 0, multiDomainMeanPrecisionAt10: 0, multiDomainMeanRecallAt10: 0 },
    ],
  });
  await write(CANONICAL_ARTIFACTS.bright[0].path, { provider: 'ollama', model: 'm', points: [] });
  await write(CANONICAL_ARTIFACTS.bright[1].path, { provider: 'ollama', model: 'm', points: [] });

  const output = await generateBenchmarkResultsReferenceMarkdown({ root });

  assert.ok(output.includes('### nomic — fallback-model'), 'falls back to kb_model in the heading');
  assert.match(output, /\*\*Mean main_score \(all tasks\):\*\* n\/a/); // missing mean renders n/a
  assert.match(output, /\| <code>SciFact<\/code> \| n\/a \| 0\.5000 \|/); // missing split renders n/a
  assert.ok(output.includes('weird\\|model'), 'pipe escaped in code cell');
  assert.ok(!output.includes('weird|model'), 'no unescaped pipe leaks into a table');
  assert.match(output, /\*\*Repo commit at run time:\*\* n\/a/); // missing git_sha
  assert.ok(output.includes('| <code>late</code> | 0/5 | n/a | n/a | n/a |'), '0-datasets mode renders n/a, not 0');
});

test('renders a failed BRIGHT point as failed, never as zero scores (#943)', async (t) => {
  const root = await seedFixtureRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // A failed BRIGHT point carries an `error` key and zero metrics
  // (benchmarks/bright/run.ts). The second point has error === "" (a bare
  // `new Error()`), which must still be treated as a failure, not a real zero.
  await fs.writeFile(
    path.join(root, CANONICAL_ARTIFACTS.bright[0].path),
    `${JSON.stringify(
      {
        provider: 'ollama',
        model: 'nomic-embed-text',
        split: 'test',
        points: [
          { task: 'biology', mode: 'dense', ndcgAt10: 0, precisionAt10: 0, recallAt10: 0, queriesEvaluated: 0, error: 'dataset dir missing' },
          { task: 'economics', mode: 'dense', ndcgAt10: 0, precisionAt10: 0, recallAt10: 0, queriesEvaluated: 0, error: '' },
        ],
        caveats: ['Local BRIGHT reproduction, not an official submission.'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const output = await generateBenchmarkResultsReferenceMarkdown({ root });

  assert.ok(
    output.includes('| <code>biology</code> | <code>dense</code> | failed | failed | failed | 0 |'),
    'failed point renders metric cells as failed',
  );
  assert.ok(
    output.includes('> **Failed:** <code>biology</code> / <code>dense</code> — dataset dir missing'),
    'failed point lists its error',
  );
  // An empty error message is still a failure, not a measured zero.
  assert.ok(
    output.includes('| <code>economics</code> | <code>dense</code> | failed | failed | failed | 0 |'),
    'empty-error point renders as failed',
  );
  assert.ok(
    output.includes('> **Failed:** <code>economics</code> / <code>dense</code> — (no error message)'),
    'empty-error point notes the missing message',
  );
  // No misleading zero score for any failed point.
  assert.ok(!/\| <code>(biology|economics)<\/code> \| <code>dense<\/code> \| 0\.0000 \|/.test(output), 'no zero-score row for a failed point');
  // Caveats from the artifact are surfaced.
  assert.ok(output.includes('- Local BRIGHT reproduction, not an official submission.'), 'BRIGHT caveats surfaced');
});

test('throws a clear error when a canonical artifact is missing (#943)', async (t) => {
  const root = await seedFixtureRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await fs.rm(path.join(root, CANONICAL_ARTIFACTS.bright[1].path));
  await assert.rejects(
    generateBenchmarkResultsReferenceMarkdown({ root }),
    /Canonical benchmark artifact missing: benchmarks\/results\/bright\/qwen3\/bright-report\.json/,
  );
});

test('throws a clear error when a canonical artifact is invalid JSON (#943)', async (t) => {
  const root = await seedFixtureRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await fs.writeFile(path.join(root, CANONICAL_ARTIFACTS.mteb[0].path), '{ not json', 'utf8');
  await assert.rejects(
    generateBenchmarkResultsReferenceMarkdown({ root }),
    /is not valid JSON: benchmarks\/results\/mteb\/nomic\.json/,
  );
});

test('the committed reference is in sync with the real repo artifacts (#943)', async () => {
  // Guards against a typo in CANONICAL_ARTIFACTS paths and against a stale
  // committed doc, using the real repo root (not a fixture).
  const fresh = await checkBenchmarkResultsReference();
  assert.equal(fresh.exists, true, 'docs/reference/benchmark-results.md exists');
  assert.equal(fresh.ok, true, 'committed doc matches the committed artifacts');
});

test('check passes when the committed doc matches the artifacts (#943)', async (t) => {
  const root = await seedFixtureRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await writeBenchmarkResultsReference({ root });
  const fresh = await checkBenchmarkResultsReference({ root });
  assert.deepEqual(fresh, { ok: true, exists: true });
});

test('check fails when the doc drifts from the artifacts (#943)', async (t) => {
  const root = await seedFixtureRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const target = path.join(root, BENCHMARK_RESULTS_REFERENCE_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, '# stale\n', 'utf8');

  const stale = await checkBenchmarkResultsReference({ root });
  assert.equal(stale.ok, false);
  assert.equal(stale.exists, true);
});

test('check reports a missing doc (#943)', async (t) => {
  const root = await seedFixtureRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const missing = await checkBenchmarkResultsReference({ root });
  assert.deepEqual(missing, { ok: false, exists: false });
});
