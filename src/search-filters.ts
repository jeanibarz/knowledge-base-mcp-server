import * as fs from 'fs';
import * as path from 'path';
import type { Document } from '@langchain/core/documents';
import { minimatch } from 'minimatch';

export interface SimilaritySearchFilters {
  extensions?: readonly string[];
  pathGlob?: string;
  tags?: readonly string[];
  since?: string;
  until?: string;
}

export type ScoredDocument = readonly [Document, number];

export interface RecencyFilterRange {
  sinceMs?: number;
  untilMs?: number;
}

export interface SimilaritySearchPostFilter {
  requiresOverfetch: boolean;
  apply(resultsWithScore: readonly ScoredDocument[]): ScoredDocument[];
}

export function createSimilaritySearchPostFilter(options: {
  threshold: number;
  knowledgeBasesRootDir: string;
  knowledgeBaseName?: string;
  filters?: SimilaritySearchFilters;
  recencyNowMs?: number;
}): SimilaritySearchPostFilter {
  const { threshold, knowledgeBasesRootDir, knowledgeBaseName, filters } = options;
  const scoped = typeof knowledgeBaseName === 'string' && knowledgeBaseName.length > 0;
  const normalizedExtensions = normalizeExtensionFilter(filters?.extensions);
  const pathGlob = filters?.pathGlob && filters.pathGlob.length > 0 ? filters.pathGlob : undefined;
  const requiredTags = filters?.tags?.filter((t): t is string => typeof t === 'string' && t.length > 0) ?? [];
  const recencyRange = parseRecencyFilterRange({
    since: filters?.since,
    until: filters?.until,
    nowMs: options.recencyNowMs,
  });
  const hasMetadataFilter =
    normalizedExtensions !== undefined || pathGlob !== undefined || requiredTags.length > 0;
  const hasRecencyFilter = recencyRange !== undefined;
  const sourceMtimeMemo = new Map<string, number | null>();
  const kbPrefix = scoped
    ? path.join(knowledgeBasesRootDir, knowledgeBaseName as string) + path.sep
    : undefined;

  return {
    requiresOverfetch: scoped || hasMetadataFilter || hasRecencyFilter,
    apply(resultsWithScore) {
      return resultsWithScore.filter(([doc, score]) => {
        if (score > threshold) {
          return false;
        }
        const metadata = doc.metadata as Record<string, unknown> | undefined;
        if (kbPrefix) {
          const source = metadata?.source;
          if (typeof source !== 'string' || !source.startsWith(kbPrefix)) {
            return false;
          }
        }
        if (normalizedExtensions !== undefined) {
          const ext = metadata?.extension;
          if (typeof ext !== 'string' || !normalizedExtensions.has(ext.toLowerCase())) {
            return false;
          }
        }
        if (pathGlob !== undefined) {
          const rel = metadata?.relativePath;
          if (typeof rel !== 'string' || !matchesPathGlob(rel, pathGlob)) {
            return false;
          }
        }
        if (requiredTags.length > 0) {
          const tags = metadata?.tags;
          if (!Array.isArray(tags)) return false;
          const tagSet = new Set(tags.filter((x): x is string => typeof x === 'string'));
          for (const required of requiredTags) {
            if (!tagSet.has(required)) return false;
          }
        }
        if (recencyRange !== undefined) {
          const source = metadata?.source;
          if (typeof source !== 'string' || source.length === 0) {
            return false;
          }
          const mtimeMs = sourceMtimeMs(source, sourceMtimeMemo);
          if (mtimeMs === null) return false;
          if (recencyRange.sinceMs !== undefined && mtimeMs < recencyRange.sinceMs) {
            return false;
          }
          if (recencyRange.untilMs !== undefined && mtimeMs > recencyRange.untilMs) {
            return false;
          }
        }
        return true;
      });
    },
  };
}

export function parseRecencyFilterRange(input: {
  since?: string;
  until?: string;
  nowMs?: number;
}): RecencyFilterRange | undefined {
  const nowMs = input.nowMs ?? Date.now();
  const sinceMs = input.since === undefined
    ? undefined
    : parseRecencyBound(input.since, 'since', nowMs);
  const untilMs = input.until === undefined
    ? undefined
    : parseRecencyBound(input.until, 'until', nowMs);
  if (sinceMs === undefined && untilMs === undefined) return undefined;
  if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
    throw new Error('invalid recency range: since must be earlier than or equal to until');
  }
  return { sinceMs, untilMs };
}

const DURATION_RE = /^([1-9]\d*)(ms|s|m|h|d|w)$/i;
const ISO_DATE_OR_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function parseRecencyBound(raw: string, label: 'since' | 'until', nowMs: number): number {
  const value = raw.trim();
  if (value.length === 0) {
    throw new Error(`invalid ${label}: expected duration like 30d/24h or ISO date`);
  }
  const durationMatch = DURATION_RE.exec(value);
  if (durationMatch !== null) {
    const amount = Number(durationMatch[1]);
    const unit = durationMatch[2].toLowerCase();
    return nowMs - amount * durationUnitMs(unit);
  }
  if (!ISO_DATE_OR_TIMESTAMP_RE.test(value)) {
    throw new Error(`invalid ${label}: expected duration like 30d/24h or ISO date`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid ${label}: expected duration like 30d/24h or ISO date`);
  }
  return parsed;
}

function durationUnitMs(unit: string): number {
  switch (unit) {
    case 'ms': return 1;
    case 's': return 1000;
    case 'm': return 60 * 1000;
    case 'h': return 60 * 60 * 1000;
    case 'd': return 24 * 60 * 60 * 1000;
    case 'w': return 7 * 24 * 60 * 60 * 1000;
    default: {
      const exhaustive: never = unit as never;
      return exhaustive;
    }
  }
}

function sourceMtimeMs(source: string, memo: Map<string, number | null>): number | null {
  if (memo.has(source)) {
    return memo.get(source) ?? null;
  }
  let mtimeMs: number | null = null;
  try {
    const stat = fs.statSync(source);
    if (stat.isFile()) {
      mtimeMs = stat.mtimeMs;
    }
  } catch {
    mtimeMs = null;
  }
  memo.set(source, mtimeMs);
  return mtimeMs;
}

/**
 * Issue #53 — normalize the extensions filter into a lower-cased, dot-prefixed
 * Set for O(1) lookup. Returns `undefined` when the filter is absent or empty
 * (so the caller can skip the filter entirely instead of rejecting every doc).
 * Empty/whitespace entries are dropped silently — a trailing `,` or stray
 * empty string in the user's array shouldn't cause a no-results.
 */
function normalizeExtensionFilter(raw: readonly string[] | undefined): Set<string> | undefined {
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

/**
 * Issue #53 — match `pathGlob` against the KB-internal relative path.
 * `metadata.relativePath` is KNOWLEDGE_BASES_ROOT_DIR-relative (i.e.
 * `<kb-name>/path/to/file.md`). The user's glob is meant to read against the
 * in-KB path — `"runbooks/**"` should match any KB's `runbooks/foo.md` —
 * so we strip the KB-name segment and match against the rest. The full
 * KB-prefixed form is also tried as a fallback so an explicit prefix in the
 * pattern (e.g. `"my-kb/notes/**"`) still works.
 */
function matchesPathGlob(relativePath: string, pattern: string): boolean {
  const opts = { dot: true, nonegate: true } as const;
  if (minimatch(relativePath, pattern, opts)) return true;
  const firstSep = relativePath.indexOf('/');
  if (firstSep > 0) {
    const inKb = relativePath.slice(firstSep + 1);
    if (minimatch(inKb, pattern, opts)) return true;
  }
  return false;
}
