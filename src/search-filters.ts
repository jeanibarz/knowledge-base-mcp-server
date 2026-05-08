import * as path from 'path';
import type { Document } from '@langchain/core/documents';
import { minimatch } from 'minimatch';

export interface SimilaritySearchFilters {
  extensions?: readonly string[];
  pathGlob?: string;
  tags?: readonly string[];
}

export type ScoredDocument = readonly [Document, number];

export interface SimilaritySearchPostFilter {
  requiresOverfetch: boolean;
  apply(resultsWithScore: readonly ScoredDocument[]): ScoredDocument[];
}

export function createSimilaritySearchPostFilter(options: {
  threshold: number;
  knowledgeBasesRootDir: string;
  knowledgeBaseName?: string;
  filters?: SimilaritySearchFilters;
}): SimilaritySearchPostFilter {
  const { threshold, knowledgeBasesRootDir, knowledgeBaseName, filters } = options;
  const scoped = typeof knowledgeBaseName === 'string' && knowledgeBaseName.length > 0;
  const normalizedExtensions = normalizeExtensionFilter(filters?.extensions);
  const pathGlob = filters?.pathGlob && filters.pathGlob.length > 0 ? filters.pathGlob : undefined;
  const requiredTags = filters?.tags?.filter((t): t is string => typeof t === 'string' && t.length > 0) ?? [];
  const hasMetadataFilter =
    normalizedExtensions !== undefined || pathGlob !== undefined || requiredTags.length > 0;
  const kbPrefix = scoped
    ? path.join(knowledgeBasesRootDir, knowledgeBaseName as string) + path.sep
    : undefined;

  return {
    requiresOverfetch: scoped || hasMetadataFilter,
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
        return true;
      });
    },
  };
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
