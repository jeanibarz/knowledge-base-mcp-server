import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { classifyKbSearchError, type SearchFailureCategory } from './search-errors-core.js';
import { toError } from './error-utils.js';
import { assertNoTraversal } from './kb-fs.js';
import { IngestSecretDetectedError } from './secret-scanner.js';
import { withSidecarLock } from './write-lock.js';

export const INGEST_QUARANTINE_SCHEMA_VERSION = 'ingest-quarantine.v1';
export const INGEST_QUARANTINE_FILENAME = 'quarantine.jsonl';
export const DEFAULT_INGEST_QUARANTINE_MAX_RETRIES = 5;
export const DEFAULT_INGEST_QUARANTINE_MAX_ENTRIES = 1000;

const BASE_RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60_000;

export type IngestQuarantineCategory = SearchFailureCategory | 'secret_detected';

export interface IngestQuarantineRecord {
  schema_version: typeof INGEST_QUARANTINE_SCHEMA_VERSION;
  /**
   * Set only on model-scoped records: a `provider` failure, or any failure
   * raised while embedding or inserting with this model (`models/<model_id>/`,
   * #1261). Absent means KB-wide, which is every pre-#1258 record and every
   * content-level failure.
   */
  model_id?: string;
  reason?: string;
  relative_path: string;
  source_sha256: string | null;
  error_category: IngestQuarantineCategory;
  error_code: string;
  error_fingerprint: string;
  first_seen_at: string;
  last_attempted_at: string;
  retry_count: number;
  next_retry_at: string;
  ack: boolean;
  dead_lettered_at: string | null;
  message: string;
}

export interface RecordIngestFailureOptions {
  kbPath: string;
  relativePath: string;
  error: unknown;
  sourceHash?: string | null;
  now?: Date;
  maxRetries?: number;
  maxEntries?: number;
  /** Embedding model being indexed. A `provider` failure is scoped to it; other failures stay KB-wide. */
  modelId?: string;
  /**
   * The failure came from the model's embedding/insert stage, after the file
   * was loaded, chunked and secret-scanned (#1261). Scope it to `modelId`
   * whatever its category: a 413 batch-size or context-length VALIDATION, or a
   * raw SDK error, depends on the model or its server, not on the document.
   */
  modelScoped?: boolean;
}

export interface IngestRetryDecision {
  retry: boolean;
  reason: 'no_record' | 'content_changed' | 'backoff_elapsed' | 'forced_ack' | 'backoff_active' | 'dead_lettered';
  record: IngestQuarantineRecord | null;
}

export interface ListIngestQuarantineOptions {
  /** Avoid creating the global sidecar lock directory for read-only callers. */
  useLock?: boolean;
}

/**
 * Per-refresh, in-memory view of each KB's quarantine manifest. An index
 * refresh asks "may this file be retried?" and "clear any record" for every
 * file; answering each from the on-disk manifest costs one cross-process lock
 * plus a read per file. The snapshot loads each KB's manifest once (lazily) and
 * answers those per-file questions from memory. The refresh keeps it current by
 * calling `set` / `delete` when it writes failures or clears records itself, so
 * a failure recorded earlier in the same run is still honoured later in it. A
 * change made by another process mid-run (`kb quarantine retry|ack`) is seen on
 * the next refresh.
 */
export class IngestQuarantineSnapshot {
  private readonly byKb = new Map<string, Promise<Map<string, IngestQuarantineRecord>>>();

  private load(kbPath: string): Promise<Map<string, IngestQuarantineRecord>> {
    let loaded = this.byKb.get(kbPath);
    if (loaded === undefined) {
      loaded = readManifest(kbPath).then(
        (records) => new Map(records.map((record) => [recordKey(record.model_id, record.relative_path), record])),
      );
      // Do not cache a failed read: let the next caller retry it.
      loaded.catch(() => this.byKb.delete(kbPath));
      this.byKb.set(kbPath, loaded);
    }
    return loaded;
  }

  /** Without `modelId`, returns the KB-wide record for the path. */
  async get(kbPath: string, relativePath: string, modelId?: string): Promise<IngestQuarantineRecord | null> {
    return (await this.load(kbPath)).get(recordKey(modelId, normalizeRelativePath(relativePath))) ?? null;
  }

  async set(kbPath: string, record: IngestQuarantineRecord): Promise<void> {
    (await this.load(kbPath)).set(recordKey(record.model_id, record.relative_path), record);
  }

  /** Without `modelId`, deletes the KB-wide record for the path. */
  async delete(kbPath: string, relativePath: string, modelId?: string): Promise<void> {
    (await this.load(kbPath)).delete(recordKey(modelId, normalizeRelativePath(relativePath)));
  }

  /** Deletes every record (KB-wide and all models) for the path. */
  async deleteAllForPath(kbPath: string, relativePath: string): Promise<void> {
    const normalized = normalizeRelativePath(relativePath);
    const map = await this.load(kbPath);
    for (const [key, record] of map) {
      if (record.relative_path === normalized) map.delete(key);
    }
  }
}

export function quarantineManifestPath(kbPath: string): string {
  return path.join(kbPath, '.index', INGEST_QUARANTINE_FILENAME);
}

export async function listIngestQuarantine(
  kbPath: string,
  options: ListIngestQuarantineOptions = {},
): Promise<IngestQuarantineRecord[]> {
  return options.useLock === false ? readManifestUnlocked(kbPath) : readManifest(kbPath);
}

export async function getIngestQuarantineRecord(
  kbPath: string,
  relativePath: string,
): Promise<IngestQuarantineRecord | null> {
  return findRecord(kbPath, relativePath);
}

export async function countIngestQuarantine(kbPath: string): Promise<number> {
  return (await readManifest(kbPath)).length;
}

export async function recordIngestFailure(options: RecordIngestFailureOptions): Promise<IngestQuarantineRecord> {
  const now = options.now ?? new Date();
  const isoNow = now.toISOString();
  const maxRetries = options.maxRetries ?? DEFAULT_INGEST_QUARANTINE_MAX_RETRIES;
  const maxEntries = options.maxEntries ?? DEFAULT_INGEST_QUARANTINE_MAX_ENTRIES;
  const relativePath = normalizeRelativePath(options.relativePath);
  const classified = classifyIngestError(options.error);
  const fingerprint = errorFingerprint(classified.category, classified.code, classified.message);
  // Provider failures and failures of the model's own embed/insert stage are a
  // property of one model; everything else (secret, parse, load, ...) is a
  // property of the file.
  const scopedModelId = classified.category === 'provider' || options.modelScoped === true
    ? options.modelId
    : undefined;

  return mutateManifest(options.kbPath, (records) => {
    const existingIndex = records.findIndex(
      (record) => record.relative_path === relativePath && record.model_id === scopedModelId,
    );
    const existing = existingIndex === -1 ? null : records[existingIndex];
    const nextRetryCount = existing === null ? 1 : existing.retry_count + 1;
    const deadLettered = nextRetryCount >= maxRetries;
    const nextRecord: IngestQuarantineRecord = {
      schema_version: INGEST_QUARANTINE_SCHEMA_VERSION,
      ...(scopedModelId !== undefined ? { model_id: scopedModelId } : {}),
      ...(classified.reason !== undefined ? { reason: classified.reason } : {}),
      relative_path: relativePath,
      source_sha256: options.sourceHash ?? existing?.source_sha256 ?? null,
      error_category: classified.category,
      error_code: classified.code,
      error_fingerprint: fingerprint,
      first_seen_at: existing?.first_seen_at ?? isoNow,
      last_attempted_at: isoNow,
      retry_count: nextRetryCount,
      next_retry_at: new Date(now.getTime() + retryDelayMs(nextRetryCount)).toISOString(),
      ack: false,
      dead_lettered_at: deadLettered ? (existing?.dead_lettered_at ?? isoNow) : null,
      message: classified.message,
    };

    if (existingIndex === -1) records.push(nextRecord);
    else records[existingIndex] = nextRecord;

    records.sort((a, b) => a.last_attempted_at.localeCompare(b.last_attempted_at));
    while (records.length > maxEntries) records.shift();
    sortRecords(records);
    return nextRecord;
  });
}

export async function recordIngestSuccess(
  kbPath: string,
  relativePath: string,
  options: { snapshot?: IngestQuarantineSnapshot; modelId?: string } = {},
): Promise<boolean> {
  const { snapshot, modelId } = options;
  const normalized = normalizeRelativePath(relativePath);
  // With a snapshot, a path that has no applicable record needs no lock and no I/O.
  if (
    snapshot !== undefined &&
    (await snapshot.get(kbPath, normalized)) === null &&
    (modelId === undefined || (await snapshot.get(kbPath, normalized, modelId)) === null)
  ) {
    return false;
  }
  // Success under a model clears that model's record and the KB-wide one;
  // other models' provider records describe other endpoints and stay.
  const removed = await mutateManifest(kbPath, (records) =>
    removeWhere(
      records,
      (record) =>
        record.relative_path === normalized &&
        (record.model_id === undefined || record.model_id === modelId),
    ) > 0,
  );
  await snapshot?.delete(kbPath, normalized);
  if (modelId !== undefined) await snapshot?.delete(kbPath, normalized, modelId);
  return removed;
}

/** Without `modelId`, removes every record (KB-wide and all models) for the path. */
export async function removeIngestQuarantineEntry(
  kbPath: string,
  relativePath: string,
  modelId?: string,
): Promise<boolean> {
  const normalized = normalizeRelativePath(relativePath);
  return mutateManifest(kbPath, (records) =>
    removeWhere(records, (record) => matchesEntry(record, normalized, modelId)) > 0,
  );
}

/** Removes every record scoped to `modelId` (used when the model is removed). */
export async function removeIngestQuarantineForModel(kbPath: string, modelId: string): Promise<number> {
  return mutateManifest(kbPath, (records) => removeWhere(records, (record) => record.model_id === modelId));
}

export async function clearIngestQuarantine(kbPath: string): Promise<number> {
  return mutateManifest(kbPath, (records) => {
    const count = records.length;
    records.splice(0, records.length);
    return count;
  });
}

/** Without `modelId`, acts on every record for the path and returns the first one. */
export async function forceRetryIngestQuarantineEntry(
  kbPath: string,
  relativePath: string,
  now: Date = new Date(),
  modelId?: string,
): Promise<IngestQuarantineRecord | null> {
  const normalized = normalizeRelativePath(relativePath);
  return mutateManifest(kbPath, (records) => {
    const matched = records.filter((entry) => matchesEntry(entry, normalized, modelId));
    for (const record of matched) {
      record.next_retry_at = now.toISOString();
      record.dead_lettered_at = null;
    }
    return matched[0] === undefined ? null : { ...matched[0] };
  });
}

/** Without `modelId`, acts on every record for the path and returns the first one. */
export async function ackIngestQuarantineEntry(
  kbPath: string,
  relativePath: string,
  modelId?: string,
): Promise<IngestQuarantineRecord | null> {
  const normalized = normalizeRelativePath(relativePath);
  return mutateManifest(kbPath, (records) => {
    const matched = records.filter((entry) => matchesEntry(entry, normalized, modelId));
    for (const record of matched) {
      record.ack = true;
      record.next_retry_at = new Date(0).toISOString();
    }
    return matched[0] === undefined ? null : { ...matched[0] };
  });
}

export async function shouldRetryIngest(
  kbPath: string,
  relativePath: string,
  options: {
    sourceHash?: string | null;
    now?: Date;
    maxRetries?: number;
    /** Answer from a per-refresh manifest snapshot instead of locking and re-reading per call. */
    snapshot?: IngestQuarantineSnapshot;
    /** Model about to index the file. Adds that model's record; other models' records never apply. */
    modelId?: string;
  } = {},
): Promise<IngestRetryDecision> {
  const normalized = normalizeRelativePath(relativePath);
  const { modelId, snapshot } = options;
  const applicable: IngestQuarantineRecord[] = [];
  if (snapshot) {
    const kbWide = await snapshot.get(kbPath, normalized);
    const scoped = modelId === undefined ? null : await snapshot.get(kbPath, normalized, modelId);
    for (const record of [kbWide, scoped]) if (record !== null) applicable.push(record);
  } else {
    for (const record of await readManifest(kbPath)) {
      if (record.relative_path === normalized) applicable.push(record);
    }
  }
  const relevant = applicable.filter((record) =>
    record.model_id === undefined
      // Legacy (#1258) KB-wide provider records are stale for a model-aware caller.
      ? !(modelId !== undefined && record.error_category === 'provider')
      : record.model_id === modelId,
  );
  if (relevant.length === 0) {
    return { retry: true, reason: 'no_record', record: null };
  }
  const maxRetries = options.maxRetries ?? DEFAULT_INGEST_QUARANTINE_MAX_RETRIES;
  const nowMs = (options.now ?? new Date()).getTime();
  let allowed: IngestRetryDecision | null = null;
  for (const record of relevant) {
    if (
      options.sourceHash !== undefined &&
      record.source_sha256 !== null &&
      record.source_sha256 !== options.sourceHash
    ) {
      // The content changed for everyone: drop every model's record too.
      await removeIngestQuarantineEntry(kbPath, normalized);
      await snapshot?.deleteAllForPath(kbPath, normalized);
      return { retry: true, reason: 'content_changed', record };
    }
    if (record.ack) {
      allowed ??= { retry: true, reason: 'forced_ack', record };
      continue;
    }
    if (record.retry_count >= maxRetries) {
      return { retry: false, reason: 'dead_lettered', record };
    }
    if (Date.parse(record.next_retry_at) > nowMs) {
      return { retry: false, reason: 'backoff_active', record };
    }
    allowed ??= { retry: true, reason: 'backoff_elapsed', record };
  }
  return allowed ?? { retry: true, reason: 'no_record', record: null };
}

function retryDelayMs(retryCount: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, (2 ** retryCount) * BASE_RETRY_DELAY_MS);
}

function errorFingerprint(category: IngestQuarantineCategory, code: string, message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0] ?? '';
  const hash = crypto
    .createHash('sha256')
    .update(`${category}\0${code}\0${firstLine}`)
    .digest('hex');
  return `sha256:${hash}`;
}

function classifyIngestError(error: unknown): {
  category: IngestQuarantineCategory;
  code: string;
  message: string;
  reason?: string;
} {
  if (error instanceof IngestSecretDetectedError) {
    return {
      category: 'secret_detected',
      code: error.code,
      message: error.message,
      reason: 'secret_detected',
    };
  }
  const classified = classifyKbSearchError(error);
  const fsCode = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof fsCode === 'string' && fsCode.length > 0) {
    return {
      category: categoryForErrorCode(fsCode, classified.category),
      code: fsCode,
      message: toError(error).message,
    };
  }
  return {
    category: classified.category,
    code: classified.code,
    message: classified.message,
  };
}

function categoryForErrorCode(
  code: string,
  fallback: IngestQuarantineCategory,
): IngestQuarantineCategory {
  if (code === 'EACCES' || code === 'EPERM') return 'permissions';
  if (
    code === 'EINVAL' ||
    code === 'ENOENT' ||
    code === 'EISDIR' ||
    code.startsWith('KB_LARGE_FILE_')
  ) {
    return 'input';
  }
  return fallback;
}

async function findRecord(kbPath: string, relativePath: string): Promise<IngestQuarantineRecord | null> {
  const normalized = normalizeRelativePath(relativePath);
  const records = await readManifest(kbPath);
  return records.find((record) => record.relative_path === normalized && record.model_id === undefined) ?? null;
}

function recordKey(modelId: string | undefined, relativePath: string): string {
  return `${modelId ?? ''}\0${relativePath}`;
}

function sortRecords(records: IngestQuarantineRecord[]): void {
  records.sort(
    (a, b) =>
      a.relative_path.localeCompare(b.relative_path) || (a.model_id ?? '').localeCompare(b.model_id ?? ''),
  );
}

/** With `modelId`, only that model's record for the path; without, every record for the path. */
function matchesEntry(record: IngestQuarantineRecord, relativePath: string, modelId: string | undefined): boolean {
  return record.relative_path === relativePath && (modelId === undefined || record.model_id === modelId);
}

function removeWhere(
  records: IngestQuarantineRecord[],
  predicate: (record: IngestQuarantineRecord) => boolean,
): number {
  const kept = records.filter((record) => !predicate(record));
  const removed = records.length - kept.length;
  records.splice(0, records.length, ...kept);
  return removed;
}

async function mutateManifest<T>(
  kbPath: string,
  mutate: (records: IngestQuarantineRecord[]) => T,
): Promise<T> {
  return withSidecarLock(async () => {
    const records = await readManifestUnlocked(kbPath);
    const before = serializeRecords(records);
    const result = mutate(records);
    // A mutation that changed nothing (clearing a path with no record, an
    // empty-manifest delete) must not rewrite or delete the manifest file.
    if (serializeRecords(records) !== before) await writeManifestUnlocked(kbPath, records);
    return result;
  });
}

async function readManifest(kbPath: string): Promise<IngestQuarantineRecord[]> {
  return withSidecarLock(() => readManifestUnlocked(kbPath));
}

async function readManifestUnlocked(kbPath: string): Promise<IngestQuarantineRecord[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(quarantineManifestPath(kbPath), 'utf-8');
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
  const records: IngestQuarantineRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let parsed: Partial<IngestQuarantineRecord>;
    try {
      parsed = JSON.parse(line) as Partial<IngestQuarantineRecord>;
    } catch {
      // A non-parseable line is almost always a torn write (crash mid-append)
      // or other byte-level corruption. Skip rather than aborting the whole
      // quarantine read — shouldRetryIngest consults this on the ingest hot
      // path, so a single bad line used to brick reindex of the entire KB.
      // Well-formed-but-schema-invalid lines still fall through to
      // isManifestRecord below and are filtered without throwing.
      continue;
    }
    if (isManifestRecord(parsed)) records.push(parsed);
  }
  sortRecords(records);
  return records;
}

function serializeRecords(records: IngestQuarantineRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n');
}

async function writeManifestUnlocked(kbPath: string, records: IngestQuarantineRecord[]): Promise<void> {
  const manifestPath = quarantineManifestPath(kbPath);
  if (records.length === 0) {
    await fsp.rm(manifestPath, { force: true });
    return;
  }
  await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
  const tmpPath = `${manifestPath}.${process.pid}.tmp`;
  const body = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  await fsp.writeFile(tmpPath, body, 'utf-8');
  await fsp.rename(tmpPath, manifestPath);
}

function isManifestRecord(value: Partial<IngestQuarantineRecord>): value is IngestQuarantineRecord {
  return (
    value.schema_version === INGEST_QUARANTINE_SCHEMA_VERSION &&
    typeof value.relative_path === 'string' &&
    (value.model_id === undefined || (typeof value.model_id === 'string' && value.model_id.length > 0)) &&
    (typeof value.source_sha256 === 'string' || value.source_sha256 === null) &&
    typeof value.error_category === 'string' &&
    typeof value.error_code === 'string' &&
    typeof value.error_fingerprint === 'string' &&
    typeof value.first_seen_at === 'string' &&
    typeof value.last_attempted_at === 'string' &&
    typeof value.retry_count === 'number' &&
    typeof value.next_retry_at === 'string' &&
    typeof value.ack === 'boolean' &&
    (typeof value.dead_lettered_at === 'string' || value.dead_lettered_at === null) &&
    typeof value.message === 'string'
  );
}

function normalizeRelativePath(relativePath: string): string {
  if (relativePath.length === 0 || relativePath.includes('\0')) {
    throw new Error(`invalid quarantine relative path: ${JSON.stringify(relativePath)}`);
  }
  assertNoTraversal(relativePath);
  // A backslash is a valid filename character on POSIX. Only translate it
  // when it is the host platform's path separator, as on Windows.
  return path.sep === '\\' ? relativePath.replace(/\\/g, '/') : relativePath;
}
