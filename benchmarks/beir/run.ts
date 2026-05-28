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

const BENCHMARK_SCHEMA_VERSION = 'kb.beir-benchmark.v1';
type LexicalUnit = 'chunk' | 'source';

interface Args {
  dataset: string;
  split: string;
  mode: 'lexical';
  lexicalUnit: LexicalUnit;
  outputDir: string;
  cacheDir: string;
  workspaceRoot: string;
  datasetDir?: string;
  datasetUrl?: string;
  k: number;
  chunkK: number;
  maxQueries?: number;
  keepWorkspace: boolean;
}

type BeirConfigKey =
  | 'dataset'
  | 'split'
  | 'mode'
  | 'lexical_unit'
  | 'lexicalUnit'
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
    refresh: Awaited<ReturnType<LexicalIndexLike['refresh']>>;
    files: number;
    chunks: number;
  };
  metrics: ReturnType<typeof aggregateQueryMetrics>;
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

interface RunDependencies {
  gitSha(repoRoot: string): Promise<string>;
  loadLexicalIndex(buildRoot: string, kbName: string, kbPath: string): Promise<LexicalIndexLike>;
  now(): Date;
  pythonVersion(): Promise<string | null>;
  silenceServerLogger(buildRoot: string): Promise<void>;
}

const defaultRunDependencies: RunDependencies = {
  gitSha,
  loadLexicalIndex,
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

  configureBenchmarkEnvironment(knowledgeBasesRootDir, faissIndexPath);
  await dependencies.silenceServerLogger(path.join(process.cwd(), 'build'));
  const lexicalIndex = await dependencies.loadLexicalIndex(path.join(process.cwd(), 'build'), prepared.kbName, prepared.kbPath);
  const indexStarted = process.hrtime.bigint();
  const refresh = await lexicalIndex.refresh();
  await lexicalIndex.save();
  const indexMs = durationMs(indexStarted, process.hrtime.bigint());

  const queryRows: Array<{ queryId: string; ranking: RankedDocument[] }> = [];
  const perQuery: QueryMetric[] = [];
  const latenciesMs: number[] = [];

  for (const query of selectedQueries) {
    const started = process.hrtime.bigint();
    const fetchK = args.lexicalUnit === 'source' ? args.k : args.chunkK;
    const chunks = await lexicalIndex.query(query.text, fetchK, {
      unit: args.lexicalUnit,
      candidateK: args.chunkK,
    });
    const latency = durationMs(started, process.hrtime.bigint());
    latenciesMs.push(latency);
    const ranking = collapseChunksToDocuments(chunks, prepared.docIdByRelativePath, args.k);
    queryRows.push({ queryId: query._id, ranking });
    const scored = scoreQuery(query._id, ranking, qrels);
    if (scored !== null) {
      perQuery.push(scored);
    }
  }

  const runTag = `kb-${args.dataset}-${args.mode}-${args.lexicalUnit}`;
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
    ranking: {
      unit: args.lexicalUnit,
      implementation: args.lexicalUnit === 'source'
        ? 'LexicalIndex source BM25 over whole files, returning one representative chunk per source'
        : 'LexicalIndex chunk BM25 collapsed by BEIR document id using max chunk score',
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
      refresh,
      files: lexicalIndex.numFiles(),
      chunks: lexicalIndex.numChunks(),
    },
    metrics: aggregateQueryMetrics(perQuery),
    latency: summarizeLatencies(latenciesMs),
    per_query: perQuery,
    caveats: [
      'This is a local BEIR/SciFact benchmark, not an official leaderboard submission.',
      'Lexical mode requires no provider credentials.',
      'Scores are document-level for BEIR qrels; source ranking is the same public lexical unit exposed by kb search --lexical-unit=source.',
      'MLflow logging is not required for JSON/TREC artifacts; optional logging is expected to come from the bench observability hook.',
    ],
  };

  await writeJsonFile(jsonPath, report);
  await fsp.writeFile(reportPath, formatMarkdownReport(report, portablePath(trecPath), portablePath(jsonPath)), 'utf-8');

  if (!args.keepWorkspace) {
    await fsp.rm(args.workspaceRoot, { recursive: true, force: true });
  }

  return { jsonPath, trecPath, reportPath, report };
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
      const mode = readValue();
      if (mode !== 'lexical') throw new Error('BEIR benchmark currently supports --mode=lexical only');
      args.mode = mode;
    } else if (flag === '--lexical-unit') {
      args.lexicalUnit = parseLexicalUnit(readValue(), '--lexical-unit');
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
      const mode = parseStringConfig(value, 'beir.mode');
      if (mode !== 'lexical') throw new Error('BEIR benchmark currently supports mode=lexical only');
      args.mode = mode;
    } else if (key === 'lexical_unit' || key === 'lexicalUnit') {
      args.lexicalUnit = parseLexicalUnit(parseStringConfig(value, `beir.${key}`), `beir.${key}`);
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
    `--lexical-unit=${args.lexicalUnit}`,
    `--output-dir=${portablePath(args.outputDir)}`,
  ];
  if (args.datasetDir !== undefined) parts.push(`--dataset-dir=${portablePath(args.datasetDir)}`);
  if (args.datasetUrl !== undefined) parts.push(`--dataset-url=${args.datasetUrl}`);
  if (args.k !== 100) parts.push(`--k=${args.k}`);
  if (args.chunkK !== 1000) parts.push(`--chunk-k=${args.chunkK}`);
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
  return [
    `# BEIR/${dataset.name} local benchmark`,
    '',
    'This is a local BEIR benchmark run, not an official leaderboard submission.',
    '',
    '## Results',
    '',
    `- Dataset: ${dataset.name} ${dataset.split}`,
    `- Corpus documents: ${dataset.corpus_documents}`,
    `- Queries evaluated: ${dataset.queries_evaluated}`,
    `- nDCG@10: ${metrics.ndcgAt10}`,
    `- MAP@100: ${metrics.mapAt100}`,
    `- Recall@10: ${metrics.recallAt10}`,
    `- Recall@100: ${metrics.recallAt100}`,
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
    'Lexical mode requires no provider credentials. The runner builds a temporary KB corpus and maps kb lexical hits to BEIR document IDs for scoring.',
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
  --mode=lexical         Retrieval mode. Lexical is credential-free.
  --lexical-unit=<unit>  chunk or source. source maps to kb search --lexical-unit=source. Default: source.
  --dataset-dir=<path>   Existing BEIR directory with corpus.jsonl, queries.jsonl, qrels/.
  --dataset-url=<url>    Zip URL for a custom BEIR-shaped dataset.
  --output-dir=<path>    Directory for metrics JSON, TREC, and Markdown report.
  --cache-dir=<path>     Download/unzip cache. Default: $BEIR_CACHE_DIR or /tmp/kb-beir-cache.
  --workspace-root=<p>   Temporary KB/index workspace. Removed unless --keep-workspace.
  --k=<n>                Document run depth. Default: 100.
  --chunk-k=<n>          Lexical chunk candidates before doc collapse. Default: 1000.
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
