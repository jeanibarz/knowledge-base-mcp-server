#!/usr/bin/env node
// Rebuild a beir-matrix.{json,md} summary from per-cell BEIR run artifacts
// already on disk — the cells of a matrix that was produced by individual
// `benchmarks/beir/run.js` invocations (e.g. resumed/parallelized sweeps)
// rather than one `bench:beir:matrix` process. Reuses the matrix module's own
// markdown renderer, Δ_g computation, and contamination registry so the output
// is byte-compatible with a single-process matrix run. Every number comes from
// a cell results.json; a missing cell is recorded as an error cell, never
// interpolated.
//
// Usage:
//   node benchmarks/scripts/merge_beir_matrix.mjs \
//     --dir=benchmarks/results/beir/matrix/qwen3 \
//     --datasets=scifact,nfcorpus,fiqa,arguana,scidocs \
//     --modes=lexical,late,dense,hybrid,hybrid+late,hybrid+rerank,hybrid+rerank+contextual \
//     --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0

import * as fsp from 'fs/promises';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const build = (p) => path.join(repoRoot, 'build', 'benchmarks', 'beir', p);
const { formatMatrixMarkdown, MATRIX_SCHEMA_VERSION, captureRetrievalEnv } = await import(build('matrix.js'));
const { computeGeneralizationReport } = await import(build('generalization.js'));
const { getRegistryEntry, domainOf, assertRegistryInvariants } = await import(build('registry.js'));

const args = Object.fromEntries(
  process.argv.slice(2).map((t) => {
    const [flag, value] = t.split(/=(.*)/s, 2);
    return [flag.replace(/^--/, ''), value];
  }),
);
for (const required of ['dir', 'datasets', 'modes']) {
  if (!args[required]) throw new Error(`--${required}= is required`);
}
const outputDir = path.resolve(args.dir);
const datasets = args.datasets.split(',');
const modes = args.modes.split(',');

assertRegistryInvariants();

// lexical and late run at source granularity, everything else at chunk.
const unitFor = (mode) => (mode === 'lexical' || mode === 'late' ? 'source' : 'chunk');

async function readCell(dataset, mode) {
  const base = `kb-${dataset}-${mode}-${unitFor(mode)}`;
  const jsonPath = path.join(outputDir, `${base}-results.json`);
  const trecPath = path.join(outputDir, `${base}-run.trec`);
  let report;
  try {
    report = JSON.parse(await fsp.readFile(jsonPath, 'utf-8'));
  } catch (error) {
    return {
      dataset,
      domain: domainOf(dataset),
      mode,
      status: 'error',
      ndcgAt10: 0,
      precisionAt10: 0,
      mapAt100: 0,
      recallAt10: 0,
      recallAt100: 0,
      queriesEvaluated: 0,
      latencyP50Ms: 0,
      latencyP95Ms: 0,
      latencyP99Ms: 0,
      jsonPath: null,
      trecPath: null,
      error: `cell artifact missing or unreadable: ${path.relative(repoRoot, jsonPath)} (${error.message})`,
    };
  }
  const m = report.metrics;
  const l = report.latency;
  return {
    dataset,
    domain: domainOf(dataset),
    mode,
    status: 'ok',
    ndcgAt10: m.ndcgAt10,
    precisionAt10: m.precisionAt10,
    mapAt100: m.mapAt100,
    recallAt10: m.recallAt10,
    recallAt100: m.recallAt100,
    queriesEvaluated: m.judgedQueries,
    latencyP50Ms: l.p50Ms,
    latencyP95Ms: l.p95Ms,
    latencyP99Ms: l.p99Ms,
    jsonPath: path.relative(repoRoot, jsonPath),
    trecPath: path.relative(repoRoot, trecPath),
  };
}

const meanOrNull = (values) =>
  values.length === 0 ? null : Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(6));

// Mode-major cell order, matching runBeirMatrix.
const cells = [];
for (const mode of modes) {
  for (const dataset of datasets) {
    cells.push(await readCell(dataset, mode));
  }
}

const okCells = cells.filter((c) => c.status === 'ok');
const perMode = modes.map((mode) => {
  const modeCells = okCells.filter((c) => c.mode === mode);
  return {
    mode,
    datasetsEvaluated: modeCells.length,
    datasetsRequested: datasets.length,
    multiDomainMeanNdcgAt10: meanOrNull(modeCells.map((c) => c.ndcgAt10)),
    multiDomainMeanPrecisionAt10: meanOrNull(modeCells.map((c) => c.precisionAt10)),
    multiDomainMeanRecallAt10: meanOrNull(modeCells.map((c) => c.recallAt10)),
  };
});

const generalization = computeGeneralizationReport(
  okCells.map((c) => ({
    dataset: c.dataset,
    mode: c.mode,
    ndcgAt10: c.ndcgAt10,
    precisionAt10: c.precisionAt10,
    queriesEvaluated: c.queriesEvaluated,
  })),
  modes,
);

const gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' }).trim();

const report = {
  schema_version: MATRIX_SCHEMA_VERSION,
  generated_at: new Date().toISOString(),
  git_sha: gitSha,
  modes,
  datasets,
  env: captureRetrievalEnv({ provider: args.provider, model: args.model }),
  cells,
  perMode,
  generalization,
  contamination: datasets.map((dataset) => {
    const entry = getRegistryEntry(dataset);
    return {
      dataset,
      knownInPretraining: entry?.contamination.knownInPretraining ?? false,
      qrels: entry?.contamination.qrels ?? 'unknown',
      note: entry?.contamination.note ?? 'not in registry',
    };
  }),
};

await fsp.writeFile(path.join(outputDir, 'beir-matrix.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
await fsp.writeFile(path.join(outputDir, 'beir-matrix.md'), formatMatrixMarkdown(report), 'utf-8');

for (const summary of perMode) {
  process.stdout.write(
    `${summary.mode}\tmean nDCG@10=${summary.multiDomainMeanNdcgAt10 ?? 'n/a'}\t(${summary.datasetsEvaluated}/${summary.datasetsRequested} datasets)\n`,
  );
}
const failures = cells.filter((c) => c.status === 'error');
if (failures.length > 0) {
  process.stdout.write(`missing/error cells: ${failures.map((c) => `${c.dataset}×${c.mode}`).join(', ')}\n`);
}
