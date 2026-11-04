// Append-only mutation audit log for KB content writes (issue #250).
//
// Opt-in via `KB_MUTATION_AUDIT_LOG=<path>`. When set, surfaces that mutate
// KB content — `kb remember`, `kb capture`, MCP `add_document`,
// MCP `delete_document` — append one JSON line per write attempt.
//
// Best-effort: an audit write failure logs to stderr via `logger.warn` and
// never propagates to the primary mutation flow.
//
// Size-based rotation is opt-in (issue #1021). Set
// `KB_MUTATION_AUDIT_LOG_MAX_BYTES=<bytes>` to roll the log to `<path>.1`
// (shifting `.1`→`.2`, …) once it reaches the cap, retaining at most
// `KB_MUTATION_AUDIT_LOG_MAX_FILES` generations (default 5). Left unset, the
// log appends forever as before — no behavior change for existing operators.

import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { logger } from './logger.js';

export type MutationSurface =
  | 'cli.kb-remember'
  | 'cli.kb-capture'
  | 'cli.kb-ask'
  | 'mcp.add_document'
  | 'mcp.delete_document';

export type MutationOperation =
  | 'create'
  | 'append'
  | 'append-section'
  | 'capture'
  | 'ask-transcript'
  | 'add'
  | 'delete';

export type RefreshStatus = 'ok' | 'failed' | 'skipped' | null;

export interface MutationRecord {
  event: 'kb.mutation';
  surface: MutationSurface;
  operation: MutationOperation;
  kb: string;
  relative_path: string | null;
  timestamp: string;
  before_sha256: string | null;
  after_sha256: string | null;
  write_performed: boolean;
  refresh_requested: boolean;
  refresh_status: RefreshStatus;
  decision_flags: Record<string, unknown>;
  error?: string;
}

export type MutationRecordInput =
  Omit<MutationRecord, 'event' | 'timestamp'>
  & Partial<Pick<MutationRecord, 'event' | 'timestamp'>>;

/**
 * Resolve the configured audit-log path, or null when the feature is off.
 * Read on every call so tests and operators can flip the env at runtime.
 */
export function auditLogPath(): string | null {
  const raw = process.env.KB_MUTATION_AUDIT_LOG;
  if (raw === undefined || raw.trim() === '') return null;
  return raw;
}

export function auditEnabled(): boolean {
  return auditLogPath() !== null;
}

/** Default retained generations when rotation is enabled but no bound is set. */
export const DEFAULT_AUDIT_LOG_MAX_FILES = 5;

/**
 * Byte cap at which the audit log rolls to `<path>.1`, or undefined when
 * rotation is disabled (`KB_MUTATION_AUDIT_LOG_MAX_BYTES` unset, blank, or
 * non-positive). Undefined preserves the legacy append-forever behavior.
 * Read on every call so operators and tests can flip the env at runtime.
 */
export function auditLogMaxBytes(): number | undefined {
  const raw = process.env.KB_MUTATION_AUDIT_LOG_MAX_BYTES;
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

/**
 * Number of rotated generations retained (`<path>.1` … `<path>.N`). Defaults
 * to DEFAULT_AUDIT_LOG_MAX_FILES; a blank or sub-1 value falls back to the
 * default. Only consulted when rotation is enabled.
 */
export function auditLogMaxFiles(): number {
  const raw = process.env.KB_MUTATION_AUDIT_LOG_MAX_FILES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_AUDIT_LOG_MAX_FILES;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 1) return DEFAULT_AUDIT_LOG_MAX_FILES;
  return Math.floor(value);
}

/**
 * Roll `target` → `target.1`, shifting existing generations up and dropping any
 * beyond `maxFiles`. Each step is an atomic `rename`, so a crash mid-rotation
 * leaves whole files (never a half-written record) and the next append simply
 * recreates `target`. Best-effort: a rotation failure degrades to a stderr
 * warning and the caller still appends, so a stuck rename never drops records.
 *
 * Not serialized across concurrent writers: two overlapping appends that both
 * cross the cap may each roll, so a generation can briefly hold fewer than a
 * full cap of bytes. This matches the existing best-effort, cross-process
 * append semantics; the retained-generation bound still holds.
 */
async function rotateAuditLog(target: string, maxFiles: number): Promise<void> {
  try {
    await fsp.rm(`${target}.${maxFiles}`, { force: true });
    for (let i = maxFiles - 1; i >= 1; i -= 1) {
      try {
        await fsp.rename(`${target}.${i}`, `${target}.${i + 1}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    await fsp.rename(target, `${target}.1`);
  } catch (err) {
    logger.warn(`kb audit log rotation failed for ${target}: ${(err as Error).message}`);
  }
}

/**
 * Rotate `target` before the next append when it has reached the configured
 * byte cap. A no-op when rotation is disabled (so the default path pays no
 * stat), or when the file is absent/unreadable or still under the cap.
 */
async function maybeRotateAuditLog(target: string): Promise<void> {
  const maxBytes = auditLogMaxBytes();
  if (maxBytes === undefined) return;
  let currentSize: number;
  try {
    currentSize = (await fsp.stat(target)).size;
  } catch {
    return; // file is absent or unreadable – nothing to roll
  }
  if (currentSize < maxBytes) return;
  await rotateAuditLog(target, auditLogMaxFiles());
}

/**
 * Hex SHA-256 of a file's bytes, or null when the file does not exist
 * (or any I/O error reading it). Audit is observability; a hash failure
 * must not abort the surface's primary work or surface a false positive
 * "after_sha256 = X" when the read raced with a delete.
 */
export async function sha256OfFileOrNull(absPath: string): Promise<string | null> {
  try {
    const buf = await fsp.readFile(absPath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Append one `MutationRecord` JSON line to the audit log when enabled.
 *
 * Never throws. The KB_MUTATION_AUDIT_LOG file is opened with append
 * semantics; one JSON line per call is well under PIPE_BUF, so concurrent
 * appendFile calls from independent processes remain atomic at the
 * line level on POSIX. Audit write failures degrade to a stderr warning.
 */
export async function recordMutation(input: MutationRecordInput): Promise<void> {
  const target = auditLogPath();
  if (target === null) return;

  const record: MutationRecord = {
    event: input.event ?? 'kb.mutation',
    timestamp: input.timestamp ?? new Date().toISOString(),
    surface: input.surface,
    operation: input.operation,
    kb: input.kb,
    relative_path: input.relative_path,
    before_sha256: input.before_sha256,
    after_sha256: input.after_sha256,
    write_performed: input.write_performed,
    refresh_requested: input.refresh_requested,
    refresh_status: input.refresh_status,
    decision_flags: input.decision_flags,
  };
  if (input.error !== undefined) record.error = input.error;

  try {
    const parent = path.dirname(target);
    await fsp.mkdir(parent, { recursive: true });
    await maybeRotateAuditLog(target);
    await fsp.appendFile(target, `${JSON.stringify(record)}\n`, 'utf-8');
  } catch (err) {
    logger.warn(`kb audit log write failed for ${target}: ${(err as Error).message}`);
  }
}
