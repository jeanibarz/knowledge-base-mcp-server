// Property tests for `filterIngestablePaths` (issue #219).
//
// Invariants covered:
//   * Allow-list monotonicity: adding an extra extension never removes a path
//     that was already admitted under the smaller set.
//   * Operator-supplied excludes do not weaken base exclusions: a path that
//     matches a base exclusion (segment literal, basename literal, or
//     first-segment subtree) is rejected regardless of `extraExtensions` /
//     `excludePaths` settings.
//   * Idempotency: filtering twice returns the same output (the predicate is
//     pure modulo the one-shot logger, which we reset before each iteration).
//   * Determinism: same input → same output across repeated calls.

// Logger info-level chatter (the "Skipping filesystem-metadata sidecar …"
// one-shot) is suppressed by raising LOG_LEVEL before the logger module is
// evaluated; the env value is read once at module load.
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';

import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import * as path from 'path';
import {
  filterIngestablePaths,
  INGEST_BASE_EXTENSIONS,
  __resetSkippedFilenameLogForTests,
} from '../ingest-filter.js';

const NUM_RUNS = process.env.KB_PROPERTY_DEEP === '1' ? 1000 : 50;

const KB_ROOT = '/tmp/kb-prop';

const SAFE_SEGMENT_REGEX = /^[A-Za-z0-9_-]{1,12}$/;

const safeSegmentArb = fc.stringMatching(SAFE_SEGMENT_REGEX);

// Build a relative path of 1..4 segments + a basename with a chosen extension.
const relPathArb = fc.tuple(
  fc.array(safeSegmentArb, { minLength: 0, maxLength: 3 }),
  fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/),
  fc.constantFrom(
    '.md',
    '.markdown',
    '.txt',
    '.rst',
    '.pdf',
    '.html',
    '.htm',
    '.png',
    '.jpg',
    '.bin',
    '.json',
    '.csv',
    '.yaml',
  ),
).map(([dirs, base, ext]) => {
  const rel = [...dirs, `${base}${ext}`].join('/');
  return path.join(KB_ROOT, rel);
});

const extraExtensionArb = fc
  .stringMatching(/^[A-Za-z0-9]{1,5}$/)
  .map((s) => `.${s.toLowerCase()}`);

describe('filterIngestablePaths — property tests (issue #219)', () => {
  it('extra-extensions monotonicity: adding an allowlist entry never excludes prior matches', () => {
    fc.assert(
      fc.property(
        fc.array(relPathArb, { minLength: 0, maxLength: 20 }),
        fc.array(extraExtensionArb, { minLength: 0, maxLength: 3 }),
        extraExtensionArb,
        (paths, baseExtras, addedExt) => {
          __resetSkippedFilenameLogForTests();
          const before = new Set(
            filterIngestablePaths(paths, KB_ROOT, { extraExtensions: baseExtras }),
          );
          const after = new Set(
            filterIngestablePaths(paths, KB_ROOT, {
              extraExtensions: [...baseExtras, addedExt],
            }),
          );
          // Every path admitted before is still admitted after.
          for (const p of before) expect(after.has(p)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('operator cannot override base exclusions (sidecar segments, OS turds, log subtree)', () => {
    const sidecarBasenames = ['_seen.jsonl', '_seen.json', '_index.jsonl'];
    const turds = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];

    fc.assert(
      fc.property(
        fc.array(extraExtensionArb, { minLength: 0, maxLength: 3 }),
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 3 }),
        fc.constantFrom(...INGEST_BASE_EXTENSIONS),
        safeSegmentArb,
        (extraExts, exclude, allowedExt, leaf) => {
          __resetSkippedFilenameLogForTests();
          // Construct paths that match each base exclusion rule. Even with
          // every extension allowlisted and *no* extra excludes, none should
          // be admitted.
          const sidecarSegmentPath = path.join(KB_ROOT, 'docs', sidecarBasenames[0]);
          const turdPath = path.join(KB_ROOT, 'docs', turds[0]);
          const logSubtreePath = path.join(KB_ROOT, 'logs', `${leaf}${allowedExt}`);
          const tmpSubtreePath = path.join(KB_ROOT, 'tmp', `${leaf}${allowedExt}`);

          const out = filterIngestablePaths(
            [sidecarSegmentPath, turdPath, logSubtreePath, tmpSubtreePath],
            KB_ROOT,
            { extraExtensions: extraExts, excludePaths: exclude },
          );
          expect(out).toEqual([]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('idempotency: filter(filter(x)) === filter(x) for already-filtered inputs', () => {
    fc.assert(
      fc.property(
        fc.array(relPathArb, { minLength: 0, maxLength: 20 }),
        fc.array(extraExtensionArb, { minLength: 0, maxLength: 3 }),
        (paths, extras) => {
          __resetSkippedFilenameLogForTests();
          const opts = { extraExtensions: extras };
          const once = filterIngestablePaths(paths, KB_ROOT, opts);
          const twice = filterIngestablePaths(once, KB_ROOT, opts);
          expect(twice).toEqual(once);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('determinism: same inputs → same output across repeated calls', () => {
    fc.assert(
      fc.property(
        fc.array(relPathArb, { minLength: 0, maxLength: 20 }),
        fc.array(extraExtensionArb, { minLength: 0, maxLength: 3 }),
        fc.array(safeSegmentArb, { minLength: 0, maxLength: 3 }),
        (paths, extras, excludes) => {
          __resetSkippedFilenameLogForTests();
          const opts = { extraExtensions: extras, excludePaths: excludes };
          const a = filterIngestablePaths(paths, KB_ROOT, opts);
          const b = filterIngestablePaths(paths, KB_ROOT, opts);
          expect(b).toEqual(a);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
