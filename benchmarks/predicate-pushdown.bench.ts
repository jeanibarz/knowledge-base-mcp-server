// benchmarks/predicate-pushdown.bench.ts — Issue #283.
//
// Standalone benchmark comparing the FAISS post-filter overfetch ladder
// (the pre-#283 default for any metadata-filtered search) against the
// new predicate-pushdown sidecar fast-path. Both paths run against an
// in-memory simulator that mirrors the real `FaissIndexManager.similaritySearch`
// orchestration: the simulator owns a synthetic distance map, applies
// the same `createSimilaritySearchPostFilter`, and the same
// `progressiveFetchSizes` ladder (loaded from the built `src/` modules
// at runtime so this benchmark drifts with the real implementation).
//
// Run with:
//   npm run build && tsc -p tsconfig.bench.json
//   node build/benchmarks/predicate-pushdown.bench.js
//
// Or with a custom corpus / selectivity:
//   BENCH_PUSHDOWN_NTOTAL=20000 BENCH_PUSHDOWN_SELECTIVITY=0.005 \
//     node build/benchmarks/predicate-pushdown.bench.js
//
// Exits 0 on completion. The script does not assert a budget; the
// `benchmark-harness` CI job does not invoke it. Operators reading the
// PR body for #283 use the printed table to decide whether the fast-path
// is worth keeping in their hot path.

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

interface SyntheticVector {
  docstoreId: string;
  metadata: Record<string, unknown>;
  // baseline distance ranking in [0, 1]; smaller means more similar.
  distance: number;
}

// Minimal structural type for the SimilaritySearchFilters surface we use.
interface FiltersInput {
  extensions?: readonly string[];
  pathGlob?: string;
  tags?: readonly string[];
}

interface PostFilterModule {
  createSimilaritySearchPostFilter(opts: {
    threshold: number;
    knowledgeBasesRootDir: string;
    knowledgeBaseName?: string;
    filters?: FiltersInput;
  }): {
    requiresOverfetch: boolean;
    apply(scored: ReadonlyArray<readonly [unknown, number]>): Array<readonly [unknown, number]>;
  };
}

interface FaissModule {
  progressiveFetchSizes(k: number, ntotal: number): number[];
}

interface SidecarModule {
  writeMetadataSidecar(opts: {
    sidecarPath: string;
    modelId: string;
    rows: ReadonlyArray<{
      docstoreId: string;
      knowledgeBase: string;
      source: string;
      relativePath: string;
      extension: string;
      tags: readonly string[];
    }>;
  }): Promise<void>;
  readMetadataSidecar(opts: { sidecarPath: string; modelId: string }): Promise<{
    candidateIds(filter: {
      knowledgeBaseName?: string;
      knowledgeBasesRootDir?: string;
      extensions?: readonly string[];
      pathGlob?: string;
      tags?: readonly string[];
    }): string[];
    totalChunks: number;
  } | null>;
  toSidecarFilter(opts: {
    knowledgeBaseName?: string;
    knowledgeBasesRootDir: string;
    filters?: FiltersInput;
  }): {
    knowledgeBaseName?: string;
    knowledgeBasesRootDir?: string;
    extensions?: readonly string[];
    pathGlob?: string;
    tags?: readonly string[];
  };
  recommendFastPathFetchK(opts: { k: number; candidates: number; ntotal: number }): number | null;
}

const repoRoot = process.cwd();
const buildRoot = process.env.BENCH_BUILD_ROOT ?? path.join(repoRoot, 'build');

async function loadModules(): Promise<{
  filters: PostFilterModule;
  faiss: FaissModule;
  sidecar: SidecarModule;
}> {
  // Cache-bust the dynamic import so successive runs see the latest built JS.
  const stamp = Date.now();
  const filters = (await import(
    new URL(`file://${path.join(buildRoot, 'search-filters.js')}?bench=pushdown-filters-${stamp}`).href,
  )) as PostFilterModule;
  const faiss = (await import(
    new URL(`file://${path.join(buildRoot, 'FaissIndexManager.js')}?bench=pushdown-faiss-${stamp}`).href,
  )) as FaissModule;
  const sidecar = (await import(
    new URL(`file://${path.join(buildRoot, 'metadata-sidecar.js')}?bench=pushdown-sidecar-${stamp}`).href,
  )) as SidecarModule;
  return { filters, faiss, sidecar };
}

function buildSyntheticCorpus(opts: {
  ntotal: number;
  selectivity: number;
  seed: number;
}): SyntheticVector[] {
  const { ntotal, selectivity, seed } = opts;
  const knowledgeBases = ['kb-alpha', 'kb-beta', 'kb-gamma', 'kb-delta'];
  const extensions = ['.md', '.txt', '.pdf', '.json'];
  const tags = ['ops', 'design', 'research', 'qa', 'misc'];
  const candidateThreshold = Math.max(1, Math.round(ntotal * selectivity));

  const random = mulberry32(seed);
  const vectors: SyntheticVector[] = [];
  for (let i = 0; i < ntotal; i += 1) {
    const isCandidate = i < candidateThreshold;
    const kb = isCandidate ? 'kb-alpha' : knowledgeBases[i % knowledgeBases.length];
    const ext = isCandidate ? '.md' : extensions[(i + 1) % extensions.length];
    const tag = isCandidate ? 'ops' : tags[i % tags.length];
    vectors.push({
      docstoreId: String(i),
      distance: random(),
      metadata: {
        knowledgeBase: kb,
        source: `/kb/${kb}/file-${i}${ext}`,
        relativePath: `${kb}/file-${i}${ext}`,
        extension: ext,
        tags: [tag],
        chunkIndex: 0,
      },
    });
  }
  return vectors;
}

class FaissSimulator {
  private faissCalls = 0;
  private readonly sorted: SyntheticVector[];

  constructor(vectors: SyntheticVector[]) {
    // Sort once; each search returns the top-k slice.
    this.sorted = [...vectors].sort((a, b) => a.distance - b.distance);
  }

  similaritySearchWithScore(_query: string, k: number): Array<readonly [
    { pageContent: string; metadata: Record<string, unknown> },
    number,
  ]> {
    this.faissCalls += 1;
    const slice = this.sorted.slice(0, Math.min(k, this.sorted.length));
    return slice.map((v) => [
      { pageContent: `c-${v.docstoreId}`, metadata: v.metadata },
      v.distance,
    ] as const);
  }

  totalVectors(): number { return this.sorted.length; }
  getCallCount(): number { return this.faissCalls; }
  resetCallCount(): void { this.faissCalls = 0; }
}

interface SearchPath {
  label: string;
  run(): { results: number; faissCalls: number; lastFetchK: number };
}

function buildBaselinePath(opts: {
  simulator: FaissSimulator;
  filters: FiltersInput;
  knowledgeBaseName?: string;
  knowledgeBasesRootDir: string;
  k: number;
  modules: { filters: PostFilterModule; faiss: FaissModule };
}): SearchPath {
  const postFilter = opts.modules.filters.createSimilaritySearchPostFilter({
    threshold: 2,
    knowledgeBasesRootDir: opts.knowledgeBasesRootDir,
    knowledgeBaseName: opts.knowledgeBaseName,
    filters: opts.filters,
  });
  return {
    label: 'baseline (post-filter ladder)',
    run() {
      opts.simulator.resetCallCount();
      const ntotal = opts.simulator.totalVectors();
      const fetchSizes = opts.modules.faiss.progressiveFetchSizes(opts.k, ntotal);
      let filtered: ReturnType<typeof postFilter.apply> = [];
      let lastFetchK = opts.k;
      for (const fetchK of fetchSizes) {
        lastFetchK = fetchK;
        const raw = opts.simulator.similaritySearchWithScore('q', fetchK);
        filtered = postFilter.apply(raw);
        if (filtered.length >= opts.k) break;
        if (raw.length < fetchK) break;
      }
      return {
        results: Math.min(filtered.length, opts.k),
        faissCalls: opts.simulator.getCallCount(),
        lastFetchK,
      };
    },
  };
}

function buildFastPath(opts: {
  simulator: FaissSimulator;
  filters: FiltersInput;
  knowledgeBaseName?: string;
  knowledgeBasesRootDir: string;
  k: number;
  candidateCount: number;
  modules: { filters: PostFilterModule; faiss: FaissModule; sidecar: SidecarModule };
}): SearchPath {
  const postFilter = opts.modules.filters.createSimilaritySearchPostFilter({
    threshold: 2,
    knowledgeBasesRootDir: opts.knowledgeBasesRootDir,
    knowledgeBaseName: opts.knowledgeBaseName,
    filters: opts.filters,
  });
  return {
    label: 'fast-path (sidecar predicate-pushdown)',
    run() {
      opts.simulator.resetCallCount();
      const ntotal = opts.simulator.totalVectors();
      if (opts.candidateCount === 0) {
        return { results: 0, faissCalls: 0, lastFetchK: 0 };
      }
      const recommended = opts.modules.sidecar.recommendFastPathFetchK({
        k: opts.k,
        candidates: opts.candidateCount,
        ntotal,
      });
      let lastFetchK = opts.k;
      let filtered: ReturnType<typeof postFilter.apply> = [];
      if (recommended !== null) {
        lastFetchK = recommended;
        const raw = opts.simulator.similaritySearchWithScore('q', recommended);
        filtered = postFilter.apply(raw);
        const fastPathSatisfied = filtered.length >= opts.k || raw.length < recommended;
        if (fastPathSatisfied) {
          return {
            results: Math.min(filtered.length, opts.k),
            faissCalls: opts.simulator.getCallCount(),
            lastFetchK,
          };
        }
      }
      const fetchSizes = opts.modules.faiss.progressiveFetchSizes(opts.k, ntotal);
      for (const fetchK of fetchSizes) {
        lastFetchK = fetchK;
        const raw = opts.simulator.similaritySearchWithScore('q', fetchK);
        filtered = postFilter.apply(raw);
        if (filtered.length >= opts.k) break;
        if (raw.length < fetchK) break;
      }
      return {
        results: Math.min(filtered.length, opts.k),
        faissCalls: opts.simulator.getCallCount(),
        lastFetchK,
      };
    },
  };
}

function timePath(searchPath: SearchPath, repetitions: number): {
  median_ms: number;
  faiss_calls: number;
  last_fetch_k: number;
  results: number;
} {
  const samples: number[] = [];
  let lastResult = searchPath.run();
  for (let i = 0; i < repetitions; i += 1) {
    const start = process.hrtime.bigint();
    lastResult = searchPath.run();
    const end = process.hrtime.bigint();
    samples.push(Number(end - start) / 1_000_000);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return {
    median_ms: Number(median.toFixed(3)),
    faiss_calls: lastResult.faissCalls,
    last_fetch_k: lastResult.lastFetchK,
    results: lastResult.results,
  };
}

async function main(): Promise<void> {
  const ntotal = parsePositiveInt(process.env.BENCH_PUSHDOWN_NTOTAL) ?? 10_000;
  const selectivity = parsePositiveFloat(process.env.BENCH_PUSHDOWN_SELECTIVITY) ?? 0.01;
  const k = parsePositiveInt(process.env.BENCH_PUSHDOWN_K) ?? 10;
  const repetitions = parsePositiveInt(process.env.BENCH_PUSHDOWN_REPETITIONS) ?? 50;

  process.stdout.write(
    `predicate-pushdown.bench: ntotal=${ntotal} selectivity=${selectivity} k=${k} repetitions=${repetitions}\n`,
  );

  const modules = await loadModules();
  const vectors = buildSyntheticCorpus({ ntotal, selectivity, seed: 17 });
  const simulator = new FaissSimulator(vectors);
  const filters: FiltersInput = { extensions: ['.md'], tags: ['ops'] };
  const knowledgeBaseName = 'kb-alpha';
  const knowledgeBasesRootDir = '/kb';

  // Round-trip the sidecar through disk so the candidate count we feed
  // the fast-path matches what an operator's on-disk JSONL would produce.
  const sidecarDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-sidecar-bench-'));
  const sidecarPath = path.join(sidecarDir, 'metadata-sidecar.jsonl');
  const sidecarRows = vectors.map((v) => ({
    docstoreId: v.docstoreId,
    knowledgeBase: v.metadata.knowledgeBase as string,
    source: v.metadata.source as string,
    relativePath: v.metadata.relativePath as string,
    extension: v.metadata.extension as string,
    tags: (v.metadata.tags as string[]) ?? [],
  }));
  await modules.sidecar.writeMetadataSidecar({
    sidecarPath, modelId: 'bench-model', rows: sidecarRows,
  });
  const sidecar = await modules.sidecar.readMetadataSidecar({ sidecarPath, modelId: 'bench-model' });
  if (sidecar === null) throw new Error('bench: failed to read back the sidecar we just wrote');
  const sidecarFilter = modules.sidecar.toSidecarFilter({
    knowledgeBaseName, knowledgeBasesRootDir, filters,
  });
  const candidateCount = sidecar.candidateIds(sidecarFilter).length;

  const baseline = buildBaselinePath({
    simulator, filters, knowledgeBaseName, knowledgeBasesRootDir, k, modules,
  });
  const fast = buildFastPath({
    simulator, filters, knowledgeBaseName, knowledgeBasesRootDir, k, candidateCount, modules,
  });
  const baselineMetrics = timePath(baseline, repetitions);
  const fastMetrics = timePath(fast, repetitions);

  process.stdout.write('\n');
  process.stdout.write(
    `candidates from sidecar: ${candidateCount} ` +
      `(selectivity = ${(candidateCount / ntotal * 100).toFixed(3)}%)\n\n`,
  );
  process.stdout.write(`${baseline.label.padEnd(48)}  ${formatMetrics(baselineMetrics)}\n`);
  process.stdout.write(`${fast.label.padEnd(48)}  ${formatMetrics(fastMetrics)}\n\n`);
  const delta = fastMetrics.median_ms === 0 ? 'inf'
    : (((baselineMetrics.median_ms - fastMetrics.median_ms) / baselineMetrics.median_ms) * 100).toFixed(2);
  const callDelta = fastMetrics.faiss_calls === 0 ? 'infx'
    : `${(baselineMetrics.faiss_calls / Math.max(1, fastMetrics.faiss_calls)).toFixed(2)}x`;
  process.stdout.write(`fast-path latency reduction: ${delta}% — fewer FAISS calls: ${callDelta}\n`);

  await fsp.rm(sidecarDir, { recursive: true, force: true });
}

function formatMetrics(metrics: ReturnType<typeof timePath>): string {
  return [
    `median=${metrics.median_ms.toFixed(3)}ms`,
    `faiss_calls=${metrics.faiss_calls}`,
    `last_fetchK=${metrics.last_fetch_k}`,
    `results=${metrics.results}`,
  ].join('  ');
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parsePositiveFloat(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function mulberry32(seed: number): () => number {
  let current = seed >>> 0;
  return () => {
    current += 0x6d2b79f5;
    let t = current;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
