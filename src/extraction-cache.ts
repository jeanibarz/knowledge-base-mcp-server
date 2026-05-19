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
}

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
  await writeCachedExtraction(cacheDir, cacheKey, text);
  return text;
}
