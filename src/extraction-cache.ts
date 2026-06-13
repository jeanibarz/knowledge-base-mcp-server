// Issue #279 — content-addressed cache for normalized text extracted from
// expensive loaders (`.pdf` via pdf-parse, `.html`/`.htm` via html-to-text).
//
// Why this exists. Multi-model registration (RFC 013) plus the existing
// per-file hash gate in `FaissIndexManager.updateIndex` together mean the
// same source corpus can be parsed multiple times — once per model when
// rebuilding from an empty index, and again on every `--force` reindex even
// when the file bytes have not changed. PDF and HTML extraction is the
// dominant cost on those rebuilds (pdfjs-dist glyph reconstruction + worker
// loopback), so caching the extracted text by content hash lets subsequent
// rebuilds skip the parse entirely and feed the existing splitter pipeline.
//
// Cache key. sha256(schemaVersion | loaderName | loaderVersion | ext |
// contentSha256). Including loaderName + loaderVersion in the key means a
// loader behavior change (bump the constant in `loaders.ts`) automatically
// invalidates every cache entry produced by the previous behavior — operators
// do not have to manually purge the cache directory. The extension is part of
// the key because `getLoader` dispatches on extension, so the same bytes
// renamed from `.pdf` to `.htm` would route through a different parser and
// must not share a cache entry.
//
// Storage. Plain UTF-8 files under `${FAISS_INDEX_PATH}/extracted-text/`,
// one file per key. Writes are atomic (tmp file + rename) so a crash mid-write
// cannot leave a partial entry that a later run would treat as valid text.
// Reads and writes are best-effort: any I/O error logs a warning and falls
// back to the cold path (re-parse), so a misconfigured `EXTRACTION_TEXT_CACHE_DIR`
// or a full disk degrades to "no cache" rather than failing the ingest.

import { createHash } from 'crypto';
import type { Stats } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { FAISS_INDEX_PATH } from './config/paths.js';
import { logger } from './logger.js';

/**
 * Storage-format version. Bump only when the on-disk layout changes (e.g.
 * compressed payloads, sidecar metadata). Loader-behavior changes bump the
 * loader-specific `loaderVersion` instead — that scoping prevents a PDF-only
 * loader bump from invalidating HTML cache entries.
 */
export const EXTRACTION_CACHE_SCHEMA_VERSION = 1;

/**
 * Inputs that uniquely identify an extracted-text cache entry. All five fields
 * are folded into a sha256; any change produces a different cache key and a
 * miss on the next read.
 */
export interface ExtractionCacheKeyInput {
  loaderName: string;
  loaderVersion: number;
  ext: string;
  contentSha256: string;
}

/** sha256 over the raw file bytes — hex, 64 chars. */
export function computeContentSha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Derive the cache filename stem from the key inputs. Pure: same inputs ⇒
 * same output, no I/O. Encoded as a sha256 hex digest so the result is a
 * fixed 64-char filename safe on every supported filesystem (no special
 * characters from `loaderName`, no Windows path-length surprises).
 */
export function computeExtractionCacheKey(input: ExtractionCacheKeyInput): string {
  const composite = [
    `schema=${EXTRACTION_CACHE_SCHEMA_VERSION}`,
    `loader=${input.loaderName}`,
    `loaderVersion=${input.loaderVersion}`,
    `ext=${input.ext.toLowerCase()}`,
    `content=${input.contentSha256}`,
  ].join('|');
  return createHash('sha256').update(composite).digest('hex');
}

/**
 * Resolve the cache directory at call time so tests can redirect the cache
 * into a per-test tempdir via `EXTRACTION_TEXT_CACHE_DIR` after the module
 * has loaded. Falls back to `${FAISS_INDEX_PATH}/extracted-text/` — the
 * extracted text is model-independent so it lives at the index root, shared
 * across every registered model.
 */
export function defaultExtractionCacheDir(): string {
  const override = process.env.EXTRACTION_TEXT_CACHE_DIR;
  if (override !== undefined && override.trim() !== '') return override;
  return path.join(FAISS_INDEX_PATH, 'extracted-text');
}

function cacheEntryPath(cacheDir: string, cacheKey: string): string {
  return path.join(cacheDir, `${cacheKey}.txt`);
}

/**
 * Read the cached text for `cacheKey`. Returns `null` on a miss (ENOENT) and
 * on any other read failure (logged at debug — the cold path will re-parse).
 * Never throws: a broken cache must degrade to "no cache", not block ingest.
 */
export async function readCachedExtraction(
  cacheDir: string,
  cacheKey: string,
): Promise<string | null> {
  try {
    return await fsp.readFile(cacheEntryPath(cacheDir, cacheKey), 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    logger.debug(
      `extraction-cache: read failed for ${cacheKey} (${code ?? 'unknown'}): ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * Write `text` atomically under `cacheKey`. Writes the payload to a unique
 * tmp file, fsyncs it, then renames into place — a crash before the rename
 * leaves no partial entry, and the rename is atomic on every supported
 * filesystem. Failures are logged at warn and swallowed so ingest continues
 * with the freshly parsed text in-hand.
 */
export async function writeCachedExtraction(
  cacheDir: string,
  cacheKey: string,
  text: string,
): Promise<void> {
  const targetPath = cacheEntryPath(cacheDir, cacheKey);
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  try {
    await fsp.mkdir(cacheDir, { recursive: true });
    const handle = await fsp.open(tmpPath, 'w');
    try {
      await handle.writeFile(text, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fsp.rename(tmpPath, targetPath);
    } catch (renameErr) {
      await fsp.unlink(tmpPath).catch(() => {});
      throw renameErr;
    }
  } catch (err) {
    logger.warn(
      `extraction-cache: write failed for ${cacheKey}: ${(err as Error).message}`,
    );
  }
}

/** Options for {@link loadWithExtractionCache}. */
export interface CachedLoadOptions {
  filePath: string;
  loaderName: string;
  loaderVersion: number;
  /** Parse the file bytes into normalized text. Invoked only on a cache miss. */
  parse: (buffer: Buffer) => Promise<string>;
  /** Override the cache directory; defaults to {@link defaultExtractionCacheDir}. */
  cacheDir?: string;
  /** When false, return parsed text on a miss without populating the cache. */
  writeOnMiss?: boolean;
}

export interface ExtractionCacheEntry {
  filename: string;
  path: string;
  size_bytes: number;
  mtime: string;
  mtime_ms: number;
}

export interface ExtractionCacheInventory {
  schema_version: 'kb.extraction-cache.inventory.v1';
  cache_dir: string;
  generated_at: string;
  exists: boolean;
  entries: ExtractionCacheEntry[];
  ignored_entries: Array<{
    filename: string;
    reason: 'not_cache_file' | 'not_file';
  }>;
  errors: Array<{
    path: string;
    message: string;
    code: string | null;
  }>;
  summary: {
    entry_count: number;
    total_bytes: number;
    oldest_mtime: string | null;
    newest_mtime: string | null;
    ignored_entry_count: number;
    error_count: number;
  };
}

export interface ExtractionCachePruneOptions {
  cacheDir?: string;
  maxAgeDays?: number;
  maxSizeBytes?: number;
  now?: Date;
}

export interface ExtractionCachePruneEntry extends ExtractionCacheEntry {
  reasons: Array<'age' | 'size'>;
}

export interface ExtractionCachePrunePlan {
  schema_version: 'kb.extraction-cache.prune-plan.v1';
  dry_run: true;
  cache_dir: string;
  generated_at: string;
  limits: {
    max_age_days: number | null;
    max_size_bytes: number | null;
  };
  inventory: ExtractionCacheInventory['summary'];
  prunable_entries: ExtractionCachePruneEntry[];
  kept_entries: ExtractionCacheEntry[];
  summary: {
    prunable_count: number;
    prunable_bytes: number;
    kept_count: number;
    kept_bytes: number;
    age_prunable_count: number;
    size_prunable_count: number;
  };
}

export interface ExtractionCachePruneApplyResult {
  schema_version: 'kb.extraction-cache.prune-apply.v1';
  dry_run: false;
  cache_dir: string;
  generated_at: string;
  plan: ExtractionCachePrunePlan;
  deleted_entries: ExtractionCachePruneEntry[];
  failed_entries: Array<{
    filename: string;
    path: string;
    message: string;
    code: string | null;
  }>;
  summary: {
    deleted_count: number;
    deleted_bytes: number;
    failed_count: number;
  };
}

const EXTRACTION_CACHE_FILE_RE = /^[a-f0-9]{64}\.txt$/;

/**
 * Read `filePath`, look up the extraction cache by content hash, and either
 * return the cached text or invoke `parse` on the file bytes and store the
 * result for the next caller. Used by `loadPdf` / `loadHtml` in `loaders.ts`.
 *
 * The buffer is read inside this helper (not by the caller) so the content
 * hash and the parse input come from the same byte snapshot — important if
 * the file is concurrently rewritten, since otherwise the cache key could
 * describe one version of the bytes while the parser sees another.
 */
export async function loadWithExtractionCache(opts: CachedLoadOptions): Promise<string> {
  const buffer = await fsp.readFile(opts.filePath);
  const contentSha256 = computeContentSha256(buffer);
  const ext = path.extname(opts.filePath).toLowerCase();
  const cacheKey = computeExtractionCacheKey({
    loaderName: opts.loaderName,
    loaderVersion: opts.loaderVersion,
    ext,
    contentSha256,
  });
  const cacheDir = opts.cacheDir ?? defaultExtractionCacheDir();

  const cached = await readCachedExtraction(cacheDir, cacheKey);
  if (cached !== null) {
    logger.debug(`extraction-cache: hit for ${opts.filePath} (key=${cacheKey})`);
    return cached;
  }

  const text = await opts.parse(buffer);
  if (opts.writeOnMiss !== false) {
    await writeCachedExtraction(cacheDir, cacheKey, text);
  }
  return text;
}

export async function inventoryExtractionCache(
  cacheDir = defaultExtractionCacheDir(),
  now = new Date(),
): Promise<ExtractionCacheInventory> {
  const entries: ExtractionCacheEntry[] = [];
  const ignoredEntries: ExtractionCacheInventory['ignored_entries'] = [];
  const errors: ExtractionCacheInventory['errors'] = [];

  let dirents: Array<import('fs').Dirent>;
  try {
    dirents = await fsp.readdir(cacheDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? null;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return emptyExtractionCacheInventory(cacheDir, now, false);
    }
    return {
      ...emptyExtractionCacheInventory(cacheDir, now, true),
      errors: [{
        path: cacheDir,
        message: (err as Error).message,
        code,
      }],
      summary: {
        entry_count: 0,
        total_bytes: 0,
        oldest_mtime: null,
        newest_mtime: null,
        ignored_entry_count: 0,
        error_count: 1,
      },
    };
  }

  for (const dirent of dirents) {
    const childPath = path.join(cacheDir, dirent.name);
    if (!EXTRACTION_CACHE_FILE_RE.test(dirent.name)) {
      ignoredEntries.push({
        filename: dirent.name,
        reason: dirent.isFile() ? 'not_cache_file' : 'not_file',
      });
      continue;
    }
    if (!dirent.isFile()) {
      ignoredEntries.push({ filename: dirent.name, reason: 'not_file' });
      continue;
    }
    try {
      entries.push(extractionCacheEntryFromStat(dirent.name, childPath, await fsp.stat(childPath)));
    } catch (err) {
      errors.push({
        path: childPath,
        message: (err as Error).message,
        code: (err as NodeJS.ErrnoException).code ?? null,
      });
    }
  }

  entries.sort(compareExtractionCacheEntries);
  return {
    schema_version: 'kb.extraction-cache.inventory.v1',
    cache_dir: cacheDir,
    generated_at: now.toISOString(),
    exists: true,
    entries,
    ignored_entries: ignoredEntries.sort((a, b) => a.filename.localeCompare(b.filename)),
    errors,
    summary: summarizeExtractionCacheInventory(entries, ignoredEntries.length, errors.length),
  };
}

export async function planExtractionCachePrune(
  options: ExtractionCachePruneOptions = {},
): Promise<ExtractionCachePrunePlan> {
  const now = options.now ?? new Date();
  const inventory = await inventoryExtractionCache(options.cacheDir, now);
  const reasonByFilename = new Map<string, Set<'age' | 'size'>>();
  const ageCutoffMs = options.maxAgeDays === undefined
    ? null
    : now.getTime() - options.maxAgeDays * 24 * 60 * 60 * 1000;

  if (ageCutoffMs !== null) {
    for (const entry of inventory.entries) {
      if (entry.mtime_ms <= ageCutoffMs) addPruneReason(reasonByFilename, entry.filename, 'age');
    }
  }

  if (options.maxSizeBytes !== undefined) {
    let keptBytes = inventory.summary.total_bytes;
    for (const entry of inventory.entries) {
      if (keptBytes <= options.maxSizeBytes) break;
      addPruneReason(reasonByFilename, entry.filename, 'size');
      keptBytes -= entry.size_bytes;
    }
  }

  const prunableEntries: ExtractionCachePruneEntry[] = [];
  const keptEntries: ExtractionCacheEntry[] = [];
  for (const entry of inventory.entries) {
    const reasons = reasonByFilename.get(entry.filename);
    if (reasons === undefined) {
      keptEntries.push(entry);
    } else {
      prunableEntries.push({
        ...entry,
        reasons: [...reasons].sort(),
      });
    }
  }

  const prunableBytes = sumEntryBytes(prunableEntries);
  return {
    schema_version: 'kb.extraction-cache.prune-plan.v1',
    dry_run: true,
    cache_dir: inventory.cache_dir,
    generated_at: now.toISOString(),
    limits: {
      max_age_days: options.maxAgeDays ?? null,
      max_size_bytes: options.maxSizeBytes ?? null,
    },
    inventory: inventory.summary,
    prunable_entries: prunableEntries,
    kept_entries: keptEntries,
    summary: {
      prunable_count: prunableEntries.length,
      prunable_bytes: prunableBytes,
      kept_count: keptEntries.length,
      kept_bytes: inventory.summary.total_bytes - prunableBytes,
      age_prunable_count: prunableEntries.filter((entry) => entry.reasons.includes('age')).length,
      size_prunable_count: prunableEntries.filter((entry) => entry.reasons.includes('size')).length,
    },
  };
}

export async function applyExtractionCachePrune(
  plan: ExtractionCachePrunePlan,
): Promise<ExtractionCachePruneApplyResult> {
  const deletedEntries: ExtractionCachePruneEntry[] = [];
  const failedEntries: ExtractionCachePruneApplyResult['failed_entries'] = [];
  for (const entry of plan.prunable_entries) {
    try {
      await fsp.unlink(entry.path);
      deletedEntries.push(entry);
    } catch (err) {
      failedEntries.push({
        filename: entry.filename,
        path: entry.path,
        message: (err as Error).message,
        code: (err as NodeJS.ErrnoException).code ?? null,
      });
    }
  }
  return {
    schema_version: 'kb.extraction-cache.prune-apply.v1',
    dry_run: false,
    cache_dir: plan.cache_dir,
    generated_at: new Date().toISOString(),
    plan,
    deleted_entries: deletedEntries,
    failed_entries: failedEntries,
    summary: {
      deleted_count: deletedEntries.length,
      deleted_bytes: sumEntryBytes(deletedEntries),
      failed_count: failedEntries.length,
    },
  };
}

function emptyExtractionCacheInventory(
  cacheDir: string,
  now: Date,
  exists: boolean,
): ExtractionCacheInventory {
  return {
    schema_version: 'kb.extraction-cache.inventory.v1',
    cache_dir: cacheDir,
    generated_at: now.toISOString(),
    exists,
    entries: [],
    ignored_entries: [],
    errors: [],
    summary: {
      entry_count: 0,
      total_bytes: 0,
      oldest_mtime: null,
      newest_mtime: null,
      ignored_entry_count: 0,
      error_count: 0,
    },
  };
}

function extractionCacheEntryFromStat(
  filename: string,
  entryPath: string,
  stat: Stats,
): ExtractionCacheEntry {
  return {
    filename,
    path: entryPath,
    size_bytes: stat.size,
    mtime: new Date(stat.mtimeMs).toISOString(),
    mtime_ms: stat.mtimeMs,
  };
}

function summarizeExtractionCacheInventory(
  entries: readonly ExtractionCacheEntry[],
  ignoredEntryCount: number,
  errorCount: number,
): ExtractionCacheInventory['summary'] {
  return {
    entry_count: entries.length,
    total_bytes: sumEntryBytes(entries),
    oldest_mtime: entries[0]?.mtime ?? null,
    newest_mtime: entries[entries.length - 1]?.mtime ?? null,
    ignored_entry_count: ignoredEntryCount,
    error_count: errorCount,
  };
}

function compareExtractionCacheEntries(
  a: ExtractionCacheEntry,
  b: ExtractionCacheEntry,
): number {
  return a.mtime_ms - b.mtime_ms || a.filename.localeCompare(b.filename);
}

function addPruneReason(
  reasonByFilename: Map<string, Set<'age' | 'size'>>,
  filename: string,
  reason: 'age' | 'size',
): void {
  const existing = reasonByFilename.get(filename);
  if (existing !== undefined) {
    existing.add(reason);
    return;
  }
  reasonByFilename.set(filename, new Set([reason]));
}

function sumEntryBytes(entries: readonly Pick<ExtractionCacheEntry, 'size_bytes'>[]): number {
  return entries.reduce((sum, entry) => sum + entry.size_bytes, 0);
}
