import * as os from 'os';
import * as path from 'path';
import { readFileSync } from 'fs';
import type { BenchmarkReport, BenchProvider, ScenarioContext } from './types.js';
import { installStubProvider } from './stub.js';
import { runBatchQueryScenario } from './scenarios/batch-query.js';
import { runColdIndexScenario } from './scenarios/cold-index.js';
import { runColdStartScenario } from './scenarios/cold-start.js';
import { runIndexStorageScenario } from './scenarios/index-storage.js';
import { runMemoryScenario } from './scenarios/memory.js';
import { runRetrievalQualityScenario } from './scenarios/retrieval-quality.js';
import { runWarmQueryScenario } from './scenarios/warm-query.js';
import { ensureDirectory, gitSha, resultFileName, writeJsonFile } from './utils.js';

const provider = parseProvider(process.env.BENCH_PROVIDER);
const repoRoot = process.cwd();
const buildRoot = path.join(repoRoot, 'build');
const resultsPrefix = process.env.BENCH_RESULTS_PREFIX ?? 'run';
// BENCH_RESULTS_DIR override lets the compare orchestrator redirect per-leg
// JSONs to its tmpdir so they don't pile up in the committed results folder.
const resultsDir = process.env.BENCH_RESULTS_DIR ?? path.join(repoRoot, 'benchmarks', 'results');
const outputPath = path.join(resultsDir, resultFileName(resultsPrefix, provider));
// Path overrides let an external orchestrator (e.g. `bench:compare`) point two
// successive runs at distinct, known locations so it can post-process both
// indexes after the fact. Without overrides, defaults to a per-pid tmpdir.
const workspaceRoot = process.env.BENCH_WORKSPACE_ROOT
  ?? path.join(os.tmpdir(), `knowledge-base-mcp-server-bench-${process.pid}-${Date.now()}`);
const knowledgeBasesRootDir = process.env.BENCH_KNOWLEDGE_BASES_ROOT_DIR
  ?? path.join(workspaceRoot, 'knowledge-bases');
const faissIndexPath = process.env.BENCH_FAISS_INDEX_PATH
  ?? path.join(workspaceRoot, '.faiss');

async function main(): Promise<void> {
  await ensureDirectory(resultsDir);
  configureEnvironment(provider, knowledgeBasesRootDir, faissIndexPath);
  await silenceServerLogger();

  const stubController = provider === 'stub' ? await installStubProvider() : undefined;
  stubController?.resetCounters();

  const context: ScenarioContext = {
    buildRoot,
    faissIndexPath,
    fixtureSeed: 7,
    knowledgeBaseName: 'default',
    knowledgeBasesRootDir,
    provider,
    repoRoot,
    stubController,
    workspaceRoot,
  };

  const includeBatchQuery = parseBoolEnv(process.env.BENCH_INCLUDE_BATCH_QUERY, true);
  const includeIndexStorage = parseBoolEnv(process.env.BENCH_INCLUDE_INDEX_STORAGE, true);

  const concurrencies = parseConcurrencies(process.env.BENCH_BATCH_CONCURRENCIES);
  const queries = parseQueriesEnv(process.env.BENCH_QUERIES);

  // Issue #107: env-derived fixture overrides. bench:compare sets
  // BENCH_FIXTURE_CHUNK_CHARS to fit the smallest-context model under
  // comparison; FILES / CHUNKS_PER_FILE are operator-facing scope knobs.
  const fixtureOverrides = {
    files: parsePositiveIntEnv(process.env.BENCH_FIXTURE_FILES),
    targetChunksPerFile: parsePositiveIntEnv(process.env.BENCH_FIXTURE_CHUNKS_PER_FILE),
    chunkSize: parsePositiveIntEnv(process.env.BENCH_FIXTURE_CHUNK_CHARS),
  };

  const cold_index = await runColdIndexScenario(context, fixtureOverrides);
  const cold_start = await runColdStartScenario(context, fixtureOverrides);
  const memory_peak = await runMemoryScenario(context, fixtureOverrides);
  const retrieval_quality = await runRetrievalQualityScenario();
  const warm_query = await runWarmQueryScenario(context, fixtureOverrides);
  const batch_query = includeBatchQuery
    ? await runBatchQueryScenario(context, {
        concurrencies,
        queries,
        files: fixtureOverrides.files,
        targetChunksPerFile: fixtureOverrides.targetChunksPerFile,
        chunkSize: fixtureOverrides.chunkSize,
      })
    : undefined;
  const index_storage = includeIndexStorage
    ? await runIndexStorageScenario(context, {
        files: fixtureOverrides.files,
        targetChunksPerFile: fixtureOverrides.targetChunksPerFile,
        chunkSize: fixtureOverrides.chunkSize,
      })
    : undefined;

  const report: BenchmarkReport = {
    arch: os.arch(),
    git_sha: await gitSha(repoRoot),
    model_id: process.env.BENCH_MODEL_ID,
    model_name: process.env.BENCH_MODEL_NAME,
    node_version: process.version,
    os: os.platform(),
    provider,
    scenarios: {
      cold_index,
      cold_start,
      memory_peak,
      retrieval_quality,
      warm_query,
      ...(batch_query ? { batch_query } : {}),
      ...(index_storage ? { index_storage } : {}),
    },
    version: 1,
  };

  await writeJsonFile(outputPath, report);
  process.stdout.write(`${outputPath}\n`);
}

function parseBoolEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  return true;
}

function parseConcurrencies(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  const parsed = value.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length > 0 ? parsed : undefined;
}

function parsePositiveIntEnv(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function parseQueriesEnv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  // BENCH_QUERIES is a path to a file with one query per line.
  try {
    const raw = readFileSync(value, 'utf-8');
    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    return lines.length > 0 ? lines : undefined;
  } catch {
    return undefined;
  }
}

async function silenceServerLogger(): Promise<void> {
  const loggerModule = await import(new URL(`file://${path.join(buildRoot, 'logger.js')}`).href) as {
    logger: Record<'debug' | 'error' | 'info' | 'warn', (...args: unknown[]) => void>;
  };

  loggerModule.logger.debug = () => undefined;
  loggerModule.logger.info = () => undefined;
  loggerModule.logger.warn = () => undefined;
}

function configureEnvironment(
  selectedProvider: BenchProvider,
  selectedKnowledgeBasesRootDir: string,
  selectedFaissIndexPath: string,
): void {
  process.env.KNOWLEDGE_BASES_ROOT_DIR = selectedKnowledgeBasesRootDir;
  process.env.FAISS_INDEX_PATH = selectedFaissIndexPath;
  process.env.LOG_FILE = path.join(selectedFaissIndexPath, 'bench.log');

  if (selectedProvider === 'stub' || selectedProvider === 'huggingface') {
    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY ?? 'bench-hf-key';
    if (process.env.BENCH_MODEL_NAME) {
      process.env.HUGGINGFACE_MODEL_NAME = process.env.BENCH_MODEL_NAME;
    }
  } else if (selectedProvider === 'ollama') {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    if (process.env.BENCH_MODEL_NAME) {
      process.env.OLLAMA_MODEL = process.env.BENCH_MODEL_NAME;
    }
  } else {
    process.env.EMBEDDING_PROVIDER = 'openai';
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required when BENCH_PROVIDER=openai');
    }
    if (process.env.BENCH_MODEL_NAME) {
      process.env.OPENAI_MODEL_NAME = process.env.BENCH_MODEL_NAME;
    }
  }
}

function parseProvider(value: string | undefined): BenchProvider {
  const providerValue = value ?? 'stub';
  if (providerValue === 'stub' || providerValue === 'ollama' || providerValue === 'openai' || providerValue === 'huggingface') {
    return providerValue;
  }
  throw new Error(`Unsupported BENCH_PROVIDER: ${providerValue}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
