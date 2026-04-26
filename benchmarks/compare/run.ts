// RFC 013 §4.13 M5 orchestrator. Drives two back-to-back per-model bench runs
// and emits a self-contained HTML comparison report.
//
// Surface:
//   npm run bench:compare -- --models=<id_a>,<id_b> [--fixture=small|medium]
//                            [--queries=<path>] [--concurrency=1,4,16]
//                            [--golden=<path>] [--output-dir=<path>]
//                            [--skip-add] [--yes]
//
// The orchestrator never starts the MCP server (no single-instance contention
// with a user's running MCP). It uses the bench harness directly via spawn.

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import type { BenchmarkReport } from '../types.js';
import { installStubProvider } from '../stub.js';
import { renderReport, type CrossModelAggregate, type CrossModelQueryResult } from './render.js';
import { resolveModelCtx, safeChunkChars } from './model-ctx.js';
// Type duplicated locally rather than imported from src/ — tsconfig.bench.json's
// rootDir scopes types to the benchmarks/ tree (src/ files are out of scope even
// for type-only imports). All src-side runtime values are loaded via dynamic
// file:// import keyed off `buildRoot` (matches the warm-query.ts / cold-index.ts
// pattern for FaissIndexManager). If `src/model-id.ts` adds a 4th provider, this
// type and the loader's signature must mirror it.
type EmbeddingProvider = 'huggingface' | 'ollama' | 'openai';

interface CostEstimatesModule {
  estimateCostUsd(provider: EmbeddingProvider, modelName: string, tokens: number): { usd: number; per_million_tokens_usd: number; source: 'rule-of-thumb'; last_verified: string };
  LAST_VERIFIED: string;
}

interface ModelIdModule {
  deriveModelId(provider: EmbeddingProvider, modelName: string): string;
  parseModelId(id: string): { provider: string; slugBody: string };
}

let costEstimatesCache: CostEstimatesModule | undefined;
let modelIdCache: ModelIdModule | undefined;

async function loadCostEstimates(buildRoot: string): Promise<CostEstimatesModule> {
  if (costEstimatesCache) return costEstimatesCache;
  const url = new URL(`file://${path.join(buildRoot, 'cost-estimates.js')}`);
  costEstimatesCache = await import(url.href) as CostEstimatesModule;
  return costEstimatesCache;
}

async function loadModelId(buildRoot: string): Promise<ModelIdModule> {
  if (modelIdCache) return modelIdCache;
  const url = new URL(`file://${path.join(buildRoot, 'model-id.js')}`);
  modelIdCache = await import(url.href) as ModelIdModule;
  return modelIdCache;
}

interface CliFlags {
  models: [string, string];
  fixture: 'small' | 'medium' | 'large' | 'external';
  queriesPath?: string;
  concurrencies: number[];
  goldenPath?: string;
  outputDir: string;
  skipAdd: boolean;
  yes: boolean;
}

interface ResolvedModel {
  id: string;
  provider: EmbeddingProvider;
  name: string;
}

const FIXTURE_FILES: Record<CliFlags['fixture'], number> = {
  small: 30,
  medium: 100,
  large: 600,
  external: 0,
};

const FIXTURE_CHUNKS_PER_FILE: Record<CliFlags['fixture'], number> = {
  small: 5,
  medium: 8,
  large: 5,
  external: 0,
};

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const repoRoot = process.cwd();
  const buildRoot = path.join(repoRoot, 'build');

  // Verify build exists; the orchestrator drives `node build/benchmarks/run.js`.
  await ensureBuilt(buildRoot);

  const modelIdMod = await loadModelId(buildRoot);
  const modelA = resolveModel(flags.models[0], modelIdMod);
  const modelB = resolveModel(flags.models[1], modelIdMod);
  if (modelA.id === modelB.id) {
    fatal(`models resolve to the same id "${modelA.id}". Pick two different models.`);
  }

  // Per-model workspace dirs so cross-model post-step can read both indexes.
  const orchestratorTmp = path.join(os.tmpdir(), `kb-bench-compare-${process.pid}-${Date.now()}`);
  const workspaceA = path.join(orchestratorTmp, 'A');
  const workspaceB = path.join(orchestratorTmp, 'B');
  await fsp.mkdir(workspaceA, { recursive: true });
  await fsp.mkdir(workspaceB, { recursive: true });

  // Single shared knowledge-bases dir so both models embed the SAME corpus.
  // Each model has its own faissIndexPath (per-model layout enforces this anyway).
  const sharedKbRoot = path.join(orchestratorTmp, 'kb-corpus');
  await fsp.mkdir(sharedKbRoot, { recursive: true });

  process.stderr.write(`[bench:compare] orchestrator tmpdir: ${orchestratorTmp}\n`);
  process.stderr.write(`[bench:compare] model A: ${modelA.id}\n`);
  process.stderr.write(`[bench:compare] model B: ${modelB.id}\n`);
  process.stderr.write(`[bench:compare] fixture profile: ${flags.fixture}\n`);

  // Issue #107: probe each model's num_ctx and clamp the shared corpus's
  // chunk size to fit the smaller of the two. Operator override:
  // BENCH_FIXTURE_CHUNK_CHARS=N short-circuits the probe.
  const fixtureChunkChars = await resolveFixtureChunkChars(modelA, modelB);

  // Concurrency invariant (§4.13.9): back-to-back, never parallel.
  process.stderr.write(`[bench:compare] running model A bench…\n`);
  const reportA = await runOnce({
    model: modelA,
    workspace: workspaceA,
    kbRoot: sharedKbRoot,
    flags,
    repoRoot,
    buildRoot,
    isFirst: true,
    fixtureChunkChars,
  });

  process.stderr.write(`[bench:compare] running model B bench…\n`);
  const reportB = await runOnce({
    model: modelB,
    workspace: workspaceB,
    kbRoot: sharedKbRoot,
    flags,
    repoRoot,
    buildRoot,
    isFirst: false,
    fixtureChunkChars,
  });

  process.stderr.write(`[bench:compare] cross-model agreement…\n`);
  // If the parent invocation is a stub bench (BENCH_PROVIDER=stub or models with
  // provider="stub"), install the stub patch in the orchestrator process too so
  // the cross-model phase loads stub-backed managers instead of trying to reach
  // real HF/OpenAI endpoints. A real-provider compare run skips this branch.
  const isStubRun = process.env.BENCH_PROVIDER === 'stub'
    || modelA.provider === ('stub' as EmbeddingProvider)
    || modelB.provider === ('stub' as EmbeddingProvider);
  if (isStubRun) {
    await installStubProvider();
  }
  const queries = await resolveQueries(flags, sharedKbRoot);
  const crossModel = await crossModelAgreement({
    workspaceA,
    workspaceB,
    kbRoot: sharedKbRoot,
    modelA,
    modelB,
    buildRoot,
    queries,
  });

  const cost = await computeCost(modelA, modelB, reportA, reportB, buildRoot);

  process.stderr.write(`[bench:compare] rendering HTML…\n`);
  const html = await renderReport({
    reportA,
    reportB,
    modelA: { id: modelA.id, name: modelA.name },
    modelB: { id: modelB.id, name: modelB.name },
    fixture: { profile: flags.fixture, chunks: reportA.scenarios.cold_index.chunks },
    crossModel,
    cost,
    generatedAt: new Date().toISOString(),
  });

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
  const outBase = `compare-${safeFileSegment(modelA.id)}-vs-${safeFileSegment(modelB.id)}-${stamp}`;
  const outDir = path.resolve(flags.outputDir);
  await fsp.mkdir(outDir, { recursive: true });
  const htmlPath = path.join(outDir, `${outBase}.html`);
  const jsonPath = path.join(outDir, `${outBase}.json`);

  await fsp.writeFile(htmlPath, html, 'utf-8');
  await fsp.writeFile(jsonPath, JSON.stringify({
    modelA: { id: modelA.id, provider: modelA.provider, name: modelA.name },
    modelB: { id: modelB.id, provider: modelB.provider, name: modelB.name },
    reportA,
    reportB,
    crossModel,
    cost,
    generatedAt: new Date().toISOString(),
  }, null, 2) + '\n', 'utf-8');

  // Cleanup orchestrator tmpdir on success; preserve on failure for debugging.
  try {
    await fsp.rm(orchestratorTmp, { recursive: true, force: true });
  } catch {
    // best-effort
  }

  process.stderr.write(`[bench:compare] done\n`);
  process.stdout.write(`Report: ${htmlPath}\n`);
  process.stdout.write(`JSON:   ${jsonPath}\n`);
}

interface RunOnceArgs {
  model: ResolvedModel;
  workspace: string;
  kbRoot: string;
  flags: CliFlags;
  repoRoot: string;
  buildRoot: string;
  isFirst: boolean;
  // Issue #107: clamped chunk size (chars) for the shared corpus, propagated
  // to the bench leg via BENCH_FIXTURE_CHUNK_CHARS. undefined = leg uses its
  // default (1000).
  fixtureChunkChars?: number;
}

async function runOnce(args: RunOnceArgs): Promise<BenchmarkReport> {
  const faissPath = path.join(args.workspace, '.faiss');
  await fsp.mkdir(faissPath, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BENCH_PROVIDER: providerForBench(args.model.provider),
    BENCH_MODEL_NAME: args.model.name,
    BENCH_MODEL_ID: args.model.id,
    BENCH_WORKSPACE_ROOT: args.workspace,
    BENCH_FAISS_INDEX_PATH: faissPath,
    BENCH_KNOWLEDGE_BASES_ROOT_DIR: args.kbRoot,
    BENCH_RESULTS_PREFIX: `compare-leg-${safeFileSegment(args.model.id)}`,
    // Redirect per-leg JSONs to the orchestrator's tmpdir — the merged
    // comparison JSON next to the HTML report is what survives.
    BENCH_RESULTS_DIR: args.workspace,
    BENCH_BATCH_CONCURRENCIES: args.flags.concurrencies.join(','),
    ...(args.flags.queriesPath ? { BENCH_QUERIES: path.resolve(args.flags.queriesPath) } : {}),
    ...(args.fixtureChunkChars !== undefined
      ? {
          BENCH_FIXTURE_CHUNK_CHARS: String(args.fixtureChunkChars),
          // Production FaissIndexManager re-splits the on-disk markdown with
          // its own splitter (default chunkSize=1000). Without this, the
          // bench-side fixture clamp is moot — the production splitter would
          // re-emit 1000-char chunks that bust short-context embed models.
          // KB_CHUNK_SIZE wires the same clamp into the production code path.
          KB_CHUNK_SIZE: String(args.fixtureChunkChars),
        }
      : {}),
  };

  const benchScript = path.join(args.buildRoot, 'benchmarks', 'run.js');
  const benchOutput = await spawnNode(benchScript, env, args.repoRoot);

  // run.ts writes the result file path to stdout (last line).
  const resultPath = benchOutput.trim().split('\n').pop() ?? '';
  if (!resultPath || !resultPath.endsWith('.json')) {
    fatal(`bench leg did not emit a result-file path on stdout. Got:\n${benchOutput}`);
  }

  const raw = await fsp.readFile(resultPath, 'utf-8');
  const report = JSON.parse(raw) as BenchmarkReport;
  return report;
}

function spawnNode(script: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`bench subprocess exited with code ${code}`));
    });
  });
}

interface CrossModelArgs {
  workspaceA: string;
  workspaceB: string;
  kbRoot: string;
  modelA: ResolvedModel;
  modelB: ResolvedModel;
  buildRoot: string;
  queries: string[];
}

interface ManagerLike {
  initialize(): Promise<void>;
  similaritySearch(query: string, k: number, threshold?: number): Promise<{ pageContent: string; metadata: Record<string, unknown>; score?: number }[]>;
  updateIndex(knowledgeBaseName?: string): Promise<void>;
}

interface ManagerCtor { new (): ManagerLike }

async function crossModelAgreement(args: CrossModelArgs): Promise<CrossModelAggregate> {
  // Load A
  const managerA = await loadManagerFor(args.workspaceA, args.kbRoot, args.modelA, args.buildRoot, 'A');
  const topKsA = await runQueriesAgainstManager(managerA, args.queries);

  // Load B (separate process-env mutation for each — bench leg already wrote
  // the indexes, we just open them read-only here).
  const managerB = await loadManagerFor(args.workspaceB, args.kbRoot, args.modelB, args.buildRoot, 'B');
  const topKsB = await runQueriesAgainstManager(managerB, args.queries);

  const perQuery: CrossModelQueryResult[] = args.queries.map((q, i) => {
    const a = topKsA[i] ?? [];
    const b = topKsB[i] ?? [];
    return {
      query: q,
      jaccard: jaccard(a.map((r) => r.doc), b.map((r) => r.doc)),
      topK_a: a,
      topK_b: b,
    };
  });

  const jaccards = perQuery.map((q) => q.jaccard).sort((x, y) => x - y);
  const spearmans = perQuery.map((q) => spearmanOnOverlap(q.topK_a.map((r) => r.doc), q.topK_b.map((r) => r.doc)));

  const overlapDocs = new Set<string>();
  perQuery.forEach((q) => {
    const seenA = new Set(q.topK_a.map((r) => r.doc));
    q.topK_b.forEach((r) => { if (seenA.has(r.doc)) overlapDocs.add(r.doc); });
  });

  return {
    jaccard_p50: pct(jaccards, 50),
    jaccard_p95: pct(jaccards, 95),
    spearman_p50: pct(spearmans, 50),
    overlap_doc_count: overlapDocs.size,
    per_query: perQuery,
  };
}

async function loadManagerFor(
  workspace: string,
  kbRoot: string,
  model: ResolvedModel,
  buildRoot: string,
  label: string,
): Promise<ManagerLike> {
  // Mutate env so the manager picks up the right path + provider/model. For a
  // stub-mode orchestrator run, treat `stub` as `huggingface` (the stub patches
  // the HF embeddings module).
  const provider = model.provider === ('stub' as EmbeddingProvider) ? 'huggingface' : model.provider;
  process.env.FAISS_INDEX_PATH = path.join(workspace, '.faiss');
  process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
  process.env.EMBEDDING_PROVIDER = provider;
  if (provider === 'huggingface') {
    process.env.HUGGINGFACE_MODEL_NAME = model.name;
    process.env.HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY ?? 'bench-hf-key';
  } else if (provider === 'ollama') {
    process.env.OLLAMA_MODEL = model.name;
  } else {
    process.env.OPENAI_MODEL_NAME = model.name;
  }

  const url = new URL(`file://${path.join(buildRoot, 'FaissIndexManager.js')}?cross-${label}-${Date.now()}`);
  const mod = await import(url.href) as { FaissIndexManager: ManagerCtor };
  const manager = new mod.FaissIndexManager();
  await manager.initialize();
  return manager;
}

async function runQueriesAgainstManager(
  manager: ManagerLike,
  queries: string[],
): Promise<{ doc: string; score: number }[][]> {
  const out: { doc: string; score: number }[][] = [];
  for (const q of queries) {
    try {
      const results = await manager.similaritySearch(q, 10);
      out.push(results.map((r) => ({
        doc: String(r.metadata.source ?? r.metadata.relativePath ?? r.pageContent.slice(0, 40)),
        score: r.score ?? 0,
      })));
    } catch {
      out.push([]);
    }
  }
  return out;
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  setA.forEach((v) => { if (setB.has(v)) inter += 1; });
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : Number((inter / union).toFixed(4));
}

function spearmanOnOverlap(a: string[], b: string[]): number {
  // Spearman ρ on docs that appear in both rankings; 0 if overlap < 2.
  const setA = new Set(a);
  const overlap = b.filter((doc) => setA.has(doc));
  if (overlap.length < 2) return 0;
  const rankA = (doc: string) => a.indexOf(doc);
  const rankB = (doc: string) => b.indexOf(doc);
  const n = overlap.length;
  let sumD2 = 0;
  for (const doc of overlap) {
    const d = rankA(doc) - rankB(doc);
    sumD2 += d * d;
  }
  const rho = 1 - (6 * sumD2) / (n * (n * n - 1));
  return Number(rho.toFixed(4));
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[i].toFixed(4));
}

interface CostBreakdown {
  model_a_usd: number;
  model_b_usd: number;
  source: 'rule-of-thumb';
  last_verified: string;
}

async function computeCost(
  a: ResolvedModel,
  b: ResolvedModel,
  reportA: BenchmarkReport,
  reportB: BenchmarkReport,
  buildRoot: string,
): Promise<CostBreakdown> {
  const costMod = await loadCostEstimates(buildRoot);
  // Rule-of-thumb: 4 bytes per token, 800 bytes per chunk.
  const tokensA = Math.ceil(reportA.scenarios.cold_index.chunks * 800 / 4);
  const tokensB = Math.ceil(reportB.scenarios.cold_index.chunks * 800 / 4);
  return {
    model_a_usd: costMod.estimateCostUsd(a.provider, a.name, tokensA).usd,
    model_b_usd: costMod.estimateCostUsd(b.provider, b.name, tokensB).usd,
    source: 'rule-of-thumb',
    last_verified: costMod.LAST_VERIFIED,
  };
}

async function resolveQueries(flags: CliFlags, kbRoot: string): Promise<string[]> {
  if (flags.queriesPath) {
    const raw = await fsp.readFile(flags.queriesPath, 'utf-8');
    return raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  }
  // Default: pull queries-default.txt OR derive from synthetic fixture.
  // For the synthetic small/medium fixtures, prose queries return nothing
  // useful; fall back to fixture-derived queries (one per file, token slices)
  // so the cross-model phase has signal.
  if (flags.fixture === 'small' || flags.fixture === 'medium') {
    return await deriveQueriesFromFixture(kbRoot, 30);
  }
  // For large/external/arxiv-like corpora, prose queries make sense.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'queries-default.txt'),
    path.join(here, '..', '..', '..', 'benchmarks', 'compare', 'queries-default.txt'),
    path.resolve(process.cwd(), 'benchmarks', 'compare', 'queries-default.txt'),
  ];
  for (const candidate of candidates) {
    try {
      const raw = await fsp.readFile(candidate, 'utf-8');
      return raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    } catch {
      // try next
    }
  }
  return [];
}

async function deriveQueriesFromFixture(kbRoot: string, max: number): Promise<string[]> {
  const queries: string[] = [];
  const kbDirs = await fsp.readdir(kbRoot, { withFileTypes: true });
  for (const dirent of kbDirs) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
    const files = await fsp.readdir(path.join(kbRoot, dirent.name), { withFileTypes: true });
    for (const fileEnt of files) {
      if (queries.length >= max) break;
      if (!fileEnt.isFile() || fileEnt.name.startsWith('.')) continue;
      const content = await fsp.readFile(path.join(kbRoot, dirent.name, fileEnt.name), 'utf-8');
      const tokens = content.split(/\s+/).filter(Boolean);
      if (tokens.length < 32) continue;
      queries.push(tokens.slice(12, 32).join(' '));
    }
    if (queries.length >= max) break;
  }
  return queries;
}

async function ensureBuilt(buildRoot: string): Promise<void> {
  const probe = path.join(buildRoot, 'benchmarks', 'run.js');
  try {
    await fsp.stat(probe);
  } catch {
    fatal(`expected built bench harness at ${probe}. Run \`npm run build && npx tsc -p tsconfig.bench.json\` first.`);
  }
}

function resolveModel(idOrSpec: string, mod: ModelIdModule): ResolvedModel {
  // Accept either a model_id ("provider__slug") or a "provider:modelName" form.
  if (idOrSpec.includes(':') && !idOrSpec.includes('__')) {
    const [providerRaw, ...rest] = idOrSpec.split(':');
    const provider = providerRaw as EmbeddingProvider;
    const name = rest.join(':');
    return { id: mod.deriveModelId(provider, name), provider, name };
  }
  try {
    const parsed = mod.parseModelId(idOrSpec);
    return {
      id: idOrSpec,
      provider: parsed.provider as EmbeddingProvider,
      name: parsed.slugBody, // the slug — best-effort recover; the bench just needs SOMETHING here for env vars
    };
  } catch (err) {
    fatal(`invalid model spec "${idOrSpec}": ${(err as Error).message}`);
  }
}

function providerForBench(provider: EmbeddingProvider | 'stub'): 'stub' | 'huggingface' | 'ollama' | 'openai' {
  return provider;
}

function safeFileSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

function parseFlags(argv: string[]): CliFlags {
  const flags: Partial<CliFlags> = {
    fixture: 'medium',
    concurrencies: [1, 4, 16],
    outputDir: 'benchmarks/results',
    skipAdd: false,
    yes: false,
  };
  for (const arg of argv) {
    if (arg.startsWith('--models=')) {
      const parts = arg.slice('--models='.length).split(',');
      if (parts.length !== 2) fatal('--models requires exactly two comma-separated ids');
      flags.models = [parts[0].trim(), parts[1].trim()];
    } else if (arg.startsWith('--fixture=')) {
      const value = arg.slice('--fixture='.length);
      if (!['small', 'medium', 'large', 'external'].includes(value)) {
        fatal(`--fixture must be one of small|medium|large|external; got "${value}"`);
      }
      flags.fixture = value as CliFlags['fixture'];
    } else if (arg.startsWith('--queries=')) {
      flags.queriesPath = arg.slice('--queries='.length);
    } else if (arg.startsWith('--concurrency=')) {
      const parsed = arg.slice('--concurrency='.length).split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (parsed.length === 0) fatal('--concurrency requires comma-separated positive numbers');
      flags.concurrencies = parsed;
    } else if (arg.startsWith('--golden=')) {
      flags.goldenPath = arg.slice('--golden='.length);
    } else if (arg.startsWith('--output-dir=')) {
      flags.outputDir = arg.slice('--output-dir='.length);
    } else if (arg === '--skip-add') {
      flags.skipAdd = true;
    } else if (arg === '--yes') {
      flags.yes = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      fatal(`unknown flag: ${arg}`);
    }
  }
  if (!flags.models) {
    fatal('--models=<id_a>,<id_b> is required');
  }
  return flags as CliFlags;
}

function printHelp(): void {
  process.stderr.write(`Usage: npm run bench:compare -- --models=<id_a>,<id_b> [options]

Required:
  --models=<id_a>,<id_b>   Two model_ids (e.g. ollama__nomic-embed-text-latest,huggingface__BAAI-bge-small-en-v1.5)
                            or provider:name pairs (ollama:nomic-embed-text,openai:text-embedding-3-small).

Optional:
  --fixture=small|medium|large|external   Default: medium.
  --queries=<path>                         File with one query per line (#-comments allowed).
  --concurrency=1,4,16                     Batch concurrency sweep (default 1,4,16).
  --golden=<path>                          JSON {query: [doc_paths]} for recall@k.
  --output-dir=<path>                      Default: benchmarks/results/.
  --skip-add                               Reuse already-registered models (no re-embed).
  --yes                                    Non-interactive (skips paid-provider cost prompt).
`);
}

/**
 * Issue #107: probe each model's num_ctx and clamp the shared corpus's
 * MarkdownTextSplitter chunkSize to fit the smaller of the two. Both bench
 * legs share the same corpus, so the clamp is applied across both rather
 * than per-model — otherwise Jaccard / Spearman cross-model agreement would
 * be measuring chunking-policy drift instead of embedding-quality drift.
 *
 * Operator override: setting BENCH_FIXTURE_CHUNK_CHARS=N upstream of the
 * orchestrator short-circuits the probe entirely.
 */
async function resolveFixtureChunkChars(
  modelA: ResolvedModel,
  modelB: ResolvedModel,
): Promise<number | undefined> {
  // Operator override — respect their value and skip the probe.
  if (process.env.BENCH_FIXTURE_CHUNK_CHARS) {
    const overridden = Number(process.env.BENCH_FIXTURE_CHUNK_CHARS);
    if (Number.isFinite(overridden) && overridden > 0) {
      process.stderr.write(
        `[bench:compare] BENCH_FIXTURE_CHUNK_CHARS=${overridden} override; skipping num_ctx probe.\n`,
      );
      return Math.floor(overridden);
    }
  }

  const [ctxA, ctxB] = await Promise.all([
    resolveModelCtx(modelA.provider, modelA.name),
    resolveModelCtx(modelB.provider, modelB.name),
  ]);
  const chunkChars = safeChunkChars(ctxA, ctxB);
  process.stderr.write(
    `[bench:compare] model A num_ctx=${ctxA}, model B num_ctx=${ctxB} → chunk_chars=${chunkChars} (safe for both)\n`,
  );
  return chunkChars;
}

function fatal(msg: string): never {
  process.stderr.write(`bench:compare: ${msg}\n`);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`bench:compare: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
