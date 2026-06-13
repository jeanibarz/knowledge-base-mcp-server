import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { parseChunkReference } from './chunk-id.js';
import { resolveChunkSize } from './config/indexing.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { isContextualRetrievalEnabled } from './config/contextual-preface.js';
import { resolveIngestSecretScanOptions } from './config/ingest.js';
import {
  defaultExtractionCacheDir,
  inventoryExtractionCache,
} from './extraction-cache.js';
import { buildChunkDocuments, normalizeChunkTextForEmbedding } from './file-ingest.js';
import { parseFrontmatter } from './frontmatter.js';
import { liftFrontmatter } from './frontmatter-lift.js';
import { getIngestQuarantineRecord, quarantineManifestPath, type IngestQuarantineRecord } from './ingest-quarantine.js';
import { resolveKbPath } from './kb-fs.js';
import { applyExtractedTextLimit, loadFile, SUPPORTED_LOADER_EXTENSIONS } from './loaders.js';
import {
  GENERATOR_VERSION,
  sha256 as contextualSha256,
  sidecarPathFor,
} from './contextual-preface.js';
import {
  assertNoIngestSecrets,
  IngestSecretDetectedError,
  type SecretScanInput,
} from './secret-scanner.js';

export const INSPECT_HELP = `kb inspect — show file-side ingest chunking diagnostics

Usage:
  kb inspect <file|kb://uri|kb-relative-path> [--format=md|json]
  kb inspect <file|kb://uri|kb-relative-path> --json

Runs the same file loader and splitter path used by ingest for one file, then
prints chunk boundaries and read-only ingest-state diagnostics. Contextual
preface generation is always skipped: this command never calls the LLM and
never writes contextual-preface sidecars.

For PDF, HTML, CSV, and TSV files, inspection uses the normal extraction
loader in no-write mode. It may read existing extracted-text cache entries, but
it parses cache misses without populating new extracted-text cache files; the
JSON payload reports cache entry counts before and after.

Options:
  --format=md|json  Output format (default: md).
  --json            Alias for --format=json.
  --help, -h        Show this help.

Exit codes:
  0   inspected successfully, including files whose secret scan would quarantine
  1   file exists but could not be loaded or split
  2   missing / invalid argument, unknown KB, or target outside the KB root
`;

type InspectFormat = 'md' | 'json';

interface InspectArgs {
  target: string;
  format: InspectFormat;
}

interface ResolvedInspectTarget {
  target: string;
  absolutePath: string;
  knowledgeBase: string;
  kbRelativePath: string;
  displayPath: string;
  targetKind: 'local-path' | 'kb-reference';
}

interface ChunkBoundary {
  chunk_index: number;
  chars: number;
  bytes: number;
  normalized_text_sha256: string;
  start_char: number | null;
  end_char: number | null;
  lines: { from: number; to: number } | null;
}

interface SecretScanVerdict {
  enabled: boolean;
  verdict: 'clean' | 'secret_detected' | 'disabled' | 'bypassed';
  categories: string[];
  chunk_indexes: number[];
  locations: string[];
  error_code: string | null;
  message: string | null;
}

interface ExtractionCacheInspect {
  applies: boolean;
  cache_dir: string;
  may_write_on_miss: boolean;
  entry_count_before: number | null;
  entry_count_after: number | null;
  changed_during_inspect: boolean | null;
}

interface ContextualPrefaceInspect {
  enabled: boolean;
  generation_skipped: true;
  sidecar_path: string;
  sidecar_exists: boolean;
  sidecar_valid: boolean | null;
  document_hash_matches: boolean | null;
  generator_matches: boolean | null;
  chunk_config_matches: boolean | null;
  model: string | null;
  chunks: {
    total: number | null;
    with_preface: number;
    null_preface: number;
    retry_pending: number;
  };
}

interface InspectPayload {
  schema_version: 'kb.inspect.v1';
  target: string;
  path: string;
  knowledgeBase: string;
  relativePath: string;
  read_only: true;
  source: {
    extension: string;
    source_bytes: number;
    loaded_text_bytes: number;
    source_sha256: string;
  };
  loader: {
    extraction_cache: ExtractionCacheInspect;
  };
  splitter: {
    type: 'markdown' | 'recursive_character';
    chunk_size: number;
    chunk_overlap: number;
  };
  frontmatter: {
    tags: string[];
    lifted_keys: string[];
  };
  secret_scan: SecretScanVerdict;
  quarantine: {
    manifest_path: string;
    present: boolean;
    source_sha256_matches: boolean | null;
    record: IngestQuarantineRecord | null;
  };
  contextual_preface: ContextualPrefaceInspect;
  chunks: ChunkBoundary[];
}

export async function runInspect(rest: string[] = []): Promise<number> {
  let args: InspectArgs;
  try {
    args = parseInspectArgs(rest);
  } catch (err) {
    process.stderr.write(`kb inspect: ${(err as Error).message}\n`);
    return 2;
  }

  let target: ResolvedInspectTarget;
  try {
    target = await resolveInspectTarget(args.target);
  } catch (err) {
    process.stderr.write(`kb inspect: ${(err as Error).message}\n`);
    return exitCodeForResolveError(err);
  }

  try {
    const payload = await inspectTarget(target);
    if (args.format === 'json') {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write(formatInspectMarkdown(payload));
    }
    return 0;
  } catch (err) {
    process.stderr.write(`kb inspect: ${(err as Error).message}\n`);
    return 1;
  }
}

function parseInspectArgs(rest: readonly string[]): InspectArgs {
  let target: string | null = null;
  let format: InspectFormat = 'md';
  for (const arg of rest) {
    if (arg === '--json') {
      format = 'json';
      continue;
    }
    if (arg === '--format=json') {
      format = 'json';
      continue;
    }
    if (arg === '--format=md') {
      format = 'md';
      continue;
    }
    if (arg.startsWith('--format=')) {
      throw new Error(`invalid --format: ${arg}`);
    }
    if (arg.startsWith('-')) {
      throw new Error(`unknown option '${arg}'`);
    }
    if (target !== null) {
      throw new Error(`expected exactly one file (unexpected argument '${arg}')`);
    }
    target = arg;
  }
  if (target === null) throw new Error('missing <file|kb://uri|kb-relative-path>');
  return { target, format };
}

async function resolveInspectTarget(input: string): Promise<ResolvedInspectTarget> {
  const local = await resolveExistingLocalPath(input);
  if (local !== null) return local;

  let reference: ReturnType<typeof parseChunkReference>;
  try {
    reference = parseChunkReference(input);
  } catch (err) {
    throw validationError((err as Error).message);
  }
  const absolutePath = await resolveKbPath(
    KNOWLEDGE_BASES_ROOT_DIR,
    reference.knowledgeBase,
    reference.kbRelativePath,
    { mustExist: true },
  );
  return {
    target: input,
    absolutePath,
    knowledgeBase: reference.knowledgeBase,
    kbRelativePath: reference.kbRelativePath,
    displayPath: reference.displayPath,
    targetKind: 'kb-reference',
  };
}

async function resolveExistingLocalPath(input: string): Promise<ResolvedInspectTarget | null> {
  let stat: import('fs').Stats;
  const candidate = path.resolve(input);
  try {
    stat = await fsp.stat(candidate);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
  if (!stat.isFile()) throw new Error(`not a file: ${input}`);

  const absolutePath = await fsp.realpath(candidate);
  const kbRootReal = await fsp.realpath(KNOWLEDGE_BASES_ROOT_DIR);
  const rootRelative = path.relative(kbRootReal, absolutePath).split(path.sep).join('/');
  if (rootRelative === '' || rootRelative.startsWith('../') || rootRelative === '..' || path.posix.isAbsolute(rootRelative)) {
    throw validationError(`target is outside KNOWLEDGE_BASES_ROOT_DIR: ${input}`);
  }
  const slash = rootRelative.indexOf('/');
  if (slash <= 0 || slash >= rootRelative.length - 1) {
    throw validationError(`target does not resolve to <kb>/<path>: ${rootRelative}`);
  }
  return {
    target: input,
    absolutePath,
    knowledgeBase: rootRelative.slice(0, slash),
    kbRelativePath: rootRelative.slice(slash + 1),
    displayPath: rootRelative,
    targetKind: 'local-path',
  };
}

function exitCodeForResolveError(err: unknown): number {
  const code = (err as { code?: unknown }).code;
  if (code === 'VALIDATION' || code === 'KB_NOT_FOUND') return 2;
  return 1;
}

function validationError(message: string): Error & { code: 'VALIDATION' } {
  return Object.assign(new Error(message), { code: 'VALIDATION' as const });
}

async function inspectTarget(target: ResolvedInspectTarget): Promise<InspectPayload> {
  const extension = path.extname(target.absolutePath).toLowerCase();
  const sourceBuffer = await fsp.readFile(target.absolutePath);
  const extractionCache = await captureExtractionCacheStatus(extension, async () => {
    const loaded = await loadFile(target.absolutePath, { writeExtractionCacheOnMiss: false });
    return loaded;
  });
  const loadedContent = extractionCache.value;
  const boundedContent = applyExtractedTextLimit(target.absolutePath, loadedContent);
  const parsedFrontmatter = parseFrontmatter(boundedContent);
  const liftedFrontmatter = liftFrontmatter(parsedFrontmatter.frontmatter, target.absolutePath);
  const documents = await buildChunkDocuments(
    target.absolutePath,
    loadedContent,
    target.knowledgeBase,
    {
      generateContextualPrefaces: false,
      enforceSecretScan: false,
    },
  );
  const { chunkSize, chunkOverlap } = resolveChunkSize();
  const chunks = buildChunkBoundaries(parsedFrontmatter.body, documents.map((doc) => doc.pageContent));
  const secretScan = inspectSecretScan(target, documents, liftedFrontmatter);
  const quarantine = await inspectQuarantine(target, sourceBuffer);
  const contextual = await inspectContextualPreface(target, parsedFrontmatter.body, chunks.length);

  return {
    schema_version: 'kb.inspect.v1',
    target: target.target,
    path: target.absolutePath,
    knowledgeBase: target.knowledgeBase,
    relativePath: target.displayPath,
    read_only: true,
    source: {
      extension,
      source_bytes: sourceBuffer.length,
      loaded_text_bytes: Buffer.byteLength(loadedContent, 'utf-8'),
      source_sha256: sha256Buffer(sourceBuffer),
    },
    loader: {
      extraction_cache: extractionCache.status,
    },
    splitter: {
      type: extension === '.md' ? 'markdown' : 'recursive_character',
      chunk_size: chunkSize,
      chunk_overlap: chunkOverlap,
    },
    frontmatter: {
      tags: parsedFrontmatter.tags,
      lifted_keys: liftedFrontmatter === undefined ? [] : Object.keys(liftedFrontmatter).sort(),
    },
    secret_scan: secretScan,
    quarantine,
    contextual_preface: contextual,
    chunks,
  };
}

async function captureExtractionCacheStatus<T>(
  extension: string,
  load: () => Promise<T>,
): Promise<{ value: T; status: ExtractionCacheInspect }> {
  const applies = SUPPORTED_LOADER_EXTENSIONS.includes(extension);
  const cacheDir = defaultExtractionCacheDir();
  const before = applies ? await inventoryExtractionCache(cacheDir) : null;
  const value = await load();
  const after = applies ? await inventoryExtractionCache(cacheDir) : null;
  return {
    value,
    status: {
      applies,
      cache_dir: cacheDir,
      may_write_on_miss: false,
      entry_count_before: before?.summary.entry_count ?? null,
      entry_count_after: after?.summary.entry_count ?? null,
      changed_during_inspect: before === null || after === null
        ? null
        : before.summary.entry_count !== after.summary.entry_count ||
          before.summary.total_bytes !== after.summary.total_bytes,
    },
  };
}

function inspectSecretScan(
  target: ResolvedInspectTarget,
  documents: ReadonlyArray<{ pageContent: string }>,
  liftedFrontmatter: unknown,
): SecretScanVerdict {
  const scanOptions = resolveIngestSecretScanOptions();
  if (!scanOptions.enabled) {
    return emptySecretVerdict(false, 'disabled');
  }
  if (scanOptions.bypassKnowledgeBases.includes(target.knowledgeBase)) {
    return emptySecretVerdict(true, 'bypassed');
  }

  const inputs: SecretScanInput[] = documents.map((document, chunkIndex) => ({
    content: document.pageContent,
    chunkIndex,
    location: 'chunk',
  }));
  if (liftedFrontmatter !== undefined) {
    inputs.push({
      content: JSON.stringify(liftedFrontmatter),
      location: 'frontmatter',
    });
  }

  try {
    assertNoIngestSecrets(inputs, {
      relativePath: target.displayPath,
      knowledgeBaseName: target.knowledgeBase,
      scanOptions,
    });
    return emptySecretVerdict(true, 'clean');
  } catch (err) {
    if (err instanceof IngestSecretDetectedError) {
      return {
        enabled: true,
        verdict: 'secret_detected',
        categories: err.categories,
        chunk_indexes: err.chunkIndexes,
        locations: err.locations,
        error_code: err.code,
        message: err.message,
      };
    }
    throw err;
  }
}

function emptySecretVerdict(
  enabled: boolean,
  verdict: SecretScanVerdict['verdict'],
): SecretScanVerdict {
  return {
    enabled,
    verdict,
    categories: [],
    chunk_indexes: [],
    locations: [],
    error_code: null,
    message: null,
  };
}

async function inspectQuarantine(
  target: ResolvedInspectTarget,
  sourceBuffer: Buffer,
): Promise<InspectPayload['quarantine']> {
  const kbPath = path.join(KNOWLEDGE_BASES_ROOT_DIR, target.knowledgeBase);
  const record = await getIngestQuarantineRecord(kbPath, target.kbRelativePath);
  const sourceSha = sha256Buffer(sourceBuffer);
  return {
    manifest_path: quarantineManifestPath(kbPath),
    present: record !== null,
    source_sha256_matches: record?.source_sha256 === undefined || record.source_sha256 === null
      ? null
      : record.source_sha256 === sourceSha,
    record,
  };
}

async function inspectContextualPreface(
  target: ResolvedInspectTarget,
  body: string,
  expectedChunks: number,
): Promise<ContextualPrefaceInspect> {
  const sidecarPath = sidecarPathFor(target.absolutePath, target.knowledgeBase);
  const { chunkSize, chunkOverlap } = resolveChunkSize();
  const base: ContextualPrefaceInspect = {
    enabled: isContextualRetrievalEnabled(),
    generation_skipped: true,
    sidecar_path: sidecarPath,
    sidecar_exists: false,
    sidecar_valid: null,
    document_hash_matches: null,
    generator_matches: null,
    chunk_config_matches: null,
    model: null,
    chunks: {
      total: null,
      with_preface: 0,
      null_preface: 0,
      retry_pending: 0,
    },
  };

  let raw: string;
  try {
    raw = await fsp.readFile(sidecarPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return base;
    throw err;
  }

  base.sidecar_exists = true;
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      base.sidecar_valid = false;
      return base;
    }
    parsed = value as Record<string, unknown>;
  } catch {
    base.sidecar_valid = false;
    return base;
  }

  base.sidecar_valid = true;
  base.document_hash_matches = parsed.document_hash === contextualSha256(body);
  base.generator_matches = parsed.generator === GENERATOR_VERSION;
  base.chunk_config_matches = parsed.chunk_size === chunkSize && parsed.chunk_overlap === chunkOverlap;
  base.model = typeof parsed.model === 'string' ? parsed.model : null;
  if (Array.isArray(parsed.chunks)) {
    base.chunks.total = parsed.chunks.length;
    for (const chunk of parsed.chunks) {
      if (typeof chunk !== 'object' || chunk === null) continue;
      const entry = chunk as Record<string, unknown>;
      if (typeof entry.preface === 'string' && entry.preface.length > 0) {
        base.chunks.with_preface += 1;
      } else if (entry.preface === null) {
        base.chunks.null_preface += 1;
        if (typeof entry.next_retry_after === 'string' && Date.parse(entry.next_retry_after) > Date.now()) {
          base.chunks.retry_pending += 1;
        }
      }
    }
  } else {
    base.chunks.total = expectedChunks;
  }
  return base;
}

function buildChunkBoundaries(sourceBody: string, chunks: readonly string[]): ChunkBoundary[] {
  let searchFrom = 0;
  return chunks.map((text, index) => {
    const start = sourceBody.indexOf(text, searchFrom);
    const end = start === -1 ? -1 : start + text.length;
    if (start !== -1) searchFrom = Math.max(start + 1, end);
    return {
      chunk_index: index,
      chars: text.length,
      bytes: Buffer.byteLength(text, 'utf-8'),
      normalized_text_sha256: sha256String(normalizeChunkTextForEmbedding(text)),
      start_char: start === -1 ? null : start,
      end_char: end === -1 ? null : end,
      lines: start === -1 ? null : lineRangeForSpan(sourceBody, start, end),
    };
  });
}

function lineRangeForSpan(text: string, start: number, end: number): { from: number; to: number } {
  const before = text.slice(0, start);
  const span = text.slice(start, end);
  const from = countLines(before);
  const to = Math.max(from, from + countNewlines(span));
  return { from, to };
}

function countLines(text: string): number {
  return 1 + countNewlines(text);
}

function countNewlines(text: string): number {
  return (text.match(/\n/g) ?? []).length;
}

function formatInspectMarkdown(payload: InspectPayload): string {
  const frontmatter = payload.frontmatter.lifted_keys.length === 0
    ? 'none'
    : payload.frontmatter.lifted_keys.join(', ');
  const quarantine = payload.quarantine.present
    ? `present (${payload.quarantine.record?.error_category ?? 'unknown'})`
    : 'absent';
  const context = payload.contextual_preface.sidecar_exists
    ? `sidecar present, ${payload.contextual_preface.chunks.with_preface} cached prefaces`
    : 'no sidecar';
  const extraction = payload.loader.extraction_cache.applies
    ? `applies; entries ${payload.loader.extraction_cache.entry_count_before} -> ${payload.loader.extraction_cache.entry_count_after}`
    : 'not used';
  const chunkLines = payload.chunks.map((chunk) => {
    const location = chunk.lines === null
      ? 'lines unknown'
      : `L${chunk.lines.from}-L${chunk.lines.to}`;
    return `- #${chunk.chunk_index}: ${chunk.chars} chars, ${chunk.bytes} bytes, ${location}`;
  }).join('\n');

  return [
    `kb inspect: ${payload.relativePath}`,
    '',
    `Path: ${payload.path}`,
    `Splitter: ${payload.splitter.type} (chunk_size=${payload.splitter.chunk_size}, overlap=${payload.splitter.chunk_overlap})`,
    `Chunks: ${payload.chunks.length}`,
    `Frontmatter keys: ${frontmatter}`,
    `Secret scan: ${payload.secret_scan.verdict}`,
    `Quarantine: ${quarantine}`,
    `Contextual preface: generation skipped; ${context}`,
    `Extraction cache: ${extraction}`,
    '',
    'Chunks:',
    chunkLines.length === 0 ? '- none' : chunkLines,
    '',
  ].join('\n');
}

function sha256Buffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256String(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
