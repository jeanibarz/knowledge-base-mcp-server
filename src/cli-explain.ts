// Issue #209 — `kb explain <query>` single-query retrieval-trace surface.
//
// Reuses the same retrieval primitives as `kb search`:
//   - active-model resolution (resolveActiveModel)
//   - FaissIndexManager.similaritySearch
//   - search-core.computeStaleness (freshness footer)
//   - search-errors-core classifier (uniform error contract)
//
// CLI-only on purpose — see #209. There is intentionally NO MCP tool that
// emits this trace; agents should call the CLI when they need the surface.

import { readFileSync, realpathSync } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { FaissIndexManager, type SimilaritySearchTiming } from './FaissIndexManager.js';
import {
  resolveActiveModel,
  resolveFaissIndexBinaryPath,
} from './active-model.js';
import {
  classifyKbSearchError,
  exitCodeForFailure,
  formatKbSearchFailureJson,
  formatKbSearchFailureStderr,
  type SearchFailure,
} from './search-errors-core.js';
import { computeStaleness } from './search-core.js';
import { loadManagerForModel, loadWithJsonRetry } from './cli-shared.js';
import {
  FAISS_INDEX_PATH,
} from './config/paths.js';
import {
  INGEST_EXCLUDE_PATHS,
  INGEST_EXTRA_EXTENSIONS,
} from './config/ingest.js';
import { elapsedMs, nowMs } from './timing-core.js';
import {
  buildCandidates,
  buildQueryBlock,
  deriveDiagnostics,
  EXPLAIN_TRACE_SCHEMA_VERSION,
  formatExplainTraceAsJson,
  formatExplainTraceAsMarkdown,
  type ExplainTrace,
} from './explain-trace.js';

export const EXPLAIN_HELP = `kb explain — single-query retrieval trace (debug surface)

Usage:
  kb explain <query> [options]

Runs ONE retrieval against the active model and emits a verbose static
trace of every step: the tokenized query, the active model + index +
freshness, top-K + near-miss candidates with scores, applied filters,
per-step timings, and diagnostic suggestions. This command is intended
for contributors, bug-reporters, and agents debugging their own
retrieval failures — it is intentionally NOT exposed on the MCP tool
surface (issue #209).

Scope:
  --kb=<name>             Scope to one knowledge base. Omit to search ALL KBs.
  --model=<id>            Override the active model for this call (RFC 013).

Result tuning:
  --k=<int>               Top-K to highlight (default 5). The trace also
                          surfaces near-miss candidates one rank below.
  --candidates=<int>      Total candidates to fetch (default k + 5).
                          Larger values surface deeper near-misses.
  --threshold=<float>     Max similarity score for candidates (default: no
                          cap, so near-misses stay visible).

Output:
  --format=md|json        Output format (default: md). JSON output is
                          schema-versioned (\`schema_version\` field).

Repro bundle:
  --repro-bundle=<dir>    Write a redacted repro bundle to <dir> containing
                          \`manifest.json\`, \`query.txt\`, \`system.json\`,
                          \`top-candidates.json\`, and \`freshness.json\`.
                          Bundle dirs are private (0700) and files are private
                          (0600) on POSIX. Chunk *content* is NOT included
                          unless you also pass \`--include-content\`.
  --include-content       Bundle the candidate chunk text alongside the
                          metadata. Explicit consent for KB content to leave
                          the trust boundary; default is content-redacted.
  --force                 If <dir> already exists with unsafe group/other
                          permissions, set its mode to 0700 before writing.

Misc:
  --help, -h              Show this help.

Examples:
  kb explain "INDEX_NOT_INITIALIZED"
  kb explain "rollback procedure" --kb=runbooks --k=3 --candidates=10
  kb explain "deploy" --format=json > trace.json
  kb explain "deploy" --repro-bundle=./bug-209-bundle
`;

export type ExplainFormat = 'md' | 'json';

export interface ExplainArgs {
  query: string | null;
  kb?: string;
  model?: string;
  k: number;
  candidates: number;
  threshold: number;
  thresholdIsDefault: boolean;
  format: ExplainFormat;
  reproBundle: string | null;
  includeContent: boolean;
  reproBundleForce: boolean;
}

export const EXPLAIN_DEFAULT_K = 5;
export const EXPLAIN_DEFAULT_NEAR_MISS = 5;
const NO_THRESHOLD = Number.POSITIVE_INFINITY;

export interface RunExplainDeps {
  bootstrapLayout: () => Promise<void>;
  resolveActiveModel: typeof resolveActiveModel;
  loadManagerForModel: typeof loadManagerForModel;
  loadWithJsonRetry: typeof loadWithJsonRetry;
  computeStaleness: typeof computeStaleness;
  resolveFaissIndexBinaryPath: typeof resolveFaissIndexBinaryPath;
  writeReproBundle: typeof writeReproBundle;
  readPackageVersion: () => string;
}

const DEFAULT_RUN_EXPLAIN_DEPS: RunExplainDeps = {
  bootstrapLayout: () => FaissIndexManager.bootstrapLayout(),
  resolveActiveModel,
  loadManagerForModel,
  loadWithJsonRetry,
  computeStaleness,
  resolveFaissIndexBinaryPath,
  writeReproBundle,
  readPackageVersion,
};

export function parseExplainArgs(rest: string[]): ExplainArgs {
  const out: ExplainArgs = {
    query: null,
    k: EXPLAIN_DEFAULT_K,
    candidates: EXPLAIN_DEFAULT_K + EXPLAIN_DEFAULT_NEAR_MISS,
    threshold: NO_THRESHOLD,
    thresholdIsDefault: true,
    format: 'md',
    reproBundle: null,
    includeContent: false,
    reproBundleForce: false,
  };
  let candidatesExplicit = false;
  for (const raw of rest) {
    if (raw === '--include-content') { out.includeContent = true; continue; }
    if (raw === '--force') { out.reproBundleForce = true; continue; }
    if (raw.startsWith('--kb=')) { out.kb = raw.slice('--kb='.length); continue; }
    if (raw.startsWith('--model=')) { out.model = raw.slice('--model='.length); continue; }
    if (raw.startsWith('--k=')) {
      const n = Number(raw.slice('--k='.length));
      if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid --k: ${raw}`);
      out.k = n; continue;
    }
    if (raw.startsWith('--candidates=')) {
      const n = Number(raw.slice('--candidates='.length));
      if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid --candidates: ${raw}`);
      out.candidates = n;
      candidatesExplicit = true;
      continue;
    }
    if (raw.startsWith('--threshold=')) {
      const v = raw.slice('--threshold='.length);
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`invalid --threshold: ${raw}`);
      out.threshold = n;
      out.thresholdIsDefault = false;
      continue;
    }
    if (raw.startsWith('--format=')) {
      const v = raw.slice('--format='.length);
      if (v !== 'md' && v !== 'json') throw new Error(`invalid --format: ${raw}`);
      out.format = v; continue;
    }
    if (raw.startsWith('--repro-bundle=')) {
      const v = raw.slice('--repro-bundle='.length);
      if (v.trim() === '') throw new Error(`invalid --repro-bundle: empty path`);
      out.reproBundle = v;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    if (out.query === null) { out.query = raw; continue; }
    throw new Error(`unexpected argument: ${raw}`);
  }
  if (!candidatesExplicit) {
    out.candidates = Math.max(out.candidates, out.k + EXPLAIN_DEFAULT_NEAR_MISS);
  } else if (out.candidates < out.k) {
    throw new Error(
      `invalid --candidates: ${out.candidates} is below --k=${out.k}; raise --candidates`,
    );
  }
  if (out.includeContent && out.reproBundle === null) {
    throw new Error(`--include-content requires --repro-bundle=<dir>`);
  }
  if (out.reproBundleForce && out.reproBundle === null) {
    throw new Error(`--force requires --repro-bundle=<dir>`);
  }
  return out;
}

export async function runExplain(
  rest: string[],
  deps: RunExplainDeps = DEFAULT_RUN_EXPLAIN_DEPS,
): Promise<number> {
  const totalStartedAt = nowMs();
  let parsed: ExplainArgs;
  try {
    parsed = parseExplainArgs(rest);
  } catch (err) {
    process.stderr.write(`kb explain: ${(err as Error).message}\n`);
    return 2;
  }
  if (parsed.query === null) {
    process.stderr.write('kb explain: missing <query>\n');
    return 2;
  }

  const timings = {
    bootstrap: null as number | null,
    model_resolution: null as number | null,
    manager_load: null as number | null,
    index_load: null as number | null,
    staleness: null as number | null,
  };

  try {
    const startedAt = nowMs();
    await deps.bootstrapLayout();
    timings.bootstrap = elapsedMs(startedAt);
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }

  let activeModelId: string;
  try {
    const startedAt = nowMs();
    activeModelId = await deps.resolveActiveModel({ explicitOverride: parsed.model });
    timings.model_resolution = elapsedMs(startedAt);
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }

  let manager: FaissIndexManager;
  try {
    const startedAt = nowMs();
    manager = await deps.loadManagerForModel(activeModelId);
    timings.manager_load = elapsedMs(startedAt);
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }

  try {
    const startedAt = nowMs();
    await deps.loadWithJsonRetry(manager);
    timings.index_load = elapsedMs(startedAt);
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }

  const denseTiming: SimilaritySearchTiming = {};
  let results: Array<{ pageContent: string; metadata: Record<string, unknown>; score: number }>;
  try {
    const raw = await manager.similaritySearch(
      parsed.query,
      parsed.candidates,
      parsed.threshold,
      parsed.kb,
      undefined,
      denseTiming,
    );
    results = raw.map((r) => ({
      pageContent: r.pageContent,
      metadata: r.metadata as Record<string, unknown>,
      score: r.score,
    }));
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }

  const stalenessStartedAt = nowMs();
  const staleness = await deps.computeStaleness(activeModelId, parsed.kb);
  timings.staleness = elapsedMs(stalenessStartedAt);

  const stats = manager.getStats();
  const binaryPath = await deps.resolveFaissIndexBinaryPath(activeModelId);

  const trace = buildTrace({
    parsed,
    query: parsed.query,
    activeModelId,
    embeddingProvider: manager.embeddingProvider,
    embeddingModel: manager.modelName,
    indexBinaryPath: binaryPath,
    indexMtime: staleness.indexMtime,
    cliVersion: deps.readPackageVersion(),
    dim: stats.dim,
    results,
    timings,
    denseTiming,
    totalStartedAt,
    staleness,
  });

  if (parsed.reproBundle !== null) {
    try {
      await deps.writeReproBundle(parsed.reproBundle, trace, results, parsed.includeContent, parsed.reproBundleForce);
    } catch (err) {
      process.stderr.write(`kb explain: failed to write repro bundle: ${(err as Error).message}\n`);
      return 1;
    }
  }

  if (parsed.format === 'json') {
    process.stdout.write(formatExplainTraceAsJson(trace));
  } else {
    process.stdout.write(formatExplainTraceAsMarkdown(trace));
    if (parsed.reproBundle !== null) {
      const noun = parsed.includeContent ? 'including chunk content' : 'metadata only — chunk content redacted';
      process.stdout.write(`\n> _Repro bundle written to \`${parsed.reproBundle}\` (${noun})._\n`);
    }
  }
  return 0;
}

interface BuildTraceInput {
  parsed: ExplainArgs;
  query: string;
  activeModelId: string;
  embeddingProvider: string;
  embeddingModel: string;
  indexBinaryPath: string | null;
  indexMtime: string | null;
  cliVersion: string;
  dim: number | null;
  results: Array<{ pageContent: string; metadata: Record<string, unknown>; score: number }>;
  timings: {
    bootstrap: number | null;
    model_resolution: number | null;
    manager_load: number | null;
    index_load: number | null;
    staleness: number | null;
  };
  denseTiming: SimilaritySearchTiming;
  totalStartedAt: number;
  staleness: { indexMtime: string | null; modifiedFiles: number; newFiles: number };
}

function buildTrace(input: BuildTraceInput): ExplainTrace {
  const queryBlock = buildQueryBlock(input.query);
  const candidates = buildCandidates(input.results, input.parsed.k);

  const partial: Omit<ExplainTrace, 'diagnostics'> = {
    schema_version: EXPLAIN_TRACE_SCHEMA_VERSION,
    query: queryBlock,
    system: {
      active_model_id: input.activeModelId,
      embedding_provider: input.embeddingProvider,
      embedding_model: input.embeddingModel,
      index_path: FAISS_INDEX_PATH,
      index_binary_path: input.indexBinaryPath,
      index_mtime: input.indexMtime,
      cli_version: input.cliVersion,
      ingest_extra_extensions: INGEST_EXTRA_EXTENSIONS,
      ingest_exclude_paths: INGEST_EXCLUDE_PATHS,
    },
    embedding: {
      provider: input.embeddingProvider,
      model: input.embeddingModel,
      embed_latency_ms: numberOrNull(input.denseTiming.embed_query_ms),
      dim: input.dim,
    },
    retrieval: {
      k: input.parsed.k,
      near_misses_requested: Math.max(0, input.parsed.candidates - input.parsed.k),
      fetch_k: input.denseTiming.fetch_k ?? input.parsed.candidates,
      candidates,
    },
    filters: {
      kb_scope: input.parsed.kb ?? null,
      threshold: input.parsed.threshold,
      threshold_is_default: input.parsed.thresholdIsDefault,
      excluded_paths: INGEST_EXCLUDE_PATHS,
      extra_extensions: INGEST_EXTRA_EXTENSIONS,
    },
    timing: {
      bootstrap_ms: input.timings.bootstrap,
      model_resolution_ms: input.timings.model_resolution,
      manager_load_ms: input.timings.manager_load,
      index_load_ms: input.timings.index_load,
      embed_query_ms: numberOrNull(input.denseTiming.embed_query_ms),
      faiss_search_ms: numberOrNull(input.denseTiming.faiss_search_ms ?? input.denseTiming.query_search_ms),
      post_filter_ms: numberOrNull(input.denseTiming.post_filter_ms),
      staleness_ms: input.timings.staleness,
      total_ms: elapsedMs(input.totalStartedAt),
    },
    freshness: {
      index_mtime: input.staleness.indexMtime,
      modified_files: input.staleness.modifiedFiles,
      new_files: input.staleness.newFiles,
    },
  };
  return { ...partial, diagnostics: deriveDiagnostics(partial) };
}

function numberOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Issue #209 — repro bundle is a *directory* (not a zip) so it works with
 * zero new dependencies. Operators can `tar czf` / `zip -r` themselves
 * before attaching to a bug report; the README will document the gesture.
 * Chunk content is *redacted by default*; the operator must pass
 * `--include-content` to bundle it (explicit trust-boundary opt-in).
 * Issue #717 hardens this export path: the target directory is private
 * (0700), files are private (0600), and `manifest.json` records the privacy
 * posture so bug reports can be audited before sharing.
 */
export async function writeReproBundle(
  bundlePath: string,
  trace: ExplainTrace,
  results: ReadonlyArray<{ pageContent: string; metadata: Record<string, unknown>; score: number }>,
  includeContent: boolean,
  forceUnsafeExistingDirectory = false,
): Promise<void> {
  const directory = await ensurePrivateBundleDirectory(bundlePath, forceUnsafeExistingDirectory);
  const files: ReproBundleFileManifest[] = [];

  files.push(await writePrivateUtf8File(
    bundlePath,
    'query.txt',
    `${trace.query.raw}\n`,
  ));

  files.push(await writePrivateUtf8File(
    bundlePath,
    'system.json',
    `${JSON.stringify({
      schema_version: trace.schema_version,
      system: trace.system,
      embedding: trace.embedding,
      filters: trace.filters,
      timing: trace.timing,
    }, null, 2)}\n`,
  ));

  const topCandidates = trace.retrieval.candidates.map((c, idx) => ({
    rank: c.rank,
    score: c.score,
    source: c.source,
    relative_path: c.relative_path,
    knowledge_base: c.knowledge_base,
    chunk_index: c.chunk_index,
    in_topk: c.in_topk,
    frontmatter: extractFrontmatter(results[idx]?.metadata ?? {}),
    ...(includeContent ? { content: results[idx]?.pageContent ?? '' } : {}),
  }));
  files.push(await writePrivateUtf8File(
    bundlePath,
    'top-candidates.json',
    `${JSON.stringify(
      {
        schema_version: trace.schema_version,
        k: trace.retrieval.k,
        fetch_k: trace.retrieval.fetch_k,
        near_misses_requested: trace.retrieval.near_misses_requested,
        content_included: includeContent,
        candidates: topCandidates,
      },
      null,
      2,
    )}\n`,
  ));

  files.push(await writePrivateUtf8File(
    bundlePath,
    'freshness.json',
    `${JSON.stringify(
      {
        schema_version: trace.schema_version,
        freshness: trace.freshness,
      },
      null,
      2,
    )}\n`,
  ));

  const pendingManifestFile: ReproBundleFileManifest = {
    path: 'manifest.json',
    mode: isPosixPermissionsSupported() ? '0600' : null,
  };
  await writePrivateUtf8File(
    bundlePath,
    'manifest.json',
    `${JSON.stringify(
      buildReproBundleManifest(trace, includeContent, directory, [...files, pendingManifestFile]),
      null,
      2,
    )}\n`,
  );
  // Rewrite after statting the manifest so the manifest records its own final mode.
  const manifestFile = await describeBundleFile(path.join(bundlePath, 'manifest.json'), 'manifest.json');
  await writePrivateUtf8File(
    bundlePath,
    'manifest.json',
    `${JSON.stringify(
      buildReproBundleManifest(trace, includeContent, directory, [...files, manifestFile]),
      null,
      2,
    )}\n`,
  );
}

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const UNSAFE_DIR_MODE_MASK = 0o077;
const REPRO_BUNDLE_FILENAMES = new Set([
  'query.txt',
  'system.json',
  'top-candidates.json',
  'freshness.json',
  'manifest.json',
]);

interface ReproBundleDirectoryManifest {
  path: string;
  mode: string | null;
  existed: boolean;
  existing_mode: string | null;
  existing_directory_was_unsafe: boolean;
  unsafe_existing_directory_forced: boolean;
}

interface ReproBundleFileManifest {
  path: string;
  mode: string | null;
}

interface ReproBundleManifest {
  schema_version: 'kb-explain-repro-bundle.v1';
  trace_schema_version: string;
  content_included: boolean;
  permissions: {
    posix_permissions_enforced: boolean;
    intended_directory_mode: '0700';
    intended_file_mode: '0600';
    directory: ReproBundleDirectoryManifest;
  };
  files: ReproBundleFileManifest[];
}

async function ensurePrivateBundleDirectory(
  bundlePath: string,
  forceUnsafeExistingDirectory: boolean,
): Promise<ReproBundleDirectoryManifest> {
  const posixPermissions = isPosixPermissionsSupported();
  let existed = false;
  let existingMode: string | null = null;
  let existingDirectoryWasUnsafe = false;

  try {
    const existing = await fsp.stat(bundlePath);
    existed = true;
    if (!existing.isDirectory()) {
      throw new Error(`${bundlePath} exists and is not a directory`);
    }
    if (posixPermissions) {
      existingMode = formatMode(existing.mode);
      existingDirectoryWasUnsafe = (existing.mode & UNSAFE_DIR_MODE_MASK) !== 0;
      if (existingDirectoryWasUnsafe && !forceUnsafeExistingDirectory) {
        throw new Error(
          `${bundlePath} exists with unsafe permissions ${existingMode}; ` +
          `rerun with --force to chmod it to 0700 before writing`,
        );
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await fsp.mkdir(bundlePath, { recursive: true, mode: PRIVATE_DIR_MODE });
  }

  if (posixPermissions) {
    await fsp.chmod(bundlePath, PRIVATE_DIR_MODE);
  }
  await assertBundleDirectoryHasOnlyBundleFiles(bundlePath);
  const final = await fsp.stat(bundlePath);
  return {
    path: bundlePath,
    mode: posixPermissions ? formatMode(final.mode) : null,
    existed,
    existing_mode: existingMode,
    existing_directory_was_unsafe: existingDirectoryWasUnsafe,
    unsafe_existing_directory_forced: existingDirectoryWasUnsafe && forceUnsafeExistingDirectory,
  };
}

async function assertBundleDirectoryHasOnlyBundleFiles(bundlePath: string): Promise<void> {
  const entries = await fsp.readdir(bundlePath, { withFileTypes: true });
  const unsafeEntries = entries
    .filter((entry) => !REPRO_BUNDLE_FILENAMES.has(entry.name) || !entry.isFile())
    .map((entry) => entry.name)
    .sort();
  if (unsafeEntries.length > 0) {
    throw new Error(
      `${bundlePath} contains non-bundle file(s): ${unsafeEntries.join(', ')}; ` +
      `choose an empty directory or remove stale files before writing`,
    );
  }
}

async function writePrivateUtf8File(
  bundlePath: string,
  relativePath: string,
  body: string,
): Promise<ReproBundleFileManifest> {
  const filePath = path.join(bundlePath, relativePath);
  await fsp.writeFile(filePath, body, { encoding: 'utf-8', mode: PRIVATE_FILE_MODE });
  if (isPosixPermissionsSupported()) {
    await fsp.chmod(filePath, PRIVATE_FILE_MODE);
  }
  return describeBundleFile(filePath, relativePath);
}

async function describeBundleFile(filePath: string, relativePath: string): Promise<ReproBundleFileManifest> {
  if (!isPosixPermissionsSupported()) {
    return { path: relativePath, mode: null };
  }
  const stats = await fsp.stat(filePath);
  return { path: relativePath, mode: formatMode(stats.mode) };
}

function buildReproBundleManifest(
  trace: ExplainTrace,
  includeContent: boolean,
  directory: ReproBundleDirectoryManifest,
  files: ReproBundleFileManifest[],
): ReproBundleManifest {
  return {
    schema_version: 'kb-explain-repro-bundle.v1',
    trace_schema_version: trace.schema_version,
    content_included: includeContent,
    permissions: {
      posix_permissions_enforced: isPosixPermissionsSupported(),
      intended_directory_mode: '0700',
      intended_file_mode: '0600',
      directory,
    },
    files,
  };
}

function isPosixPermissionsSupported(): boolean {
  return process.platform !== 'win32';
}

function formatMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, '0');
}

function extractFrontmatter(metadata: Record<string, unknown>): unknown {
  const fm = metadata.frontmatter;
  if (fm === undefined || fm === null) return null;
  return fm;
}

function reportFailure(failure: SearchFailure, format: ExplainFormat): number {
  if (format === 'json') {
    process.stdout.write(formatKbSearchFailureJson(failure));
  } else {
    process.stderr.write(formatKbSearchFailureStderr(failure));
  }
  return exitCodeForFailure(failure);
}

function readPackageVersion(): string {
  // Mirrors cli-stats.readPackageVersion: argv[1] is the resolved CLI path
  // (build/cli.js or a symlink to it), so package.json sits one level up.
  // Avoiding `import.meta.url` here because ts-jest's emit doesn't allow it
  // under the project's tsconfig module setting.
  try {
    const here = realpathSync(process.argv[1] ?? path.join(process.cwd(), 'build', 'cli.js'));
    const pkgPath = path.join(path.dirname(here), '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
