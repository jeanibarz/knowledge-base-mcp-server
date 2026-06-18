import { initializeProjectConfig } from './project-config.js';

initializeProjectConfig();

function parseCommaSeparatedList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseOnOff(raw: string | undefined): boolean {
  const normalized = raw?.trim().toLowerCase();
  return normalized === 'on' || normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function parseDefaultOn(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return true;
  return parseOnOff(raw);
}

// ---------------------------------------------------------------------------
// Ingest filter configuration (RFC 011 section5.2.3).
// Operator-extensible extras; the base allowlist and exclusion rules in
// `src/ingest-filter.ts` are authoritative and cannot be removed through env.
// ---------------------------------------------------------------------------

export const INGEST_EXTRA_EXTENSIONS: readonly string[] = parseCommaSeparatedList(
  process.env.INGEST_EXTRA_EXTENSIONS,
);

export const INGEST_EXCLUDE_PATHS: readonly string[] = parseCommaSeparatedList(
  process.env.INGEST_EXCLUDE_PATHS,
);

export const KB_INGEST_ENABLED: boolean = parseDefaultOn(process.env.KB_INGEST_ENABLED);

// ---------------------------------------------------------------------------
// Large-file ingest bounds (#285).
// ---------------------------------------------------------------------------

const DEFAULT_KB_MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_KB_MAX_EXTRACTED_TEXT_BYTES = 16 * 1024 * 1024;

export type KBLargeFilePolicy = 'skip' | 'truncate' | 'error';

function parsePositiveByteLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function parseKbMaxFileBytes(raw: string | undefined): number {
  return parsePositiveByteLimit(raw, DEFAULT_KB_MAX_FILE_BYTES);
}

export function parseKbMaxExtractedTextBytes(raw: string | undefined): number {
  return parsePositiveByteLimit(raw, DEFAULT_KB_MAX_EXTRACTED_TEXT_BYTES);
}

export function parseKbLargeFilePolicy(raw: string | undefined): KBLargeFilePolicy {
  if (raw === undefined || raw.trim() === '') return 'skip';
  const value = raw.trim().toLowerCase();
  if (value === 'skip' || value === 'truncate' || value === 'error') {
    return value;
  }
  throw new Error(`invalid KB_LARGE_FILE_POLICY=${JSON.stringify(raw)} (expected skip, truncate, or error)`);
}

export function resolveLargeFileLimits(): {
  maxFileBytes: number;
  maxExtractedTextBytes: number;
  policy: KBLargeFilePolicy;
} {
  return {
    maxFileBytes: parseKbMaxFileBytes(process.env.KB_MAX_FILE_BYTES),
    maxExtractedTextBytes: parseKbMaxExtractedTextBytes(process.env.KB_MAX_EXTRACTED_TEXT_BYTES),
    policy: parseKbLargeFilePolicy(process.env.KB_LARGE_FILE_POLICY),
  };
}

// ---------------------------------------------------------------------------
// Refresh quiescence guard (#428).
// ---------------------------------------------------------------------------

export function parseRefreshQuiesceMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

export function resolveRefreshQuiesceMs(): number {
  return parseRefreshQuiesceMs(process.env.KB_REFRESH_QUIESCE_MS);
}

// ---------------------------------------------------------------------------
// Ingest secret scan (#472).
// ---------------------------------------------------------------------------

export interface IngestSecretScanOptions {
  enabled: boolean;
  bypassKnowledgeBases: string[];
}

export function resolveIngestSecretScanOptions(
  env: NodeJS.ProcessEnv = process.env,
): IngestSecretScanOptions {
  return {
    enabled: parseOnOff(env.KB_INGEST_SECRET_SCAN),
    bypassKnowledgeBases: parseCommaSeparatedList(env.KB_SECRET_SCAN_BYPASS_KBS),
  };
}
