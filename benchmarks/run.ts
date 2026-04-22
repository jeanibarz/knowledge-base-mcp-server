import * as os from 'os';
import * as path from 'path';
import type { BenchmarkReport, BenchProvider, ScenarioContext } from './types.js';
import { installStubProvider } from './stub.js';
import { runColdIndexScenario } from './scenarios/cold-index.js';
import { runColdStartScenario } from './scenarios/cold-start.js';
import { runMemoryScenario } from './scenarios/memory.js';
import { runRetrievalQualityScenario } from './scenarios/retrieval-quality.js';
import { runWarmQueryScenario } from './scenarios/warm-query.js';
import { ensureDirectory, gitSha, resultFileName, writeJsonFile } from './utils.js';

const provider = parseProvider(process.env.BENCH_PROVIDER);
const repoRoot = process.cwd();
const buildRoot = path.join(repoRoot, 'build');
const resultsPrefix = process.env.BENCH_RESULTS_PREFIX ?? 'run';
const resultsDir = path.join(repoRoot, 'benchmarks', 'results');
const outputPath = path.join(resultsDir, resultFileName(resultsPrefix, provider));
const workspaceRoot = path.join(os.tmpdir(), `knowledge-base-mcp-server-bench-${process.pid}-${Date.now()}`);
const knowledgeBasesRootDir = path.join(workspaceRoot, 'knowledge-bases');
const faissIndexPath = path.join(workspaceRoot, '.faiss');

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

  const report: BenchmarkReport = {
    arch: os.arch(),
    git_sha: await gitSha(repoRoot),
    node_version: process.version,
    os: os.platform(),
    provider,
    scenarios: {
      cold_index: await runColdIndexScenario(context),
      cold_start: await runColdStartScenario(context),
      memory_peak: await runMemoryScenario(context),
      retrieval_quality: await runRetrievalQualityScenario(),
      warm_query: await runWarmQueryScenario(context),
    },
    version: 1,
  };

  await writeJsonFile(outputPath, report);
  process.stdout.write(`${outputPath}\n`);
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
  } else if (selectedProvider === 'ollama') {
    process.env.EMBEDDING_PROVIDER = 'ollama';
  } else {
    process.env.EMBEDDING_PROVIDER = 'openai';
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required when BENCH_PROVIDER=openai');
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
