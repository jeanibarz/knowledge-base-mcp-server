// Append-only mutation audit log for KB content writes (issue #250).
//
// Opt-in via `KB_MUTATION_AUDIT_LOG=<path>`. When set, surfaces that mutate
// KB content — `kb remember`, `kb capture`, MCP `add_document`,
// MCP `delete_document` — append one JSON line per write attempt.
//
// Best-effort: an audit write failure logs to stderr via `logger.warn` and
// never propagates to the primary mutation flow.

import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { logger } from './logger.js';

export type MutationSurface =
  | 'cli.kb-remember'
  | 'cli.kb-capture'
  | 'mcp.add_document'
  | 'mcp.delete_document';

export type MutationOperation =
  | 'create'
  | 'append'
  | 'append-section'
  | 'capture'
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
    await fsp.appendFile(target, `${JSON.stringify(record)}\n`, 'utf-8');
  } catch (err) {
    logger.warn(`kb audit log write failed for ${target}: ${(err as Error).message}`);
  }
}
