// src/metadata-sidecar.ts
//
// Issue #283 — predicate-pushdown sidecar for metadata-filtered search.
//
// Companion to the FAISS docstore: a flat per-model JSONL file that lets
// `similaritySearch` resolve the candidate id set for a high-selectivity
// metadata filter (KB / extension / path glob / tags / whitelisted
// frontmatter) BEFORE asking FAISS for a top-k. The post-filter path
// (progressive overfetch in `FaissIndexManager.similaritySearch`) is the
// correctness fallback whenever the sidecar is missing, stale, corrupt,
// or the filter is too broad to benefit.
//
// Layout
//   `${modelDir}/metadata-sidecar.jsonl`
//   Line 0  — header `{ schema_version, model_id, total_chunks }`
//   Line 1+ — one row per docstore entry, recording the metadata fields
//             the post-filter consults today: `knowledgeBase`, `source`,
//             `relativePath`, `extension`, `tags[]`, `frontmatter` (the
//             RFC 011 §5.4.2 whitelist).
//
// The sidecar is rewritten atomically (tmp + rename) at the end of every
// successful `updateIndex` save. Staleness is detected by comparing the
// header `total_chunks` against the live FAISS docstore size: a mismatch
// or any read/parse failure logs ONE canonical warning per call site and
// the caller falls through to the existing post-filter ladder.

import * as fsp from 'fs/promises';
import * as path from 'path';
import { minimatch } from 'minimatch';
import type { Document } from '@langchain/core/documents';
import { handleFsOperationError } from './error-utils.js';
import { logger } from './logger.js';
import type { SimilaritySearchFilters } from './search-filters.js';

export const METADATA_SIDECAR_FILENAME = 'metadata-sidecar.jsonl';
export const METADATA_SIDECAR_SCHEMA_VERSION = 'kb.metadata-sidecar.v1';

/** Header line written first; carries the integrity fields we rely on. */
export interface MetadataSidecarHeader {
  schema_version: typeof METADATA_SIDECAR_SCHEMA_VERSION;
  model_id: string;
  total_chunks: number;
}

/**
 * One sidecar row per docstore entry. Mirrors the metadata fields the
 * `createSimilaritySearchPostFilter` path consults — anything else (e.g.
 * `pdf_path`, the lifted `extras`) does not influence search and stays
 * out of the sidecar to keep the file small.
 */
export interface MetadataSidecarRow {
  docstoreId: string;
  knowledgeBase: string;
  source: string;
  relativePath: string;
  extension: string;
  tags: readonly string[];
  /** RFC 011 §5.4 lifted frontmatter scalars only (workspace-trusted strings). */
  frontmatter?: Readonly<Record<string, string>>;
}

/** Predicate selecting candidate docstore ids from the sidecar. */
export interface MetadataSidecarFilter {
  knowledgeBaseName?: string;
  knowledgeBasesRootDir?: string;
  extensions?: readonly string[];
  pathGlob?: string;
  tags?: readonly string[];
  /** Equality-only frontmatter predicate, evaluated against lifted scalars. */
  frontmatter?: Readonly<Record<string, string>>;
}

export interface MetadataSidecar {
  readonly modelId: string;
  readonly totalChunks: number;
  /** True when at least one filter dimension narrows the candidate set. */
  hasFilter(filter: MetadataSidecarFilter): boolean;
  /** Returns the docstore ids that match `filter` (deduplicated, no order guarantee). */
  candidateIds(filter: MetadataSidecarFilter): string[];
  /** Iterate every row — used by tests and the bench harness. */
  rows(): IterableIterator<MetadataSidecarRow>;
}

const MINIMATCH_OPTS = { dot: true, nonegate: true } as const;

class MetadataSidecarImpl implements MetadataSidecar {
  readonly modelId: string;
  readonly totalChunks: number;
  private readonly rowsById = new Map<string, MetadataSidecarRow>();
  private readonly idsByKb = new Map<string, Set<string>>();
  private readonly idsByExtension = new Map<string, Set<string>>();
  private readonly idsByTag = new Map<string, Set<string>>();

  constructor(header: MetadataSidecarHeader, rows: ReadonlyArray<MetadataSidecarRow>) {
    this.modelId = header.model_id;
    this.totalChunks = header.total_chunks;
    for (const row of rows) {
      this.rowsById.set(row.docstoreId, row);
      addToBucket(this.idsByKb, row.knowledgeBase, row.docstoreId);
      addToBucket(this.idsByExtension, row.extension.toLowerCase(), row.docstoreId);
      for (const tag of row.tags) {
        if (typeof tag === 'string' && tag.length > 0) {
          addToBucket(this.idsByTag, tag, row.docstoreId);
        }
      }
    }
  }

  hasFilter(filter: MetadataSidecarFilter): boolean {
    return (
      typeof filter.knowledgeBaseName === 'string' && filter.knowledgeBaseName.length > 0
    ) ||
      normalizeExtensions(filter.extensions) !== undefined ||
      (typeof filter.pathGlob === 'string' && filter.pathGlob.length > 0) ||
      requiredTagsOf(filter.tags).length > 0 ||
      Object.keys(filter.frontmatter ?? {}).length > 0;
  }

  candidateIds(filter: MetadataSidecarFilter): string[] {
    if (this.totalChunks === 0) return [];

    const buckets: Set<string>[] = [];
    if (typeof filter.knowledgeBaseName === 'string' && filter.knowledgeBaseName.length > 0) {
      buckets.push(this.idsByKb.get(filter.knowledgeBaseName) ?? new Set<string>());
    }
    const normalizedExtensions = normalizeExtensions(filter.extensions);
    if (normalizedExtensions !== undefined) {
      const union = new Set<string>();
      for (const ext of normalizedExtensions) {
        const bucket = this.idsByExtension.get(ext);
        if (bucket) for (const id of bucket) union.add(id);
      }
      buckets.push(union);
    }
    const requiredTags = requiredTagsOf(filter.tags);
    for (const tag of requiredTags) {
      buckets.push(this.idsByTag.get(tag) ?? new Set<string>());
    }

    const candidateIds = buckets.length === 0
      ? new Set<string>(this.rowsById.keys())
      : intersectSets(buckets);

    if (candidateIds.size === 0) return [];

    const pathGlob = typeof filter.pathGlob === 'string' && filter.pathGlob.length > 0
      ? filter.pathGlob
      : undefined;
    const frontmatter = filter.frontmatter && Object.keys(filter.frontmatter).length > 0
      ? filter.frontmatter
      : undefined;

    if (pathGlob === undefined && frontmatter === undefined) {
      return [...candidateIds];
    }

    const out: string[] = [];
    for (const id of candidateIds) {
      const row = this.rowsById.get(id);
      if (row === undefined) continue;
      if (pathGlob !== undefined && !matchesPathGlob(row.relativePath, pathGlob)) continue;
      if (frontmatter !== undefined && !rowMatchesFrontmatter(row, frontmatter)) continue;
      out.push(id);
    }
    return out;
  }

  *rows(): IterableIterator<MetadataSidecarRow> {
    yield* this.rowsById.values();
  }
}

function addToBucket(bucket: Map<string, Set<string>>, key: string, id: string): void {
  let set = bucket.get(key);
  if (!set) {
    set = new Set<string>();
    bucket.set(key, set);
  }
  set.add(id);
}

function intersectSets(buckets: ReadonlyArray<Set<string>>): Set<string> {
  if (buckets.length === 0) return new Set<string>();
  let smallestIndex = 0;
  for (let i = 1; i < buckets.length; i += 1) {
    if (buckets[i].size < buckets[smallestIndex].size) smallestIndex = i;
  }
  const out = new Set<string>();
  for (const id of buckets[smallestIndex]) {
    let inAll = true;
    for (let i = 0; i < buckets.length; i += 1) {
      if (i === smallestIndex) continue;
      if (!buckets[i].has(id)) {
        inAll = false;
        break;
      }
    }
    if (inAll) out.add(id);
  }
  return out;
}

function normalizeExtensions(raw: readonly string[] | undefined): Set<string> | undefined {
  if (!raw || raw.length === 0) return undefined;
  const out = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim().toLowerCase();
    if (trimmed.length === 0) continue;
    out.add(trimmed.startsWith('.') ? trimmed : `.${trimmed}`);
  }
  return out.size > 0 ? out : undefined;
}

function requiredTagsOf(raw: readonly string[] | undefined): string[] {
  if (!raw) return [];
  return raw.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
}

function matchesPathGlob(relativePath: string, pattern: string): boolean {
  if (minimatch(relativePath, pattern, MINIMATCH_OPTS)) return true;
  const firstSep = relativePath.indexOf('/');
  if (firstSep > 0) {
    const inKb = relativePath.slice(firstSep + 1);
    if (minimatch(inKb, pattern, MINIMATCH_OPTS)) return true;
  }
  return false;
}

function rowMatchesFrontmatter(
  row: MetadataSidecarRow,
  required: Readonly<Record<string, string>>,
): boolean {
  if (!row.frontmatter) return false;
  for (const [key, expected] of Object.entries(required)) {
    if (typeof expected !== 'string' || expected.length === 0) continue;
    if (row.frontmatter[key] !== expected) return false;
  }
  return true;
}

/**
 * Translate a `Document.metadata` record into a sidecar row.
 *
 * Returns null when the metadata is missing the fields the sidecar relies
 * on (`knowledgeBase`, `source`, `extension`, `relativePath`) — those rows
 * stay out of the sidecar instead of being indexed under empty buckets and
 * silently masking valid documents at query time.
 */
export function buildSidecarRowFromDocument(
  docstoreId: string,
  document: Document,
): MetadataSidecarRow | null {
  const metadata = document.metadata as Record<string, unknown> | undefined;
  if (!metadata) return null;

  const knowledgeBase = stringOrNull(metadata.knowledgeBase);
  const source = stringOrNull(metadata.source);
  const relativePath = stringOrNull(metadata.relativePath);
  const extension = stringOrNull(metadata.extension);
  if (knowledgeBase === null || source === null || relativePath === null || extension === null) {
    return null;
  }

  return {
    docstoreId,
    knowledgeBase,
    source,
    relativePath,
    extension: extension.toLowerCase(),
    tags: extractStringArray(metadata.tags),
    frontmatter: extractFrontmatterScalars(metadata.frontmatter),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) out.push(entry);
  }
  return out;
}

function extractFrontmatterScalars(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'extras') continue;
    if (typeof entry === 'string' && entry.length > 0) {
      out[key] = entry;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Atomic JSONL write: header line followed by one row per line. Caller
 * holds the per-model write lock (and ideally the cross-model sidecar
 * lock for symmetry with `writeSidecarHashes`); this helper does not
 * lock on its own.
 */
export async function writeMetadataSidecar(opts: {
  sidecarPath: string;
  modelId: string;
  rows: ReadonlyArray<MetadataSidecarRow>;
}): Promise<void> {
  const { sidecarPath, modelId, rows } = opts;
  const header: MetadataSidecarHeader = {
    schema_version: METADATA_SIDECAR_SCHEMA_VERSION,
    model_id: modelId,
    total_chunks: rows.length,
  };

  const tmpPath = `${sidecarPath}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  const lines: string[] = [JSON.stringify(header)];
  for (const row of rows) {
    lines.push(JSON.stringify(row));
  }
  const payload = `${lines.join('\n')}\n`;

  try {
    await fsp.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fsp.writeFile(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 });
    await fsp.rename(tmpPath, sidecarPath);
  } catch (err) {
    try {
      await fsp.unlink(tmpPath);
    } catch {
      // best-effort cleanup; original error is what matters
    }
    handleFsOperationError('write metadata sidecar to', sidecarPath, err);
  }
}

/**
 * Best-effort sidecar removal — used by the few places that rebuild the
 * docstore from scratch. Missing file is success.
 */
export async function deleteMetadataSidecar(sidecarPath: string): Promise<void> {
  try {
    await fsp.unlink(sidecarPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    logger.warn(
      `Could not remove metadata sidecar ${sidecarPath}: ${(err as Error).message}`,
    );
  }
}

/**
 * Read the sidecar at `sidecarPath`, validate the header, and return a
 * `MetadataSidecar` ready for `candidateIds()`. Returns null on:
 *
 *   - missing file (ENOENT/ENOTDIR) — first-run indexers, sidecar yet to
 *     be written, or operator-removed.
 *   - header schema/model mismatch — the docstore was written by a
 *     different model or an older schema; fast-path would be wrong.
 *   - parse error or truncated row — we surface a single canonical warn
 *     so operators see ONE log per failure regardless of how many queries
 *     hit the missing/corrupt sidecar in the same process.
 *
 * Stale-by-count (header `total_chunks` ≠ live ntotal) is checked by the
 * caller via `isSidecarStale`, since the live count comes from FAISS.
 */
export async function readMetadataSidecar(opts: {
  sidecarPath: string;
  modelId: string;
}): Promise<MetadataSidecar | null> {
  const { sidecarPath, modelId } = opts;
  let raw: string;
  try {
    raw = await fsp.readFile(sidecarPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    logger.warn(
      `Issue #283 metadata sidecar: could not read ${sidecarPath}: ${(err as Error).message}. ` +
        `Falling back to post-filter overfetch.`,
    );
    return null;
  }

  const lines = raw.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) {
    logger.warn(
      `Issue #283 metadata sidecar at ${sidecarPath} is empty; falling back to post-filter overfetch.`,
    );
    return null;
  }

  let header: MetadataSidecarHeader | null = null;
  try {
    header = parseHeader(JSON.parse(lines[0]));
  } catch {
    header = null;
  }
  if (header === null) {
    logger.warn(
      `Issue #283 metadata sidecar header at ${sidecarPath} is malformed; falling back to post-filter overfetch.`,
    );
    return null;
  }
  if (header.model_id !== modelId) {
    logger.warn(
      `Issue #283 metadata sidecar at ${sidecarPath} was written for model ${header.model_id}, ` +
        `not ${modelId}; falling back to post-filter overfetch.`,
    );
    return null;
  }

  const rows: MetadataSidecarRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      logger.warn(
        `Issue #283 metadata sidecar at ${sidecarPath} has malformed row ${i}; ` +
          `falling back to post-filter overfetch.`,
      );
      return null;
    }
    const row = parseRow(parsed);
    if (row === null) {
      logger.warn(
        `Issue #283 metadata sidecar at ${sidecarPath} has invalid row ${i}; ` +
          `falling back to post-filter overfetch.`,
      );
      return null;
    }
    rows.push(row);
  }

  if (rows.length !== header.total_chunks) {
    logger.warn(
      `Issue #283 metadata sidecar at ${sidecarPath} has ${rows.length} rows but header claims ` +
        `${header.total_chunks}; falling back to post-filter overfetch.`,
    );
    return null;
  }

  return new MetadataSidecarImpl(header, rows);
}

/**
 * `total_chunks` must match the live FAISS docstore size, otherwise the
 * sidecar predates the most recent ingest and could omit (or include)
 * chunks that have since been removed (or added). The caller logs ONE
 * canonical warning and falls through.
 */
export function isSidecarStale(sidecar: MetadataSidecar, ntotal: number): boolean {
  return sidecar.totalChunks !== ntotal;
}

function parseHeader(value: unknown): MetadataSidecarHeader | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.schema_version !== METADATA_SIDECAR_SCHEMA_VERSION) return null;
  if (typeof candidate.model_id !== 'string' || candidate.model_id.length === 0) return null;
  if (typeof candidate.total_chunks !== 'number' || !Number.isFinite(candidate.total_chunks)) {
    return null;
  }
  if (candidate.total_chunks < 0 || !Number.isSafeInteger(candidate.total_chunks)) return null;
  return {
    schema_version: METADATA_SIDECAR_SCHEMA_VERSION,
    model_id: candidate.model_id,
    total_chunks: candidate.total_chunks,
  };
}

function parseRow(value: unknown): MetadataSidecarRow | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const docstoreId = candidate.docstoreId;
  const knowledgeBase = candidate.knowledgeBase;
  const source = candidate.source;
  const relativePath = candidate.relativePath;
  const extension = candidate.extension;
  if (typeof docstoreId !== 'string' || docstoreId.length === 0) return null;
  if (typeof knowledgeBase !== 'string' || knowledgeBase.length === 0) return null;
  if (typeof source !== 'string' || source.length === 0) return null;
  if (typeof relativePath !== 'string' || relativePath.length === 0) return null;
  if (typeof extension !== 'string' || extension.length === 0) return null;

  const tags: string[] = [];
  if (Array.isArray(candidate.tags)) {
    for (const entry of candidate.tags) {
      if (typeof entry === 'string' && entry.length > 0) tags.push(entry);
    }
  }

  let frontmatter: Record<string, string> | undefined;
  if (
    typeof candidate.frontmatter === 'object' &&
    candidate.frontmatter !== null &&
    !Array.isArray(candidate.frontmatter)
  ) {
    const collected: Record<string, string> = {};
    for (const [key, entry] of Object.entries(candidate.frontmatter as Record<string, unknown>)) {
      if (typeof entry === 'string' && entry.length > 0) collected[key] = entry;
    }
    if (Object.keys(collected).length > 0) frontmatter = collected;
  }

  return {
    docstoreId,
    knowledgeBase,
    source,
    relativePath,
    extension: extension.toLowerCase(),
    tags,
    frontmatter,
  };
}

/**
 * Translate the `SimilaritySearchFilters` shape (post-filter input) plus
 * KB scope into the pure-data `MetadataSidecarFilter`. Helper kept here
 * so callers don't reimplement the field-name bridge.
 */
export function toSidecarFilter(opts: {
  knowledgeBaseName?: string;
  knowledgeBasesRootDir: string;
  filters?: SimilaritySearchFilters;
  frontmatter?: Readonly<Record<string, string>>;
}): MetadataSidecarFilter {
  return {
    knowledgeBaseName: opts.knowledgeBaseName,
    knowledgeBasesRootDir: opts.knowledgeBasesRootDir,
    extensions: opts.filters?.extensions,
    pathGlob: opts.filters?.pathGlob,
    tags: opts.filters?.tags,
    frontmatter: opts.frontmatter,
  };
}

/**
 * Pick the FAISS `fetchK` for a sidecar-narrowed query. We know:
 *   - `k`:           how many filtered hits the caller wants.
 *   - `candidates`:  how many docs satisfy the metadata filter.
 *   - `ntotal`:      total vectors in the docstore.
 *
 * If candidates ≥ ntotal/2 the filter is too broad for the fast-path to
 * help; the caller stays on the existing ladder. Otherwise we estimate
 * the FAISS window needed to surface `k` filtered hits at the candidate
 * selectivity, with a 2× safety multiplier and a hard cap at `ntotal`.
 *
 * Returns null when the fast-path doesn't apply (broad filter, empty
 * candidate set is the caller's concern — it should short-circuit before
 * calling this).
 */
export function recommendFastPathFetchK(opts: {
  k: number;
  candidates: number;
  ntotal: number;
}): number | null {
  const { k, candidates, ntotal } = opts;
  if (ntotal <= 0 || candidates <= 0 || k <= 0) return null;
  // Fast-path is only worth it when the filter is selective enough that
  // the targeted fetchK is meaningfully smaller than ntotal.
  const SELECTIVITY_CEILING = 0.5;
  if (candidates / ntotal >= SELECTIVITY_CEILING) return null;

  const selectivity = candidates / ntotal;
  const targeted = Math.ceil((k / Math.max(selectivity, Number.EPSILON)) * 2);
  const minimumWindow = Math.max(k * 4, 20);
  const fetchK = Math.max(minimumWindow, targeted);
  return Math.min(ntotal, fetchK);
}
