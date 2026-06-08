import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { pathToFileURL } from 'url';
import {
  aggregateQueryMetrics,
  formatTrecRun,
  parseQrelsTsv,
  scoreQuery,
  summarizeLatencies,
  type Qrels,
  type RankedDocument,
  type QueryMetric,
} from './metrics.js';
import { durationMs, ensureDirectory, gitSha, resetDirectory, writeJsonFile } from '../utils.js';

const execFileAsync = promisify(execFile);

const DATASET_URLS: Record<string, string> = {
  arguana: 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/arguana.zip',
  'climate-fever': 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/climate-fever.zip',
  'dbpedia-entity': 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/dbpedia-entity.zip',
  fever: 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/fever.zip',
  fiqa: 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/fiqa.zip',
  hotpotqa: 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/hotpotqa.zip',
  nfcorpus: 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/nfcorpus.zip',
  nq: 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/nq.zip',
  quora: 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/quora.zip',
  scifact: 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip',
  scidocs: 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scidocs.zip',
  'trec-covid': 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/trec-covid.zip',
  'webis-touche2020': 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/webis-touche2020.zip',
};

// v3 (RFC 020 M1): added `hybrid+rerank` / `hybrid+rerank+contextual` modes
// (driven by the production `src/reranker.ts` cross-encoder and the RFC 017
// contextual-preface ingest path) plus the `rerank` / `contextual` provenance
// blocks. v2 added `dense`/`hybrid` + precision@10 + `embedding`; v1 was
// lexical-only.
const BENCHMARK_SCHEMA_VERSION = 'kb.beir-benchmark.v3';
type LexicalUnit = 'chunk' | 'source';
// RFC 020 §1 — the retrieval-mode space the runner can score. `lexical` is
// credential-free (BM25 only); the rest drive the production embedding + RRF +
// cross-encoder + contextual-preface paths in `src/` and therefore require an
// embedding provider (and, for `+contextual`, an LLM endpoint at ingest).
export type BeirMode =
  | 'lexical'
  | 'dense'
  | 'hybrid'
  | 'hybrid+rerank'
  | 'hybrid+rerank+contextual';
const BEIR_MODES: readonly BeirMode[] = [
  'lexical',
  'dense',
  'hybrid',
  'hybrid+rerank',
  'hybrid+rerank+contextual',
];

function isBeirMode(value: string): value is BeirMode {
  return (BEIR_MODES as readonly string[]).includes(value);
}

// Every non-lexical mode drives an embedding provider and the dense backend.
function usesEmbeddingProvider(mode: BeirMode): boolean {
  return mode !== 'lexical';
}

// The production `SearchMode` a BeirMode maps onto. The rerank/contextual
// variants all retrieve through the hybrid RRF path; reranking is enabled via
// the production `KB_RERANK` config and contextual prefaces via the production
// `KB_CONTEXTUAL_RETRIEVAL` ingest path — never a benchmark-only reimplementation.
function beirSearchMode(mode: BeirMode): 'dense' | 'hybrid' {
  return mode === 'dense' ? 'dense' : 'hybrid';
}

function modeEnablesRerank(mode: BeirMode): boolean {
  return mode === 'hybrid+rerank' || mode === 'hybrid+rerank+contextual';
}

function modeEnablesContextual(mode: BeirMode): boolean {
  return mode === 'hybrid+rerank+contextual';
}

// Mirrors `src/config/reranker.ts` defaults. Recorded as provenance only; the
// runner does not re-implement the reranker — it flips the production
// `KB_RERANK` flag and the shipped hybrid path drives `src/reranker.ts`.
const DEFAULT_RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
const DEFAULT_RERANK_TOP_N = 40;

interface Args {
  dataset: string;
  split: string;
  mode: BeirMode;
  lexicalUnit: LexicalUnit;
  // Embedding provider/model for `dense`/`hybrid`. `provider` defaults to
  // `EMBEDDING_PROVIDER`; resolution + the fail-loud check happen in
  // `runBeirBenchmark` so a `--config` env block can still set them.
  provider?: string;
  model?: string;
  retrievalViews?: string;
  outputDir: string;
  cacheDir: string;
  workspaceRoot: string;
  datasetDir?: string;
  datasetUrl?: string;
  k: number;
  chunkK: number;
  candidatePoolK?: number;
  maxQueries?: number;
  keepWorkspace: boolean;
}

type BeirConfigKey =
  | 'dataset'
  | 'split'
  | 'mode'
  | 'lexical_unit'
  | 'lexicalUnit'
  | 'provider'
  | 'model'
  | 'retrieval_views'
  | 'retrievalViews'
  | 'output_dir'
  | 'outputDir'
  | 'cache_dir'
  | 'cacheDir'
  | 'workspace_root'
  | 'workspaceRoot'
  | 'dataset_dir'
  | 'datasetDir'
  | 'dataset_url'
  | 'datasetUrl'
  | 'k'
  | 'chunk_k'
  | 'chunkK'
  | 'candidate_pool_k'
  | 'candidatePoolK'
  | 'max_queries'
  | 'maxQueries'
  | 'keep_workspace'
  | 'keepWorkspace';

interface BeirCorpusRow {
  _id: string;
  title?: string;
  text?: string;
}

interface BeirQueryRow {
  _id: string;
  text: string;
}

interface CorpusPreparation {
  kbName: string;
  kbPath: string;
  docIdByRelativePath: Map<string, string>;
  documents: number;
}

export interface LexicalIndexLike {
  refresh(): Promise<{ added: number; updated: number; removed: number; failed: number; totalFiles: number; totalChunks: number }>;
  save(): Promise<void>;
  query(query: string, k: number, options?: { unit?: LexicalUnit; candidateK?: number }): Promise<Array<{ metadata: Record<string, unknown>; score: number }>>;
  numChunks(): number;
  numFiles(): number;
}

interface LexicalIndexModule {
  LexicalIndex: {
    load(kbName: string, kbPath: string): Promise<LexicalIndexLike>;
  };
}

// -- Dense / hybrid retrieval backend ---------------------------------------
//
// RFC 020 §1 (failure mode "benchmark-only retrieval path drifts from
// production"): the dense and hybrid modes MUST exercise the same retrieval
// code the product ships. This backend is a thin port over the production
// `src/` entrypoints — `FaissIndexManager.similaritySearch` (dense) and the
// `retrieval-eval` orchestrator's hybrid RRF fusion (`src/hybrid-retrieval`),
// both reached through `retrieveForRetrievalEvalCase`. The runner never
// re-implements ranking; it only materializes the corpus, builds the index
// via `updateIndex`, maps hits back to BEIR doc ids, and scores against qrels.

export interface BeirRankedChunk {
  metadata: Record<string, unknown>;
  /**
   * The leg-native score (dense distance or fused RRF score). The runner does
   * NOT rank on this value — `collapseRankedChunksToDocuments` preserves the
   * order the production path already returned, because dense scores are
   * distances (lower = better) while RRF scores are higher = better. It is
   * kept only for diagnostics.
   */
  score: number;
}

export interface BeirSearchBackendPrepareResult {
  files: number;
  chunks: number;
}

export interface BeirSearchBackend {
  /** Build/refresh the production index for the materialized corpus KB. */
  prepare(): Promise<BeirSearchBackendPrepareResult>;
  /**
   * Retrieve ranked chunks for a query through the production retrieval path.
   * Results are returned best-first; `fetchK` is the chunk-level depth (before
   * collapsing chunks to BEIR documents).
   */
  search(query: string, fetchK: number): Promise<BeirRankedChunk[]>;
  /** Human-readable description of the production entrypoint exercised. */
  implementation: string;
}

export interface LoadSearchBackendInput {
  buildRoot: string;
  mode: 'dense' | 'hybrid';
  provider: string;
  modelName: string;
  kbName: string;
  retrievalViews?: string;
}

interface BeirBenchmarkReport {
  schema_version: typeof BENCHMARK_SCHEMA_VERSION;
  generated_at: string;
  git_sha: string;
  command: string;
  dataset: {
    name: string;
    split: string;
    source_url: string | null;
    checksum_sha256: string;
    corpus_documents: number;
    queries_total: number;
    qrels_queries: number;
    queries_evaluated: number;
  };
  mode: Args['mode'];
  // Embedding provenance for dense/hybrid runs; null for credential-free
  // lexical runs. Recorded so committed baselines are tagged with the exact
  // (provider, model) that produced them (RFC 020 §4).
  embedding: {
    provider: string;
    model: string;
  } | null;
  // Cross-encoder rerank provenance (RFC 020 §3/§7 — baselines record the exact
  // rerank model + topN). Present (enabled true) only for `hybrid+rerank[...]`
  // modes; `enabled: false` for plain hybrid/dense; null for lexical.
  rerank: {
    enabled: boolean;
    model: string;
    topN: number;
  } | null;
  // RFC 017 contextual-preface provenance. `enabled` true only for
  // `hybrid+rerank+contextual`; the prefaces are generated at ingest by the
  // production `buildChunkDocuments` path and embedded into chunk + BM25 text.
  contextual: {
    enabled: boolean;
  } | null;
  ranking: {
    unit: LexicalUnit;
    implementation: string;
    trec_run: string;
    k: number;
    chunk_candidate_k: number;
  };
  chunking: {
    KB_CHUNK_SIZE: string | null;
    KB_CHUNK_OVERLAP: string | null;
  };
  runtime: {
    node_version: string;
    python_version: string | null;
    os: string;
    arch: string;
  };
  indexing: {
    ms: number;
    // Present only for lexical runs (the LexicalIndex refresh summary). Dense
    // and hybrid runs build the FAISS index via FaissIndexManager.updateIndex
    // and report files/chunks without the lexical refresh shape.
    refresh?: Awaited<ReturnType<LexicalIndexLike['refresh']>>;
    files: number;
    chunks: number;
  };
  metrics: ReturnType<typeof aggregateQueryMetrics>;
  high_recall_candidates?: {
    schema_version: 'kb.beir.high-recall-candidates.v1';
    candidate_pool_k: number;
    final_k: number;
    candidate_recall_at100: number;
    candidate_metrics: ReturnType<typeof aggregateQueryMetrics>;
  };
  latency: ReturnType<typeof summarizeLatencies>;
  per_query: QueryMetric[];
  caveats: string[];
}

export interface BeirBenchmarkRunResult {
  jsonPath: string;
  trecPath: string;
  reportPath: string;
  report: BeirBenchmarkReport;
}

export interface RunDependencies {
  gitSha(repoRoot: string): Promise<string>;
  loadLexicalIndex(buildRoot: string, kbName: string, kbPath: string): Promise<LexicalIndexLike>;
  loadSearchBackend(input: LoadSearchBackendInput): Promise<BeirSearchBackend>;
  now(): Date;
  pythonVersion(): Promise<string | null>;
  silenceServerLogger(buildRoot: string): Promise<void>;
}

const defaultRunDependencies: RunDependencies = {
  gitSha,
  loadLexicalIndex,
  loadSearchBackend,
  now: () => new Date(),
  pythonVersion,
  silenceServerLogger,
};

async function main(): Promise<void> {
  const result = await runBeirBenchmark(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${result.jsonPath}\n${result.trecPath}\n${result.reportPath}\n`);
}

export async function runBeirBenchmark(
  args: Args,
  dependencies: RunDependencies = defaultRunDependencies,
): Promise<BeirBenchmarkRunResult> {
  await assertSafeWorkspaceRoot(args.workspaceRoot, args.outputDir);
  await ensureDirectory(args.outputDir);
  await resetDirectory(args.workspaceRoot);

  const dataset = await ensureDataset(args);
  const queries = await readJsonlFile<BeirQueryRow>(path.join(dataset.datasetDir, 'queries.jsonl'));
  const qrelsPath = path.join(dataset.datasetDir, 'qrels', `${args.split}.tsv`);
  const qrels = parseQrelsTsv(await fsp.readFile(qrelsPath, 'utf-8'));
  const selectedQueries = selectQueries(queries, qrels, args.maxQueries);

  const knowledgeBasesRootDir = path.join(args.workspaceRoot, 'knowledge-bases');
  const faissIndexPath = path.join(args.workspaceRoot, '.faiss');
  const prepared = await prepareCorpus({
    datasetName: args.dataset,
    datasetDir: dataset.datasetDir,
    knowledgeBasesRootDir,
  });

  const buildRoot = path.join(process.cwd(), 'build');
  configureBenchmarkEnvironment(knowledgeBasesRootDir, faissIndexPath);
  await dependencies.silenceServerLogger(buildRoot);

  // RFC 020 §1 — flip the production stage flags (`KB_RERANK`,
  // `KB_CONTEXTUAL_RETRIEVAL`) deterministically per mode so each run is
  // self-contained even inside the in-process sweep/baseline loops, and restore
  // them afterwards. The shipped hybrid path reads these via the production
  // config resolvers, so the rerank/contextual stages run through `src/`.
  const restoreStageEnv = applyStageEnvironment(args.mode);
  let retrieval: RetrievalOutcome;
  try {
    retrieval = usesEmbeddingProvider(args.mode)
      ? await runDenseRetrieval({ args, prepared, qrels, selectedQueries, buildRoot, dependencies })
      : await runLexicalRetrieval({ args, prepared, qrels, selectedQueries, buildRoot, dependencies });
  } finally {
    restoreStageEnv();
  }
  const { queryRows, perQuery, candidatePerQuery, latenciesMs, indexMs, indexing, ranking: rankingMeta, embedding } = retrieval;
  const stages = resolveStageProvenance(args.mode);

  const runTag = `kb-${args.dataset}-${args.mode}-${rankingMeta.unit}`;
  const trecPath = path.join(args.outputDir, `${runTag}-run.trec`);
  const jsonPath = path.join(args.outputDir, `${runTag}-results.json`);
  const reportPath = path.join(args.outputDir, `${runTag}-report.md`);
  await fsp.writeFile(trecPath, formatTrecRun(queryRows, runTag), 'utf-8');

  const report: BeirBenchmarkReport = {
    schema_version: BENCHMARK_SCHEMA_VERSION,
    generated_at: dependencies.now().toISOString(),
    git_sha: await dependencies.gitSha(process.cwd()),
    command: formatBenchmarkCommand(args),
    dataset: {
      name: args.dataset,
      split: args.split,
      source_url: dataset.sourceUrl,
      checksum_sha256: dataset.checksumSha256,
      corpus_documents: prepared.documents,
      queries_total: queries.length,
      qrels_queries: qrels.byQuery.size,
      queries_evaluated: selectedQueries.length,
    },
    mode: args.mode,
    embedding,
    rerank: stages.rerank,
    contextual: stages.contextual,
    ranking: {
      unit: rankingMeta.unit,
      implementation: rankingMeta.implementation,
      trec_run: portablePath(trecPath),
      k: args.k,
      chunk_candidate_k: args.chunkK,
    },
    chunking: {
      KB_CHUNK_SIZE: process.env.KB_CHUNK_SIZE ?? null,
      KB_CHUNK_OVERLAP: process.env.KB_CHUNK_OVERLAP ?? null,
    },
    runtime: {
      node_version: process.version,
      python_version: await dependencies.pythonVersion(),
      os: os.platform(),
      arch: os.arch(),
    },
    indexing: {
      ms: Number(indexMs.toFixed(3)),
      ...(indexing.refresh !== undefined ? { refresh: indexing.refresh } : {}),
      files: indexing.files,
      chunks: indexing.chunks,
    },
    metrics: aggregateQueryMetrics(perQuery),
    ...(candidatePerQuery !== undefined && args.candidatePoolK !== undefined
      ? {
          high_recall_candidates: {
            schema_version: 'kb.beir.high-recall-candidates.v1',
            candidate_pool_k: args.candidatePoolK,
            final_k: args.k,
            candidate_recall_at100: aggregateQueryMetrics(candidatePerQuery).recallAt100,
            candidate_metrics: aggregateQueryMetrics(candidatePerQuery),
          },
        }
      : {}),
    latency: summarizeLatencies(latenciesMs),
    per_query: perQuery,
    caveats: buildCaveats(args),
  };

  await writeJsonFile(jsonPath, report);
  await fsp.writeFile(reportPath, formatMarkdownReport(report, portablePath(trecPath), portablePath(jsonPath)), 'utf-8');

  if (!args.keepWorkspace) {
    await fsp.rm(args.workspaceRoot, { recursive: true, force: true });
  }

  return { jsonPath, trecPath, reportPath, report };
}

interface RetrievalOutcome {
  queryRows: Array<{ queryId: string; ranking: RankedDocument[] }>;
  perQuery: QueryMetric[];
  candidatePerQuery?: QueryMetric[];
  latenciesMs: number[];
  indexMs: number;
  indexing: {
    refresh?: Awaited<ReturnType<LexicalIndexLike['refresh']>>;
    files: number;
    chunks: number;
  };
  ranking: { unit: LexicalUnit; implementation: string };
  embedding: BeirBenchmarkReport['embedding'];
}

interface RetrievalInput {
  args: Args;
  prepared: CorpusPreparation;
  qrels: Qrels;
  selectedQueries: BeirQueryRow[];
  buildRoot: string;
  dependencies: RunDependencies;
}

async function runLexicalRetrieval(input: RetrievalInput): Promise<RetrievalOutcome> {
  const { args, prepared, qrels, selectedQueries, buildRoot, dependencies } = input;
  const lexicalIndex = await dependencies.loadLexicalIndex(buildRoot, prepared.kbName, prepared.kbPath);
  const indexStarted = process.hrtime.bigint();
  const refresh = await lexicalIndex.refresh();
  await lexicalIndex.save();
  const indexMs = durationMs(indexStarted, process.hrtime.bigint());

  const queryRows: Array<{ queryId: string; ranking: RankedDocument[] }> = [];
  const perQuery: QueryMetric[] = [];
  const candidatePerQuery: QueryMetric[] = [];
  const latenciesMs: number[] = [];
  for (const query of selectedQueries) {
    const started = process.hrtime.bigint();
    const fetchK = args.candidatePoolK ?? (args.lexicalUnit === 'source' ? args.k : args.chunkK);
    const chunks = await lexicalIndex.query(query.text, fetchK, {
      unit: args.lexicalUnit,
      candidateK: args.candidatePoolK ?? args.chunkK,
    });
    latenciesMs.push(durationMs(started, process.hrtime.bigint()));
    const ranking = collapseChunksToDocuments(chunks, prepared.docIdByRelativePath, args.k);
    queryRows.push({ queryId: query._id, ranking });
    const scored = scoreQuery(query._id, ranking, qrels);
    if (scored !== null) perQuery.push(scored);
    if (args.candidatePoolK !== undefined) {
      const candidateRanking = collapseChunksToDocuments(chunks, prepared.docIdByRelativePath, 100);
      const candidateScored = scoreQuery(query._id, candidateRanking, qrels);
      if (candidateScored !== null) candidatePerQuery.push(candidateScored);
    }
  }

  return {
    queryRows,
    perQuery,
    ...(args.candidatePoolK !== undefined ? { candidatePerQuery } : {}),
    latenciesMs,
    indexMs,
    indexing: { refresh, files: lexicalIndex.numFiles(), chunks: lexicalIndex.numChunks() },
    ranking: {
      unit: args.lexicalUnit,
      implementation: args.lexicalUnit === 'source'
        ? 'LexicalIndex source BM25 over whole files, returning one representative chunk per source'
        : 'LexicalIndex chunk BM25 collapsed by BEIR document id using max chunk score',
    },
    embedding: null,
  };
}

async function runDenseRetrieval(input: RetrievalInput): Promise<RetrievalOutcome> {
  const { args, prepared, qrels, selectedQueries, buildRoot, dependencies } = input;
  if (!usesEmbeddingProvider(args.mode)) {
    throw new Error(`runDenseRetrieval called for non-dense mode ${args.mode}`);
  }
  // RFC 020 §1 — "+contextual" prefaces are generated at ingest by the LLM; a
  // missing endpoint must fail loudly, not silently degrade to a non-contextual
  // run that would mislabel its number (mirrors the no-provider check above).
  if (modeEnablesContextual(args.mode) && !contextualEndpointConfigured()) {
    throw new Error(
      `BEIR --mode=${args.mode} needs an LLM endpoint to generate RFC 017 contextual prefaces at ingest, ` +
        'but none is configured. Set KB_LLM_ENDPOINT (e.g. a local Ollama/OpenAI-compatible chat endpoint), ' +
        'or set KB_LLM_FAKE=on for a deterministic, network-free self-test.',
    );
  }
  const spec = resolveEmbeddingSpec(args);
  const backend = await dependencies.loadSearchBackend({
    buildRoot,
    // The production retrieval mode (dense vs hybrid RRF). Rerank/contextual are
    // layered on by the stage flags, not by a distinct retrieval entrypoint.
    mode: beirSearchMode(args.mode),
    provider: spec.provider,
    modelName: spec.model,
    kbName: prepared.kbName,
    retrievalViews: args.retrievalViews,
  });

  const indexStarted = process.hrtime.bigint();
  const prep = await backend.prepare();
  const indexMs = durationMs(indexStarted, process.hrtime.bigint());

  const queryRows: Array<{ queryId: string; ranking: RankedDocument[] }> = [];
  const perQuery: QueryMetric[] = [];
  const candidatePerQuery: QueryMetric[] = [];
  const latenciesMs: number[] = [];
  for (const query of selectedQueries) {
    const started = process.hrtime.bigint();
    // Fetch at chunk depth, then collapse to BEIR documents. The production
    // path returns chunks best-first; collapse preserves that order.
    const chunks = await backend.search(query.text, args.candidatePoolK ?? args.chunkK);
    latenciesMs.push(durationMs(started, process.hrtime.bigint()));
    const ranking = collapseRankedChunksToDocuments(chunks, prepared.docIdByRelativePath, args.k);
    queryRows.push({ queryId: query._id, ranking });
    const scored = scoreQuery(query._id, ranking, qrels);
    if (scored !== null) perQuery.push(scored);
    if (args.candidatePoolK !== undefined) {
      const candidateRanking = collapseRankedChunksToDocuments(chunks, prepared.docIdByRelativePath, 100);
      const candidateScored = scoreQuery(query._id, candidateRanking, qrels);
      if (candidateScored !== null) candidatePerQuery.push(candidateScored);
    }
  }

  return {
    queryRows,
    perQuery,
    ...(args.candidatePoolK !== undefined ? { candidatePerQuery } : {}),
    latenciesMs,
    indexMs,
    indexing: { files: prep.files, chunks: prep.chunks },
    ranking: { unit: 'chunk', implementation: describeImplementation(backend.implementation, args.mode) },
    embedding: { provider: spec.provider, model: spec.model },
  };
}

// Append the active stage(s) to the backend's base implementation string so the
// report names the exact production paths exercised (RFC 020 §1).
function describeImplementation(base: string, mode: BeirMode): string {
  const stages: string[] = [];
  if (modeEnablesRerank(mode)) {
    stages.push('+ src/reranker.ts cross-encoder rerank (production KB_RERANK path)');
  }
  if (modeEnablesContextual(mode)) {
    stages.push('+ RFC 017 contextual prefaces at ingest (production buildChunkDocuments path)');
  }
  return stages.length === 0 ? base : `${base} ${stages.join(' ')}`;
}

// Read-only mirror of `src/config/contextual-preface.ts`
// `resolveContextualLlmEndpoint`: an endpoint exists when the fake LLM is on or
// KB_LLM_ENDPOINT is non-empty. Replicated locally so the runner module stays
// free of any static `src/` import (the env vars it reads are the same).
function contextualEndpointConfigured(): boolean {
  const fake = (process.env.KB_LLM_FAKE ?? '').trim().toLowerCase();
  if (fake === 'on' || fake === 'true' || fake === '1' || fake === 'yes') return true;
  return (process.env.KB_LLM_ENDPOINT ?? '').trim() !== '';
}

interface StageProvenance {
  rerank: BeirBenchmarkReport['rerank'];
  contextual: BeirBenchmarkReport['contextual'];
}

// Provenance blocks recorded on the report. Derived from the mode (not from a
// post-hoc env read) so the record is stable regardless of resolution order.
function resolveStageProvenance(mode: BeirMode): StageProvenance {
  if (!usesEmbeddingProvider(mode)) {
    return { rerank: null, contextual: null };
  }
  const rerankEnabled = modeEnablesRerank(mode);
  return {
    rerank: {
      enabled: rerankEnabled,
      model: process.env.KB_RERANK_MODEL?.trim() || DEFAULT_RERANK_MODEL,
      topN: rerankEnabled ? parseRerankTopNEnv(process.env.KB_RERANK_TOP_N) : DEFAULT_RERANK_TOP_N,
    },
    contextual: { enabled: modeEnablesContextual(mode) },
  };
}

function parseRerankTopNEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_RERANK_TOP_N;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_RERANK_TOP_N;
}

/**
 * Flip the production stage flags for the requested mode and return a restore
 * closure. The shipped hybrid path reads `KB_RERANK` (search-time rerank) and
 * the ingest path reads `KB_CONTEXTUAL_RETRIEVAL` (preface generation); setting
 * them explicitly — ON for the stage's modes, OFF otherwise — makes each run
 * self-contained even when several modes run in one process (sweep/baseline).
 */
function applyStageEnvironment(mode: BeirMode): () => void {
  const previous: Record<string, string | undefined> = {
    KB_RERANK: process.env.KB_RERANK,
    KB_CONTEXTUAL_RETRIEVAL: process.env.KB_CONTEXTUAL_RETRIEVAL,
  };
  if (usesEmbeddingProvider(mode)) {
    process.env.KB_RERANK = modeEnablesRerank(mode) ? 'on' : 'off';
    process.env.KB_CONTEXTUAL_RETRIEVAL = modeEnablesContextual(mode) ? 'on' : 'off';
  }
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function applyRetrievalViewsEnvironment(retrievalViews: string | undefined): () => void {
  const previous = process.env.KB_RETRIEVAL_VIEWS;
  if (retrievalViews !== undefined && retrievalViews.trim() !== '') {
    process.env.KB_RETRIEVAL_VIEWS = retrievalViews;
  }
  return () => {
    if (previous === undefined) delete process.env.KB_RETRIEVAL_VIEWS;
    else process.env.KB_RETRIEVAL_VIEWS = previous;
  };
}

/**
 * Resolve the embedding provider/model for a dense/hybrid run, failing loudly
 * (RFC 020 §1 — "mode availability is reported, not silently skipped"). The
 * provider comes from `--provider` or `EMBEDDING_PROVIDER`; the model from
 * `--model` or the provider's model env var. `fake` is the deterministic,
 * network-free provider for hermetic self-tests.
 */
export function resolveEmbeddingSpec(args: Args): { provider: string; model: string } {
  const provider = (args.provider ?? process.env.EMBEDDING_PROVIDER ?? '').trim();
  if (provider === '') {
    throw new Error(
      `BEIR --mode=${args.mode} requires an embedding provider, but none is configured. ` +
        'Set EMBEDDING_PROVIDER (e.g. "ollama" for a local daemon), pass --provider, ' +
        'or use --provider=fake for a hermetic, network-free self-test. ' +
        '(`kb doctor` reports the active provider and its health.)',
    );
  }
  const model = (args.model ?? defaultModelForProvider(provider)).trim();
  if (model === '') {
    throw new Error(
      `BEIR --mode=${args.mode} with provider "${provider}" requires an embedding model, ` +
        'but none is configured. Pass --model or set the provider model env var ' +
        '(OLLAMA_MODEL / OPENAI_MODEL_NAME / HUGGINGFACE_MODEL_NAME).',
    );
  }
  return { provider, model };
}

function defaultModelForProvider(provider: string): string {
  switch (provider) {
    case 'fake':
      return process.env.KB_FAKE_MODEL ?? 'fake-embeddings';
    case 'ollama':
      return process.env.OLLAMA_MODEL ?? '';
    case 'openai':
      return process.env.OPENAI_MODEL_NAME ?? '';
    case 'huggingface':
      return process.env.HUGGINGFACE_MODEL_NAME ?? '';
    default:
      return '';
  }
}

/**
 * Collapse ranked chunks to BEIR documents while PRESERVING retrieval order.
 *
 * Unlike the lexical `collapseChunksToDocuments` (which maxes a BM25 score per
 * document), this keeps each document's first (best) appearance in the
 * already-ranked chunk list and assigns a strictly decreasing rank score. This
 * is mode-agnostic on purpose: dense scores are distances (lower = better)
 * while hybrid RRF scores are higher = better, so re-sorting by the raw score
 * would invert dense rankings. The decreasing rank score keeps external
 * `trec_eval` reproducing the same order the production path returned.
 */
function collapseRankedChunksToDocuments(
  chunks: ReadonlyArray<BeirRankedChunk>,
  docIdByRelativePath: Map<string, string>,
  k: number,
): RankedDocument[] {
  const seen = new Set<string>();
  const docIds: string[] = [];
  for (const chunk of chunks) {
    const docId = docIdFromMetadata(chunk.metadata, docIdByRelativePath);
    if (docId === null || seen.has(docId)) continue;
    seen.add(docId);
    docIds.push(docId);
    if (docIds.length >= k) break;
  }
  return docIds.map((docId, index) => ({ docId, score: docIds.length - index }));
}

function buildCaveats(args: Args): string[] {
  const caveats = [
    'This is a local BEIR benchmark, not an official leaderboard submission.',
    'Scores are document-level for BEIR qrels.',
    'MLflow logging is not required for JSON/TREC artifacts; optional logging is expected to come from the bench observability hook.',
  ];
  if (args.mode === 'lexical') {
    caveats.push('Lexical mode requires no provider credentials.');
    caveats.push('Source ranking is the same public lexical unit exposed by kb search --lexical-unit=source.');
  } else {
    caveats.push(
      'Dense/hybrid retrieval is driven by the production src/ paths ' +
        '(FaissIndexManager.similaritySearch + src/hybrid-retrieval RRF), not a benchmark-only reimplementation.',
    );
    caveats.push(
      'Dense/hybrid require a real embedding provider; the fake provider is deterministic but has no ' +
        'semantic geometry, so fake-provider numbers are self-test smoke only — never a quality baseline.',
    );
    if (modeEnablesRerank(args.mode)) {
      caveats.push(
        'Rerank is the production src/reranker.ts cross-encoder (enabled via KB_RERANK); the default ' +
          'transformers.js model downloads on first use, so a rerank run needs network or a cached model.',
      );
    }
    if (modeEnablesContextual(args.mode)) {
      caveats.push(
        'Contextual prefaces are the RFC 017 ingest path (KB_CONTEXTUAL_RETRIEVAL); each chunk costs an ' +
          'LLM call at index time, cached in the sidecar. The fake LLM (KB_LLM_FAKE=on) is self-test only.',
      );
    }
  }
  return caveats;
}

// Default dense/hybrid backend: a thin port over the production src/ retrieval
// entrypoints, loaded from the compiled `build/` tree at runtime (the same
// dynamic-import seam the lexical leg uses, which keeps this benchmark module
// under `benchmarks/` rootDir without a static cross-tree import).
interface FaissManagerLike {
  initialize(): Promise<void>;
  updateIndex(specificKnowledgeBase?: string, options?: { force?: boolean }): Promise<void>;
  getLastIndexUpdateSummary(): { files_scanned: number; chunks_added: number };
  similaritySearch(
    query: string,
    k: number,
    threshold?: number,
    knowledgeBaseName?: string,
  ): Promise<Array<{ metadata: Record<string, unknown>; score?: number }>>;
}

interface FaissIndexManagerModule {
  FaissIndexManager: {
    new (opts: { provider: string; modelName: string }): FaissManagerLike;
    bootstrapLayout(): Promise<void>;
  };
}

interface RetrievalEvalModule {
  retrieveForRetrievalEvalCase(
    fixtureCase: Record<string, unknown>,
    context: {
      manager: Pick<FaissManagerLike, 'similaritySearch'>;
      defaultK: number;
      defaultThreshold: number;
    },
    requestedMode: string,
  ): Promise<{ results: Array<{ metadata: Record<string, unknown>; score?: number }> }>;
}

async function loadSearchBackend(input: LoadSearchBackendInput): Promise<BeirSearchBackend> {
  const fimUrl = pathToFileURL(path.join(input.buildRoot, 'FaissIndexManager.js')).href;
  const evalUrl = pathToFileURL(path.join(input.buildRoot, 'retrieval-eval.js')).href;
  const fimModule = (await import(fimUrl)) as FaissIndexManagerModule;
  const evalModule = (await import(evalUrl)) as RetrievalEvalModule;

  const { FaissIndexManager } = fimModule;
  await FaissIndexManager.bootstrapLayout();
  const manager = new FaissIndexManager({ provider: input.provider, modelName: input.modelName });
  await manager.initialize();

  return {
    implementation: input.mode === 'dense'
      ? 'src/FaissIndexManager.similaritySearch (production dense path) via retrieval-eval.retrieveForRetrievalEvalCase'
      : 'src/hybrid-retrieval RRF fusion (production hybrid path) via retrieval-eval.retrieveForRetrievalEvalCase',
    prepare: async () => {
      const restoreViews = applyRetrievalViewsEnvironment(input.retrievalViews);
      try {
        await manager.updateIndex(undefined, { force: input.retrievalViews !== undefined });
      } finally {
        restoreViews();
      }
      const summary = manager.getLastIndexUpdateSummary();
      return { files: summary.files_scanned, chunks: summary.chunks_added };
    },
    search: async (query, fetchK) => {
      const result = await evalModule.retrieveForRetrievalEvalCase(
        {
          name: 'beir',
          query,
          kb: input.kbName,
          k: fetchK,
          threshold: Number.POSITIVE_INFINITY,
          requiredSources: [],
          forbiddenSources: [],
          expectedMetadata: [],
          stalePolicy: 'allow_stale',
          ...(input.retrievalViews !== undefined ? { retrievalViews: input.retrievalViews } : {}),
        },
        { manager, defaultK: fetchK, defaultThreshold: Number.POSITIVE_INFINITY },
        input.mode,
      );
      return result.results.map((r) => ({
        metadata: r.metadata,
        score: typeof r.score === 'number' ? r.score : 0,
      }));
    },
  };
}

export function parseArgs(argv: string[]): Args {
  const repoRoot = process.cwd();
  const args: Args = {
    dataset: 'scifact',
    split: 'test',
    mode: 'lexical',
    lexicalUnit: 'source',
    outputDir: path.join(repoRoot, 'benchmarks', 'results'),
    cacheDir: process.env.BEIR_CACHE_DIR ?? path.join(os.tmpdir(), 'kb-beir-cache'),
    workspaceRoot: path.join(os.tmpdir(), `kb-beir-${process.pid}-${Date.now()}`),
    k: 100,
    chunkK: 1000,
    keepWorkspace: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const [flag, inlineValue] = token.includes('=') ? token.split(/=(.*)/s, 2) : [token, undefined];
    if (flag !== '--config') continue;
    const configPath = inlineValue ?? argv[i + 1];
    if (configPath === undefined || configPath.startsWith('--')) {
      throw new Error('--config requires a value');
    }
    applyBenchmarkConfig(args, path.resolve(configPath));
    if (inlineValue === undefined) i += 1;
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const [flag, inlineValue] = token.includes('=') ? token.split(/=(.*)/s, 2) : [token, undefined];
    const readValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      i += 1;
      const value = argv[i];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
      }
      return value;
    };

    if (flag === '--dataset') {
      args.dataset = readValue();
    } else if (flag === '--split') {
      args.split = readValue();
    } else if (flag === '--mode') {
      args.mode = parseMode(readValue(), '--mode');
    } else if (flag === '--lexical-unit') {
      args.lexicalUnit = parseLexicalUnit(readValue(), '--lexical-unit');
    } else if (flag === '--provider') {
      args.provider = readValue();
    } else if (flag === '--model') {
      args.model = readValue();
    } else if (flag === '--retrieval-views') {
      args.retrievalViews = readValue();
    } else if (flag === '--dataset-dir') {
      args.datasetDir = path.resolve(readValue());
    } else if (flag === '--dataset-url') {
      args.datasetUrl = readValue();
    } else if (flag === '--output-dir') {
      args.outputDir = path.resolve(readValue());
    } else if (flag === '--cache-dir') {
      args.cacheDir = path.resolve(readValue());
    } else if (flag === '--workspace-root') {
      args.workspaceRoot = path.resolve(readValue());
    } else if (flag === '--k') {
      args.k = parsePositiveInteger(readValue(), '--k');
    } else if (flag === '--chunk-k') {
      args.chunkK = parsePositiveInteger(readValue(), '--chunk-k');
    } else if (flag === '--candidate-pool-k') {
      args.candidatePoolK = parsePositiveInteger(readValue(), '--candidate-pool-k');
    } else if (flag === '--max-queries') {
      args.maxQueries = parsePositiveInteger(readValue(), '--max-queries');
    } else if (flag === '--keep-workspace') {
      args.keepWorkspace = true;
    } else if (flag === '--config') {
      if (inlineValue === undefined) i += 1;
    } else if (flag === '--help' || flag === '-h') {
      process.stdout.write(helpText());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }

  if (!Object.hasOwn(DATASET_URLS, args.dataset) && args.datasetDir === undefined && args.datasetUrl === undefined) {
    throw new Error(`unsupported dataset "${args.dataset}"; pass --dataset-dir or --dataset-url for custom BEIR data`);
  }
  args.chunkK = Math.max(args.chunkK, args.k);
  if (args.candidatePoolK !== undefined && args.candidatePoolK < args.k) {
    throw new Error(`--candidate-pool-k must be >= --k (got ${args.candidatePoolK} < ${args.k})`);
  }
  return args;
}

function applyBenchmarkConfig(args: Args, configPath: string): void {
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`benchmark config ${configPath} must contain a JSON object`);
  }
  if (
    parsed.schema_version !== undefined &&
    parsed.schema_version !== 'kb.beir-config.v1' &&
    parsed.schema_version !== 'kb.benchmark-replay-config.v1'
  ) {
    throw new Error(`unsupported benchmark config schema_version: ${String(parsed.schema_version)}`);
  }

  if (parsed.env !== undefined) {
    if (!isRecord(parsed.env)) {
      throw new Error(`benchmark config ${configPath} env must be a JSON object`);
    }
    applyEnvironmentConfig(parsed.env);
  }

  if (parsed.beir !== undefined) {
    if (!isRecord(parsed.beir)) {
      throw new Error(`benchmark config ${configPath} beir must be a JSON object`);
    }
    applyBeirConfig(args, parsed.beir as Partial<Record<BeirConfigKey, unknown>>);
  }
}

function applyEnvironmentConfig(envConfig: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(envConfig)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid environment variable name in benchmark config: ${name}`);
    }
    if (value === null) {
      delete process.env[name];
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      process.env[name] = String(value);
    } else {
      throw new Error(`benchmark config env.${name} must be string, number, boolean, or null`);
    }
  }
}

function applyBeirConfig(args: Args, beir: Partial<Record<BeirConfigKey, unknown>>): void {
  for (const key of Object.keys(beir) as BeirConfigKey[]) {
    const value = beir[key];
    if (value === undefined) continue;
    if (key === 'dataset') {
      args.dataset = parseStringConfig(value, 'beir.dataset');
    } else if (key === 'split') {
      args.split = parseStringConfig(value, 'beir.split');
    } else if (key === 'mode') {
      args.mode = parseMode(parseStringConfig(value, 'beir.mode'), 'beir.mode');
    } else if (key === 'lexical_unit' || key === 'lexicalUnit') {
      args.lexicalUnit = parseLexicalUnit(parseStringConfig(value, `beir.${key}`), `beir.${key}`);
    } else if (key === 'provider') {
      args.provider = parseStringConfig(value, 'beir.provider');
    } else if (key === 'model') {
      args.model = parseStringConfig(value, 'beir.model');
    } else if (key === 'retrieval_views' || key === 'retrievalViews') {
      args.retrievalViews = parseStringConfig(value, `beir.${key}`);
    } else if (key === 'output_dir' || key === 'outputDir') {
      args.outputDir = path.resolve(parseStringConfig(value, `beir.${key}`));
    } else if (key === 'cache_dir' || key === 'cacheDir') {
      args.cacheDir = path.resolve(parseStringConfig(value, `beir.${key}`));
    } else if (key === 'workspace_root' || key === 'workspaceRoot') {
      args.workspaceRoot = path.resolve(parseStringConfig(value, `beir.${key}`));
    } else if (key === 'dataset_dir' || key === 'datasetDir') {
      args.datasetDir = path.resolve(parseStringConfig(value, `beir.${key}`));
    } else if (key === 'dataset_url' || key === 'datasetUrl') {
      args.datasetUrl = parseStringConfig(value, `beir.${key}`);
    } else if (key === 'k') {
      args.k = parsePositiveIntegerConfig(value, 'beir.k');
    } else if (key === 'chunk_k' || key === 'chunkK') {
      args.chunkK = parsePositiveIntegerConfig(value, `beir.${key}`);
    } else if (key === 'candidate_pool_k' || key === 'candidatePoolK') {
      args.candidatePoolK = parsePositiveIntegerConfig(value, `beir.${key}`);
    } else if (key === 'max_queries' || key === 'maxQueries') {
      args.maxQueries = parsePositiveIntegerConfig(value, `beir.${key}`);
    } else if (key === 'keep_workspace' || key === 'keepWorkspace') {
      if (typeof value !== 'boolean') throw new Error(`beir.${key} must be a boolean`);
      args.keepWorkspace = value;
    } else {
      throw new Error(`unknown BEIR benchmark config key: ${key}`);
    }
  }
}

function parseStringConfig(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function parsePositiveIntegerConfig(value: unknown, label: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
    return value;
  }
  return parsePositiveInteger(parseStringConfig(value, label), label);
}

async function ensureDataset(args: Args): Promise<{ datasetDir: string; sourceUrl: string | null; checksumSha256: string }> {
  if (args.datasetDir !== undefined) {
    await assertDatasetShape(args.datasetDir, args.split);
    return {
      datasetDir: args.datasetDir,
      sourceUrl: null,
      checksumSha256: await hashDatasetFiles(args.datasetDir, args.split),
    };
  }

  const sourceUrl = args.datasetUrl ?? DATASET_URLS[args.dataset];
  const datasetDir = path.join(args.cacheDir, datasetCacheKey(args.dataset, sourceUrl, args.datasetUrl !== undefined));
  if (await datasetExists(datasetDir, args.split)) {
    return {
      datasetDir,
      sourceUrl,
      checksumSha256: await hashDatasetFiles(datasetDir, args.split),
    };
  }

  await ensureDirectory(args.cacheDir);
  const zipPath = path.join(args.cacheDir, `${args.dataset}.zip`);
  const zipBytes = await downloadBytes(sourceUrl);
  await fsp.writeFile(zipPath, zipBytes);
  await unzip(zipPath, args.cacheDir);
  await assertDatasetShape(datasetDir, args.split);
  return {
    datasetDir,
    sourceUrl,
    checksumSha256: await hashDatasetFiles(datasetDir, args.split),
  };
}

function datasetCacheKey(dataset: string, sourceUrl: string, customUrl: boolean): string {
  if (!customUrl) return dataset;
  const sourceHash = crypto.createHash('sha1').update(sourceUrl).digest('hex').slice(0, 12);
  return `${dataset}-${sourceHash}`;
}

async function assertSafeWorkspaceRoot(workspaceRoot: string, outputDir: string): Promise<void> {
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const resolvedOutput = path.resolve(outputDir);
  const repoRoot = process.cwd();
  if (resolvedWorkspace === path.parse(resolvedWorkspace).root) {
    throw new Error('--workspace-root must not be a filesystem root');
  }
  if (resolvedWorkspace === repoRoot || isAncestorPath(resolvedWorkspace, repoRoot)) {
    throw new Error('--workspace-root must not be the repository root or one of its parents');
  }
  if (resolvedWorkspace === resolvedOutput || isAncestorPath(resolvedWorkspace, resolvedOutput)) {
    throw new Error('--workspace-root must not contain --output-dir because it is removed after the run');
  }

  let stat;
  try {
    stat = await fsp.stat(resolvedWorkspace);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new Error('--workspace-root must be a directory or a path that does not exist yet');
  }

  const entries = await fsp.readdir(resolvedWorkspace);
  if (entries.length > 0 && !path.basename(resolvedWorkspace).startsWith('kb-beir-')) {
    throw new Error('--workspace-root already exists and is not empty; use an empty directory or a kb-beir-* temp directory');
  }
}

function isAncestorPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function prepareCorpus(options: {
  datasetName: string;
  datasetDir: string;
  knowledgeBasesRootDir: string;
}): Promise<CorpusPreparation> {
  const kbName = options.datasetName;
  const kbPath = path.join(options.knowledgeBasesRootDir, kbName);
  await resetDirectory(kbPath);
  const corpus = await readJsonlFile<BeirCorpusRow>(path.join(options.datasetDir, 'corpus.jsonl'));
  const docIdByRelativePath = new Map<string, string>();
  let index = 0;
  for (const row of corpus) {
    const fileName = safeDocFileName(row._id, index);
    const relativePath = `${kbName}/${fileName}`;
    docIdByRelativePath.set(relativePath, row._id);
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
    await fsp.writeFile(path.join(kbPath, fileName), body, 'utf-8');
    index += 1;
  }
  return { kbName, kbPath, docIdByRelativePath, documents: corpus.length };
}

function selectQueries(queries: readonly BeirQueryRow[], qrels: Qrels, maxQueries?: number): BeirQueryRow[] {
  const selected = queries.filter((query) => qrels.byQuery.has(query._id));
  return maxQueries === undefined ? selected : selected.slice(0, maxQueries);
}

function collapseChunksToDocuments(
  chunks: ReadonlyArray<{ metadata: Record<string, unknown>; score: number }>,
  docIdByRelativePath: Map<string, string>,
  k: number,
): RankedDocument[] {
  const best = new Map<string, number>();
  for (const chunk of chunks) {
    const docId = docIdFromMetadata(chunk.metadata, docIdByRelativePath);
    if (docId === null) continue;
    const previous = best.get(docId);
    if (previous === undefined || chunk.score > previous) {
      best.set(docId, chunk.score);
    }
  }
  return [...best.entries()]
    .map(([docId, score]) => ({ docId, score }))
    .sort((left, right) => right.score - left.score || left.docId.localeCompare(right.docId))
    .slice(0, k);
}

function docIdFromMetadata(metadata: Record<string, unknown>, docIdByRelativePath: Map<string, string>): string | null {
  const relativePath = typeof metadata.relativePath === 'string' ? metadata.relativePath : null;
  if (relativePath !== null) {
    const docId = docIdByRelativePath.get(relativePath);
    if (docId !== undefined) return docId;
  }
  const source = typeof metadata.source === 'string' ? metadata.source : null;
  if (source !== null) {
    const normalized = source.split(path.sep).join('/');
    for (const [relPath, docId] of docIdByRelativePath) {
      if (normalized.endsWith(relPath)) return docId;
    }
  }
  return null;
}

async function loadLexicalIndex(buildRoot: string, kbName: string, kbPath: string): Promise<LexicalIndexLike> {
  const moduleUrl = pathToFileURL(path.join(buildRoot, 'lexical-index.js')).href;
  const module = await import(moduleUrl) as LexicalIndexModule;
  return module.LexicalIndex.load(kbName, kbPath);
}

async function silenceServerLogger(buildRoot: string): Promise<void> {
  const moduleUrl = pathToFileURL(path.join(buildRoot, 'logger.js')).href;
  const loggerModule = await import(moduleUrl) as {
    logger: Record<'debug' | 'error' | 'info' | 'warn', (...args: unknown[]) => void>;
  };
  loggerModule.logger.debug = () => undefined;
  loggerModule.logger.info = () => undefined;
  loggerModule.logger.warn = () => undefined;
}

function configureBenchmarkEnvironment(knowledgeBasesRootDir: string, faissIndexPath: string): void {
  process.env.KNOWLEDGE_BASES_ROOT_DIR = knowledgeBasesRootDir;
  process.env.FAISS_INDEX_PATH = faissIndexPath;
  process.env.LOG_FILE = path.join(faissIndexPath, 'beir-bench.log');
}

async function readJsonlFile<T extends { _id: string }>(filePath: string): Promise<T[]> {
  const raw = await fsp.readFile(filePath, 'utf-8');
  const rows: T[] = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed) || typeof parsed._id !== 'string') {
      throw new Error(`${filePath}:${index + 1}: expected JSON object with string _id`);
    }
    rows.push(parsed as T);
  });
  return rows;
}

async function assertDatasetShape(datasetDir: string, split: string): Promise<void> {
  const required = [
    path.join(datasetDir, 'corpus.jsonl'),
    path.join(datasetDir, 'queries.jsonl'),
    path.join(datasetDir, 'qrels', `${split}.tsv`),
  ];
  for (const filePath of required) {
    await fsp.access(filePath);
  }
}

async function datasetExists(datasetDir: string, split: string): Promise<boolean> {
  try {
    await assertDatasetShape(datasetDir, split);
    return true;
  } catch {
    return false;
  }
}

async function downloadBytes(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed for ${url}: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function unzip(zipPath: string, destination: string): Promise<void> {
  await execFileAsync('python3', ['-c', [
    'import sys, zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    '    z.extractall(sys.argv[2])',
  ].join('\n'), zipPath, destination], { maxBuffer: 1024 * 1024 });
}

async function pythonVersion(): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync('python3', ['--version']);
    return (stdout || stderr).trim();
  } catch {
    return null;
  }
}

async function hashDatasetFiles(datasetDir: string, split: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for (const relPath of ['corpus.jsonl', 'queries.jsonl', path.join('qrels', `${split}.tsv`)]) {
    hash.update(relPath);
    hash.update(await fsp.readFile(path.join(datasetDir, relPath)));
  }
  return hash.digest('hex');
}

function safeDocFileName(docId: string, index: number): string {
  const readable = docId.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || `doc-${index}`;
  const suffix = crypto.createHash('sha1').update(docId).digest('hex').slice(0, 12);
  return `${readable}-${suffix}.md`;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function formatBenchmarkCommand(args: Args): string {
  const parts = [
    'node',
    'build/benchmarks/beir/run.js',
    `--dataset=${args.dataset}`,
    `--split=${args.split}`,
    `--mode=${args.mode}`,
  ];
  if (usesEmbeddingProvider(args.mode)) {
    if (args.provider !== undefined) parts.push(`--provider=${args.provider}`);
    if (args.model !== undefined) parts.push(`--model=${args.model}`);
  } else {
    parts.push(`--lexical-unit=${args.lexicalUnit}`);
  }
  parts.push(`--output-dir=${portablePath(args.outputDir)}`);
  if (args.datasetDir !== undefined) parts.push(`--dataset-dir=${portablePath(args.datasetDir)}`);
  if (args.datasetUrl !== undefined) parts.push(`--dataset-url=${args.datasetUrl}`);
  if (args.k !== 100) parts.push(`--k=${args.k}`);
  if (args.chunkK !== 1000) parts.push(`--chunk-k=${args.chunkK}`);
  if (args.candidatePoolK !== undefined) parts.push(`--candidate-pool-k=${args.candidatePoolK}`);
  if (args.maxQueries !== undefined) parts.push(`--max-queries=${args.maxQueries}`);
  if (args.keepWorkspace) parts.push('--keep-workspace');
  return parts.join(' ');
}

function portablePath(filePath: string): string {
  const relative = path.relative(process.cwd(), filePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : filePath;
}

function formatMarkdownReport(report: BeirBenchmarkReport, trecPath: string, jsonPath: string): string {
  const { dataset, latency, metrics } = report;
  const stageSuffix = report.rerank?.enabled
    ? `, rerank: ${report.rerank.model} topN=${report.rerank.topN}${report.contextual?.enabled ? ', contextual: on' : ''}`
    : '';
  const modeLine = report.embedding === null
    ? `- Mode: ${report.mode} (${report.ranking.unit})`
    : `- Mode: ${report.mode} (provider: ${report.embedding.provider}, model: ${report.embedding.model}${stageSuffix})`;
  return [
    `# BEIR/${dataset.name} local benchmark`,
    '',
    'This is a local BEIR benchmark run, not an official leaderboard submission.',
    '',
    '## Results',
    '',
    `- Dataset: ${dataset.name} ${dataset.split}`,
    modeLine,
    `- Corpus documents: ${dataset.corpus_documents}`,
    `- Queries evaluated: ${dataset.queries_evaluated}`,
    `- nDCG@10: ${metrics.ndcgAt10}`,
    `- precision@10: ${metrics.precisionAt10}`,
    `- MAP@100: ${metrics.mapAt100}`,
    `- Recall@10: ${metrics.recallAt10}`,
    `- Recall@100: ${metrics.recallAt100}`,
    ...(report.high_recall_candidates !== undefined
      ? [
          `- Candidate Recall@100: ${report.high_recall_candidates.candidate_recall_at100} ` +
            `(pool=${report.high_recall_candidates.candidate_pool_k}, final k=${report.high_recall_candidates.final_k})`,
        ]
      : []),
    `- Query latency: p50 ${latency.p50Ms} ms, p95 ${latency.p95Ms} ms, p99 ${latency.p99Ms} ms`,
    '',
    '## Artifacts',
    '',
    `- Metrics JSON: ${jsonPath}`,
    `- TREC run: ${trecPath}`,
    '',
    '## Reproduce',
    '',
    '```bash',
    report.command,
    '```',
    '',
    report.embedding === null
      ? 'Lexical mode requires no provider credentials. The runner builds a temporary KB corpus and maps kb lexical hits to BEIR document IDs for scoring.'
      : 'Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.',
    '',
  ].join('\n');
}

function parsePositiveInteger(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseLexicalUnit(raw: string, label: string): LexicalUnit {
  if (raw === 'chunk' || raw === 'source') return raw;
  throw new Error(`${label} must be chunk or source`);
}

function parseMode(raw: string, label: string): BeirMode {
  if (isBeirMode(raw)) return raw;
  throw new Error(`${label} must be one of: ${BEIR_MODES.join(', ')}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function helpText(): string {
  return `kb BEIR benchmark runner

Usage:
  npm run bench:beir -- --dataset=scifact --split=test --mode=lexical --lexical-unit=source --output-dir=/tmp/kb-beir-scifact

Options:
  --dataset=<name>       BEIR dataset name. Built-ins: ${Object.keys(DATASET_URLS).sort().join(', ')}.
  --config=<path>        JSON config with env overrides and BEIR runner args.
  --split=<name>         Qrels split under qrels/<split>.tsv. Default: test.
  --mode=<mode>          Retrieval mode: ${BEIR_MODES.join(', ')}. Default: lexical.
                         lexical is credential-free (BM25). dense/hybrid drive
                         the production src/ retrieval path and need a provider.
                         hybrid+rerank adds the src/reranker.ts cross-encoder
                         (KB_RERANK); hybrid+rerank+contextual also enables the
                         RFC 017 contextual-preface ingest path and needs an LLM
                         endpoint (KB_LLM_ENDPOINT, or KB_LLM_FAKE=on for tests).
  --lexical-unit=<unit>  chunk or source. source maps to kb search --lexical-unit=source. Default: source.
                         (lexical mode only.)
  --provider=<name>      Embedding provider for dense/hybrid (ollama, openai,
                         huggingface, or fake). Default: $EMBEDDING_PROVIDER.
                         fake is deterministic + network-free (self-test only).
  --model=<name>         Embedding model for dense/hybrid. Default: the provider
                         model env var (OLLAMA_MODEL / OPENAI_MODEL_NAME / ...).
  --retrieval-views=<v>  Opt-in multi-view retrieval views for dense/hybrid
                         runs, e.g. passage,section,metadata,summary or all.
  --dataset-dir=<path>   Existing BEIR directory with corpus.jsonl, queries.jsonl, qrels/.
  --dataset-url=<url>    Zip URL for a custom BEIR-shaped dataset.
  --output-dir=<path>    Directory for metrics JSON, TREC, and Markdown report.
  --cache-dir=<path>     Download/unzip cache. Default: $BEIR_CACHE_DIR or /tmp/kb-beir-cache.
  --workspace-root=<p>   Temporary KB/index workspace. Removed unless --keep-workspace.
  --k=<n>                Document run depth. Default: 100.
  --chunk-k=<n>          Lexical chunk candidates before doc collapse. Default: 1000.
  --candidate-pool-k=<n> Opt-in high-recall candidate pool depth independent
                         of --k. Reports candidate Recall@100 before final
                         document top-k scoring. Must be >= --k.
  --max-queries=<n>      Deterministic smoke-test subset.
  --keep-workspace       Keep the temporary KB/index workspace for inspection.
`;
}

const cliEntry = process.argv[1] !== undefined ? path.normalize(process.argv[1]) : '';
if (
  cliEntry.endsWith(path.join('benchmarks', 'beir', 'run.js')) ||
  cliEntry.endsWith(path.join('benchmarks', 'beir', 'run.ts'))
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
