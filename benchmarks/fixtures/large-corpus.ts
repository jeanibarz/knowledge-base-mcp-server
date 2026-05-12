import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { MarkdownTextSplitter } from 'langchain/text_splitter';
import type { GoldenLabel, GoldenLabels } from '../compare/golden.js';

export type LargeCorpusQueryKind =
  | 'single-hop'
  | 'multi-hop'
  | 'exact-token'
  | 'paraphrase'
  | 'near-duplicate';

export interface LargeCorpusSpec {
  schema_version: 'large-corpus-spec.v1';
  document_count: number;
  seed: number;
  target_chunks_per_file: number;
  topic_set: 'retrieval-systems-v1';
}

export interface LargeCorpusQueryJudgment {
  id: string;
  kind: LargeCorpusQueryKind;
  query: string;
  labels: GoldenLabel[];
}

export interface LargeCorpusManifest {
  schema_version: 'large-corpus-cache.v1';
  cache_key: string;
  content_sha256: string;
  spec: LargeCorpusSpec;
  files: Array<{
    path: string;
    bytes: number;
    sha256: string;
  }>;
  queries_sha256: string;
  golden_sha256: string;
}

export interface LargeCorpusCache {
  cacheKey: string;
  cachePath: string;
  documentsPath: string;
  goldenPath: string;
  manifest: LargeCorpusManifest;
  queries: LargeCorpusQueryJudgment[];
  queriesPath: string;
}

export interface LargeCorpusFixture {
  cache: LargeCorpusCache;
  chunkCount: number;
  files: number;
  goldenLabels: GoldenLabels;
  knowledgeBaseName: string;
  query: string;
  queries: LargeCorpusQueryJudgment[];
  queriesPath: string;
  goldenPath: string;
}

interface EnsureLargeCorpusCacheOptions {
  cacheRoot?: string;
  spec?: LargeCorpusSpec;
}

interface MaterializeLargeCorpusFixtureOptions extends EnsureLargeCorpusCacheOptions {
  chunkSize?: number;
  knowledgeBaseName: string;
  rootDir: string;
}

interface Topic {
  slug: string;
  title: string;
  domain: string;
  method: string;
  metric: string;
  risk: string;
  artifact: string;
}

const CACHE_SCHEMA_VERSION = 'large-corpus-cache.v1';
const SPEC_SCHEMA_VERSION = 'large-corpus-spec.v1';
const DEFAULT_DOCUMENT_COUNT = 600;
const DEFAULT_SEED = 304;
const DEFAULT_TARGET_CHUNKS_PER_FILE = 5;
const DEFAULT_CHUNK_SIZE = 1000;

const TOPICS: Topic[] = [
  {
    slug: 'hybrid-retrieval',
    title: 'Hybrid Retrieval',
    domain: 'knowledge base search',
    method: 'reciprocal rank fusion over dense and lexical candidates',
    metric: 'nDCG@10',
    risk: 'lexical drift under paraphrased questions',
    artifact: 'RRF_ALPHA_42',
  },
  {
    slug: 'chunk-boundaries',
    title: 'Chunk Boundary Planning',
    domain: 'markdown ingestion',
    method: 'heading-aware splitting with overlap budgets',
    metric: 'answer-bearing chunk recall',
    risk: 'facts split across adjacent sections',
    artifact: 'CHUNK_SENTINEL_17',
  },
  {
    slug: 'cache-integrity',
    title: 'Cache Integrity',
    domain: 'benchmark reproducibility',
    method: 'sha256 manifests for corpus files and labels',
    metric: 'cache hit reuse rate',
    risk: 'silent fixture drift after local edits',
    artifact: 'CACHE_PROOF_91',
  },
  {
    slug: 'query-paraphrase',
    title: 'Paraphrase Query Robustness',
    domain: 'semantic retrieval evaluation',
    method: 'paired literal and rewritten information needs',
    metric: 'MRR@10',
    risk: 'model-specific synonym gaps',
    artifact: 'PARA_BRIDGE_23',
  },
  {
    slug: 'duplicate-crowding',
    title: 'Near Duplicate Crowding',
    domain: 'ranking diagnostics',
    method: 'duplicate-aware judgments with graded relevance',
    metric: 'unique relevant source count',
    risk: 'one source family crowding the top-k window',
    artifact: 'DUP_CLUSTER_08',
  },
  {
    slug: 'batch-throughput',
    title: 'Batch Throughput',
    domain: 'embedding service operations',
    method: 'concurrency sweeps with warm indexes',
    metric: 'queries per second p95',
    risk: 'tail latency amplification',
    artifact: 'BATCH_TRACE_64',
  },
  {
    slug: 'index-storage',
    title: 'Index Storage Footprint',
    domain: 'FAISS docstore accounting',
    method: 'vector binary and docstore byte measurement',
    metric: 'bytes per vector',
    risk: 'metadata growth masking vector cost',
    artifact: 'STORE_BYTES_12',
  },
  {
    slug: 'citation-grounding',
    title: 'Citation Grounding',
    domain: 'answer synthesis',
    method: 'source-preserving retrieval diagnostics',
    metric: 'source precision at five',
    risk: 'citation paths detached from ranked chunks',
    artifact: 'CITE_KEY_55',
  },
];

export function getDefaultLargeCorpusSpec(
  overrides: Partial<Pick<LargeCorpusSpec, 'document_count' | 'seed' | 'target_chunks_per_file'>>
    & { documentCount?: number; targetChunksPerFile?: number } = {},
): LargeCorpusSpec {
  return {
    schema_version: SPEC_SCHEMA_VERSION,
    document_count: positiveInt(
      overrides.document_count ?? overrides.documentCount,
      DEFAULT_DOCUMENT_COUNT,
    ),
    seed: positiveInt(overrides.seed, DEFAULT_SEED),
    target_chunks_per_file: positiveInt(
      overrides.target_chunks_per_file ?? overrides.targetChunksPerFile,
      DEFAULT_TARGET_CHUNKS_PER_FILE,
    ),
    topic_set: 'retrieval-systems-v1',
  };
}

export function defaultLargeCorpusCacheRoot(repoRoot = process.cwd()): string {
  return process.env.BENCH_LARGE_CORPUS_CACHE_DIR
    ? path.resolve(process.env.BENCH_LARGE_CORPUS_CACHE_DIR)
    : path.join(repoRoot, 'benchmarks', '.cache', 'large-corpus');
}

export function largeCorpusCacheKey(spec: LargeCorpusSpec): string {
  return `large-corpus-${sha256(canonicalJson(spec)).slice(0, 16)}`;
}

export async function ensureLargeCorpusCache(
  options: EnsureLargeCorpusCacheOptions = {},
): Promise<LargeCorpusCache> {
  const spec = options.spec ?? getDefaultLargeCorpusSpec();
  const cacheRoot = path.resolve(options.cacheRoot ?? defaultLargeCorpusCacheRoot());
  const cacheKey = largeCorpusCacheKey(spec);
  const cachePath = path.join(cacheRoot, cacheKey);

  try {
    return await validateLargeCorpusCache(cachePath, spec);
  } catch (error) {
    await fsp.rm(cachePath, { recursive: true, force: true });
    try {
      return await createLargeCorpusCache(cacheRoot, spec);
    } catch (createError) {
      const reason = createError instanceof Error ? createError.message : String(createError);
      throw new Error([
        `Large benchmark fixture cache could not be prepared at ${cacheRoot}: ${reason}`,
        'Setup: create a writable cache directory or set BENCH_LARGE_CORPUS_CACHE_DIR=/path/to/cache, then retry',
        '`npm run bench:compare -- --fixture=large --models=<a>,<b> --yes`.',
      ].join('\n'));
    }
  }
}

export async function validateLargeCorpusCache(
  cachePath: string,
  expectedSpec?: LargeCorpusSpec,
): Promise<LargeCorpusCache> {
  const manifestPath = path.join(cachePath, 'MANIFEST.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf-8')) as LargeCorpusManifest;
  if (manifest.schema_version !== CACHE_SCHEMA_VERSION) {
    throw new Error(`large corpus cache schema mismatch: ${manifest.schema_version}`);
  }
  if (expectedSpec && canonicalJson(manifest.spec) !== canonicalJson(expectedSpec)) {
    throw new Error('large corpus cache spec mismatch');
  }
  if (manifest.cache_key !== largeCorpusCacheKey(manifest.spec)) {
    throw new Error('large corpus cache key mismatch');
  }

  const queriesPath = path.join(cachePath, 'queries.json');
  const goldenPath = path.join(cachePath, 'golden.json');
  await assertFileHash(queriesPath, manifest.queries_sha256);
  await assertFileHash(goldenPath, manifest.golden_sha256);

  const fileHashes: string[] = [];
  for (const file of manifest.files) {
    await assertFileHash(path.join(cachePath, file.path), file.sha256);
    fileHashes.push(file.sha256);
  }
  const contentSha = sha256(fileHashes.join('\n'));
  if (contentSha !== manifest.content_sha256) {
    throw new Error(`large corpus cache content sha256 mismatch: expected ${manifest.content_sha256}, got ${contentSha}`);
  }

  const queries = JSON.parse(await fsp.readFile(queriesPath, 'utf-8')) as LargeCorpusQueryJudgment[];
  return {
    cacheKey: manifest.cache_key,
    cachePath,
    documentsPath: path.join(cachePath, 'documents'),
    goldenPath,
    manifest,
    queries,
    queriesPath,
  };
}

export async function materializeLargeCorpusFixture(
  options: MaterializeLargeCorpusFixtureOptions,
): Promise<LargeCorpusFixture> {
  const cache = await ensureLargeCorpusCache({
    cacheRoot: options.cacheRoot,
    spec: options.spec,
  });
  const knowledgeBasePath = path.join(options.rootDir, options.knowledgeBaseName);
  await fsp.rm(knowledgeBasePath, { recursive: true, force: true });
  await fsp.mkdir(knowledgeBasePath, { recursive: true });

  for (const file of cache.manifest.files) {
    const relativeDocumentPath = path.relative('documents', file.path);
    const target = path.join(knowledgeBasePath, relativeDocumentPath);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(path.join(cache.cachePath, file.path), target);
  }

  const chunkCount = await countChunks(knowledgeBasePath, options.chunkSize);
  const queries = rewriteQueriesForKnowledgeBase(cache.queries, options.knowledgeBaseName);
  const goldenLabels = queriesToGoldenLabels(queries);
  const firstQuery = queries.find((query) => query.id === 'single-hop-hybrid-retrieval')?.query
    ?? queries.find((query) => query.kind === 'single-hop')?.query
    ?? queries[0]?.query
    ?? 'hybrid retrieval cache integrity benchmark';

  return {
    cache,
    chunkCount,
    files: cache.manifest.files.length,
    goldenLabels,
    knowledgeBaseName: options.knowledgeBaseName,
    query: firstQuery,
    queries,
    queriesPath: cache.queriesPath,
    goldenPath: cache.goldenPath,
  };
}

export async function largeCorpusQueryLines(cache: LargeCorpusCache): Promise<string[]> {
  const queries = JSON.parse(await fsp.readFile(cache.queriesPath, 'utf-8')) as LargeCorpusQueryJudgment[];
  return queries.map((query) => query.query);
}

export async function largeCorpusGoldenLabels(
  cache: LargeCorpusCache,
  knowledgeBaseName?: string,
): Promise<GoldenLabels> {
  const labels = JSON.parse(await fsp.readFile(cache.goldenPath, 'utf-8')) as GoldenLabels;
  if (!knowledgeBaseName) return labels;

  return Object.fromEntries(
    Object.entries(labels).map(([query, queryLabels]) => [
      query,
      queryLabels.map((label) => ({
        ...label,
        source: path.posix.join(knowledgeBaseName, label.source),
      })),
    ]),
  );
}

async function createLargeCorpusCache(
  cacheRoot: string,
  spec: LargeCorpusSpec,
): Promise<LargeCorpusCache> {
  const cacheKey = largeCorpusCacheKey(spec);
  const cachePath = path.join(cacheRoot, cacheKey);
  const documentsPath = path.join(cachePath, 'documents');
  await fsp.mkdir(documentsPath, { recursive: true });

  const docs = buildDocuments(spec);
  const files: LargeCorpusManifest['files'] = [];
  for (const doc of docs) {
    const filePath = path.join(documentsPath, doc.fileName);
    await fsp.writeFile(filePath, doc.content, 'utf-8');
    const bytes = Buffer.byteLength(doc.content, 'utf-8');
    files.push({
      path: path.posix.join('documents', doc.fileName),
      bytes,
      sha256: sha256(doc.content),
    });
  }

  const queries = buildQueryJudgments(docs);
  const golden = queriesToGoldenLabels(queries);
  const queriesJson = stableJson(queries);
  const goldenJson = stableJson(golden);
  await fsp.writeFile(path.join(cachePath, 'queries.json'), queriesJson, 'utf-8');
  await fsp.writeFile(path.join(cachePath, 'golden.json'), goldenJson, 'utf-8');

  const manifest: LargeCorpusManifest = {
    schema_version: CACHE_SCHEMA_VERSION,
    cache_key: cacheKey,
    content_sha256: sha256(files.map((file) => file.sha256).join('\n')),
    spec,
    files,
    queries_sha256: sha256(queriesJson),
    golden_sha256: sha256(goldenJson),
  };
  await fsp.writeFile(path.join(cachePath, 'MANIFEST.json'), stableJson(manifest), 'utf-8');
  return validateLargeCorpusCache(cachePath, spec);
}

interface BuiltDocument {
  content: string;
  exactToken: string;
  fileName: string;
  relativeSource: string;
  topic: Topic;
  variant: number;
}

function buildDocuments(spec: LargeCorpusSpec): BuiltDocument[] {
  const docs: BuiltDocument[] = [];
  const duplicateStride = Math.max(6, TOPICS.length);
  for (let index = 0; index < spec.document_count; index += 1) {
    const topic = TOPICS[index % TOPICS.length];
    const variant = Math.floor(index / TOPICS.length) + 1;
    const nearDuplicateOf = index >= duplicateStride && index % duplicateStride === 1
      ? docs[index - 1]
      : undefined;
    const fileName = `paper-${String(index + 1).padStart(4, '0')}-${topic.slug}.md`;
    const exactToken = `${topic.artifact}_${String(index + spec.seed).padStart(4, '0')}`;
    const content = nearDuplicateOf
      ? buildNearDuplicateDocument(topic, variant, exactToken, nearDuplicateOf)
      : buildTopicDocument(topic, variant, exactToken, spec.target_chunks_per_file);
    docs.push({
      content,
      exactToken,
      fileName,
      relativeSource: fileName,
      topic,
      variant,
    });
  }
  return docs;
}

function buildTopicDocument(
  topic: Topic,
  variant: number,
  exactToken: string,
  targetChunksPerFile: number,
): string {
  const repeatedSections = Array.from({ length: Math.max(1, targetChunksPerFile) }, (_, sectionIndex) => {
    const sectionNumber = sectionIndex + 1;
    return [
      `## Experiment ${sectionNumber}: ${topic.title}`,
      `${topic.title} study ${variant}.${sectionNumber} evaluates ${topic.method} for ${topic.domain}. The primary measurement is ${topic.metric}, while operators watch ${topic.risk}.`,
      `The controlled marker ${exactToken} appears in the audit table so exact-token retrieval can distinguish this paper from adjacent papers in the same topic family.`,
      `Ablation notes compare baseline keyword retrieval, dense embedding retrieval, and hybrid retrieval. The result narrative keeps ${topic.domain}, ${topic.method}, ${topic.metric}, and ${topic.risk} close enough for realistic chunk-level matching.`,
      `Operational guidance records cache warmup, index storage, warm query latency, batch throughput, and labelled quality checks for maintainers running the benchmark locally.`,
    ].join('\n\n');
  });

  return [
    '---',
    `title: ${topic.title} Study ${variant}`,
    `tags: benchmark,large-corpus,${topic.slug}`,
    '---',
    '',
    `# ${topic.title} Study ${variant}`,
    '',
    `Abstract: This technical note studies ${topic.domain} with ${topic.method}. It reports ${topic.metric} and documents ${topic.risk}.`,
    '',
    ...repeatedSections,
    '',
  ].join('\n');
}

function buildNearDuplicateDocument(
  topic: Topic,
  variant: number,
  exactToken: string,
  base: BuiltDocument,
): string {
  return [
    '---',
    `title: ${topic.title} Replication ${variant}`,
    `tags: benchmark,large-corpus,near-duplicate,${topic.slug}`,
    '---',
    '',
    `# ${topic.title} Replication ${variant}`,
    '',
    `Abstract: This replication intentionally mirrors ${base.fileName} with small wording changes. It measures ${topic.metric} for ${topic.domain} and preserves the same retrieval intent.`,
    '',
    `## Replication Notes`,
    `The source family repeats the method ${topic.method}, the risk ${topic.risk}, and the diagnostic marker ${base.exactToken}.`,
    `This near duplicate adds its own marker ${exactToken} so exact-token queries still have a single best answer while near-duplicate queries have two strong labels.`,
    `Maintainers use this pair to see whether a model crowds top-k results with copies or keeps diverse relevant sources.`,
    '',
    `## Local Benchmark Interpretation`,
    `Warm query latency, index storage, batch throughput, and nDCG@10 should be inspected together because duplicate-heavy corpora can make one metric look healthy while ranked quality regresses.`,
    '',
  ].join('\n');
}

function buildQueryJudgments(docs: BuiltDocument[]): LargeCorpusQueryJudgment[] {
  const queries: LargeCorpusQueryJudgment[] = [];
  const bySlug = new Map<string, BuiltDocument[]>();
  docs.forEach((doc) => {
    const current = bySlug.get(doc.topic.slug) ?? [];
    current.push(doc);
    bySlug.set(doc.topic.slug, current);
  });

  TOPICS.slice(0, 5).forEach((topic, offset) => {
    const family = bySlug.get(topic.slug) ?? [];
    const primary = family[offset % Math.max(1, family.length)];
    if (!primary) return;
    queries.push({
      id: `single-hop-${topic.slug}`,
      kind: 'single-hop',
      query: `${topic.domain} retrieval ${topic.metric} ${topic.method}`,
      labels: labels([primary]),
    });
  });

  for (let i = 0; i < Math.min(5, TOPICS.length - 1); i += 1) {
    const first = firstDoc(bySlug, TOPICS[i].slug);
    const second = firstDoc(bySlug, TOPICS[i + 1].slug);
    if (!first || !second) continue;
    queries.push({
      id: `multi-hop-${TOPICS[i].slug}-${TOPICS[i + 1].slug}`,
      kind: 'multi-hop',
      query: `${TOPICS[i].risk} together with ${TOPICS[i + 1].metric} benchmark evidence`,
      labels: labels([first, second], [3, 2]),
    });
  }

  docs.slice(0, 5).forEach((doc) => {
    queries.push({
      id: `exact-token-${doc.topic.slug}-${doc.variant}`,
      kind: 'exact-token',
      query: doc.exactToken,
      labels: labels([doc]),
    });
  });

  TOPICS.slice(0, 5).forEach((topic) => {
    const primary = firstDoc(bySlug, topic.slug);
    if (!primary) return;
    queries.push({
      id: `paraphrase-${topic.slug}`,
      kind: 'paraphrase',
      query: paraphraseFor(topic),
      labels: labels([primary]),
    });
  });

  const duplicatePairs = findDuplicatePairs(docs).slice(0, 5);
  duplicatePairs.forEach(([base, duplicate]) => {
    queries.push({
      id: `near-duplicate-${base.topic.slug}-${base.variant}`,
      kind: 'near-duplicate',
      query: `${base.topic.title} replication ${base.topic.method} ${base.topic.risk}`,
      labels: labels([base, duplicate], [3, 2]),
    });
  });

  return queries.sort((left, right) => left.id.localeCompare(right.id));
}

function firstDoc(bySlug: Map<string, BuiltDocument[]>, slug: string): BuiltDocument | undefined {
  return bySlug.get(slug)?.[0];
}

function findDuplicatePairs(docs: BuiltDocument[]): Array<[BuiltDocument, BuiltDocument]> {
  const pairs: Array<[BuiltDocument, BuiltDocument]> = [];
  for (const doc of docs) {
    const base = docs.find((candidate) => candidate !== doc && doc.content.includes(candidate.exactToken));
    if (base) {
      pairs.push([base, doc]);
    }
  }
  return pairs;
}

function labels(docs: BuiltDocument[], relevance = docs.map(() => 3)): GoldenLabel[] {
  return docs.map((doc, index) => ({
    source: doc.relativeSource,
    relevance: relevance[index] === 2 ? 2 : 3,
  }));
}

function paraphraseFor(topic: Topic): string {
  return `Which paper explains how to judge ${topic.domain} when wording changes but the answer should still match ${topic.metric}?`;
}

function queriesToGoldenLabels(queries: LargeCorpusQueryJudgment[]): GoldenLabels {
  const golden: GoldenLabels = {};
  for (const query of queries) {
    golden[query.query] = query.labels;
  }
  return golden;
}

function rewriteQueriesForKnowledgeBase(
  queries: LargeCorpusQueryJudgment[],
  knowledgeBaseName: string,
): LargeCorpusQueryJudgment[] {
  return queries.map((query) => ({
    ...query,
    labels: query.labels.map((label) => ({
      ...label,
      source: path.posix.join(knowledgeBaseName, label.source),
    })),
  }));
}

async function countChunks(knowledgeBasePath: string, chunkSize?: number): Promise<number> {
  const splitter = new MarkdownTextSplitter({
    chunkOverlap: Math.floor((chunkSize ?? DEFAULT_CHUNK_SIZE) / 5),
    chunkSize: chunkSize ?? DEFAULT_CHUNK_SIZE,
    keepSeparator: false,
  });
  const files = await fsp.readdir(knowledgeBasePath);
  let total = 0;
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(knowledgeBasePath, file);
    const content = await fsp.readFile(filePath, 'utf-8');
    const docs = await splitter.createDocuments([content], [{ source: filePath }]);
    total += docs.length;
  }
  return total;
}

async function assertFileHash(filePath: string, expected: string): Promise<void> {
  const raw = await fsp.readFile(filePath);
  const actual = sha256(raw);
  if (actual !== expected) {
    throw new Error(`large corpus cache sha256 mismatch for ${filePath}: expected ${expected}, got ${actual}`);
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
  return Math.floor(value);
}

function stableJson(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForJson(value));
}

function sortForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortForJson(child)]),
    );
  }
  return value;
}

function sha256(input: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}
