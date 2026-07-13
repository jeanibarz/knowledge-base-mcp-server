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

  return mutateManifest(options.kbPath, (records) => {
    const existingIndex = records.findIndex((record) => record.relative_path === relativePath);
    const existing = existingIndex === -1 ? null : records[existingIndex];
    const nextRetryCount = existing === null ? 1 : existing.retry_count + 1;
    const deadLettered = nextRetryCount >= maxRetries;
    const nextRecord: IngestQuarantineRecord = {
      schema_version: INGEST_QUARANTINE_SCHEMA_VERSION,
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
    records.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
    return nextRecord;
  });
}

export async function recordIngestSuccess(kbPath: string, relativePath: string): Promise<boolean> {
  return removeIngestQuarantineEntry(kbPath, relativePath);
}

export async function removeIngestQuarantineEntry(kbPath: string, relativePath: string): Promise<boolean> {
  const normalized = normalizeRelativePath(relativePath);
  return mutateManifest(kbPath, (records) => {
    const originalLength = records.length;
    const kept = records.filter((record) => record.relative_path !== normalized);
    records.splice(0, records.length, ...kept);
    return kept.length !== originalLength;
  });
}

export async function clearIngestQuarantine(kbPath: string): Promise<number> {
  return mutateManifest(kbPath, (records) => {
    const count = records.length;
    records.splice(0, records.length);
    return count;
  });
}

export async function forceRetryIngestQuarantineEntry(
  kbPath: string,
  relativePath: string,
  now: Date = new Date(),
): Promise<IngestQuarantineRecord | null> {
  const normalized = normalizeRelativePath(relativePath);
  return mutateManifest(kbPath, (records) => {
    const record = records.find((entry) => entry.relative_path === normalized) ?? null;
    if (record === null) return null;
    record.next_retry_at = now.toISOString();
    record.dead_lettered_at = null;
    return { ...record };
  });
}

export async function ackIngestQuarantineEntry(
  kbPath: string,
  relativePath: string,
): Promise<IngestQuarantineRecord | null> {
  const normalized = normalizeRelativePath(relativePath);
  return mutateManifest(kbPath, (records) => {
    const record = records.find((entry) => entry.relative_path === normalized) ?? null;
    if (record === null) return null;
    record.ack = true;
    record.next_retry_at = new Date(0).toISOString();
    return { ...record };
  });
}

export async function shouldRetryIngest(
  kbPath: string,
  relativePath: string,
  options: { sourceHash?: string | null; now?: Date; maxRetries?: number } = {},
): Promise<IngestRetryDecision> {
  const normalized = normalizeRelativePath(relativePath);
  const record = await findRecord(kbPath, normalized);
  if (record === null) {
    return { retry: true, reason: 'no_record', record: null };
  }
  if (
    options.sourceHash !== undefined &&
    record.source_sha256 !== null &&
    record.source_sha256 !== options.sourceHash
  ) {
    await removeIngestQuarantineEntry(kbPath, normalized);
    return { retry: true, reason: 'content_changed', record };
  }
  if (record.ack) {
    return { retry: true, reason: 'forced_ack', record };
  }
  const maxRetries = options.maxRetries ?? DEFAULT_INGEST_QUARANTINE_MAX_RETRIES;
  if (record.retry_count >= maxRetries) {
    return { retry: false, reason: 'dead_lettered', record };
  }
  const nowMs = (options.now ?? new Date()).getTime();
  if (Date.parse(record.next_retry_at) > nowMs) {
    return { retry: false, reason: 'backoff_active', record };
  }
  return { retry: true, reason: 'backoff_elapsed', record };
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
  return records.find((record) => record.relative_path === normalized) ?? null;
}

async function mutateManifest<T>(
  kbPath: string,
  mutate: (records: IngestQuarantineRecord[]) => T,
): Promise<T> {
  return withSidecarLock(async () => {
    const records = await readManifestUnlocked(kbPath);
    const result = mutate(records);
    await writeManifestUnlocked(kbPath, records);
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
    const parsed = JSON.parse(line) as Partial<IngestQuarantineRecord>;
    if (isManifestRecord(parsed)) records.push(parsed);
  }
  records.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  return records;
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
