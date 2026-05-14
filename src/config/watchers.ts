import * as path from 'path';
import { KNOWLEDGE_BASES_ROOT_DIR } from './paths.js';

// ---------------------------------------------------------------------------
// Reindex-trigger watcher (RFC 011 section5.5).
// External workflows (e.g. the arxiv-ingestion n8n flow) signal the server
// that new content has landed by `touch`ing a dotfile at the KB root. The
// watcher polls its mtime, so a running MCP server picks up writes without
// an explicit `refresh_knowledge_base` call.
// ---------------------------------------------------------------------------

const DEFAULT_REINDEX_TRIGGER_POLL_MS = 5000;
const MIN_REINDEX_TRIGGER_POLL_MS = 1000;
const MAX_REINDEX_TRIGGER_POLL_MS = 60000;

export type ReindexTriggerPollMsResolution = {
  value: number;
  source: 'default' | 'env' | 'fallback';
  raw_value: string | null;
  warning: string | null;
};

export function resolveReindexTriggerPollMs(
  raw: string | undefined,
): ReindexTriggerPollMsResolution {
  if (raw === undefined || raw.trim() === '') {
    return {
      value: DEFAULT_REINDEX_TRIGGER_POLL_MS,
      source: 'default',
      raw_value: raw ?? null,
      warning: null,
    };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return {
      value: DEFAULT_REINDEX_TRIGGER_POLL_MS,
      source: 'fallback',
      raw_value: raw,
      warning: `invalid REINDEX_TRIGGER_POLL_MS=${JSON.stringify(raw)}; using ${DEFAULT_REINDEX_TRIGGER_POLL_MS}`,
    };
  }
  if (parsed === 0) {
    return { value: 0, source: 'env', raw_value: raw, warning: null };
  }
  const rounded = Math.round(parsed);
  const value = Math.max(
    MIN_REINDEX_TRIGGER_POLL_MS,
    Math.min(MAX_REINDEX_TRIGGER_POLL_MS, rounded),
  );
  let warning: string | null = null;
  if (value !== rounded) {
    warning = `REINDEX_TRIGGER_POLL_MS=${JSON.stringify(raw)} clamped to ${value}`;
  } else if (rounded !== parsed) {
    warning = `REINDEX_TRIGGER_POLL_MS=${JSON.stringify(raw)} rounded to ${value}`;
  }
  return { value, source: 'env', raw_value: raw, warning };
}

/**
 * @internal
 *
 * Exported only so config tests can pin the parser semantics
 * (default, sentinel, MIN/MAX clamp, scientific-notation acceptance)
 * directly. Production code uses the resolved `REINDEX_TRIGGER_POLL_MS`
 * constant below - no consumer outside the test file should import this
 * function.
 */
export function parseReindexTriggerPollMs(raw: string | undefined): number {
  return resolveReindexTriggerPollMs(raw).value;
}

export const REINDEX_TRIGGER_POLL_MS: number = parseReindexTriggerPollMs(
  process.env.REINDEX_TRIGGER_POLL_MS,
);

export type ReindexTriggerPathResolution = {
  path: string;
  source: 'default' | 'env';
  raw_value: string | null;
  warnings: string[];
};

export function resolveReindexTriggerPath(
  raw: string | undefined,
  rootDir: string = KNOWLEDGE_BASES_ROOT_DIR,
): ReindexTriggerPathResolution {
  if (raw === undefined || raw.trim() === '') {
    return {
      path: path.join(rootDir, '.reindex-trigger'),
      source: 'default',
      raw_value: raw ?? null,
      warnings: [],
    };
  }
  return {
    path: raw,
    source: 'env',
    raw_value: raw,
    warnings: path.isAbsolute(raw)
      ? []
      : ['REINDEX_TRIGGER_PATH is relative; it is resolved against the server process working directory'],
  };
}

/**
 * Path the reindex-trigger watcher polls. Defaults to a dotfile at the
 * KB root so it is NOT picked up by `getFilesRecursively` (which skips
 * dot-prefixed entries at `src/file-utils.ts:25-29`).
 */
export const REINDEX_TRIGGER_PATH: string =
  resolveReindexTriggerPath(process.env.REINDEX_TRIGGER_PATH).path;

// ---------------------------------------------------------------------------
// Recursive fs.watch watcher (RFC 007 section6.6, issue #212).
//
// Observes per-file edits *inside* each registered KB directory, complementing
// the RFC 011 trigger-file poller (which sees the root-level dotfile that
// external workflows `touch`). Off by default for v1 because `fs.watch` has
// platform quirks (NFS, FUSE, very large trees on Linux) we don't want to
// surprise existing users with - operators opt in with `KB_FS_WATCH=1`.
// ---------------------------------------------------------------------------

/**
 * @internal exported only for config tests. Accepts the `1` / `true`
 * / `yes` / `on` family (case-insensitive); everything else is `false`.
 * Empty / unset -> `false` (default off).
 */
export function parseKbFsWatchFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '') return false;
  return trimmed === '1' || trimmed === 'true' || trimmed === 'yes' || trimmed === 'on';
}

export const KB_FS_WATCH: boolean = parseKbFsWatchFlag(process.env.KB_FS_WATCH);

const DEFAULT_KB_FS_WATCH_DEBOUNCE_MS = 250;
const MIN_KB_FS_WATCH_DEBOUNCE_MS = 25;
const MAX_KB_FS_WATCH_DEBOUNCE_MS = 60_000;

/**
 * @internal exported only for config tests. Parses the per-(kb, file)
 * debounce window. Invalid / unset -> default 250 ms; otherwise clamped
 * into `[MIN, MAX]` so an operator-supplied `5` doesn't spin or `3600000`
 * doesn't defeat the point of the watcher.
 */
export function parseKbFsWatchDebounceMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_KB_FS_WATCH_DEBOUNCE_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_KB_FS_WATCH_DEBOUNCE_MS;
  }
  return Math.max(
    MIN_KB_FS_WATCH_DEBOUNCE_MS,
    Math.min(MAX_KB_FS_WATCH_DEBOUNCE_MS, Math.round(parsed)),
  );
}

export const KB_FS_WATCH_DEBOUNCE_MS: number = parseKbFsWatchDebounceMs(
  process.env.KB_FS_WATCH_DEBOUNCE_MS,
);
