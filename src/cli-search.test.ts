import { describe, expect, it } from '@jest/globals';
import {
  AutoThresholdDecision,
  computeAutoThreshold,
  formatAutoThresholdHeader,
  formatFreshnessFooter,
  Staleness,
} from './cli-search.js';

const MTIME = '2026-05-03T15:33:56.964Z';

describe('formatFreshnessFooter', () => {
  it('reports "not yet built" when indexMtime is null', () => {
    const s: Staleness = { indexMtime: null, modifiedFiles: 0, newFiles: 0 };
    expect(formatFreshnessFooter(s, false)).toBe(
      '> _Index not yet built. Run `kb search --refresh` to create it._',
    );
  });

  it('reports a refresh confirmation when refreshed=true', () => {
    const s: Staleness = { indexMtime: MTIME, modifiedFiles: 0, newFiles: 17 };
    expect(formatFreshnessFooter(s, true)).toBe(`> _Index refreshed at ${MTIME}._`);
  });

  it('reports up-to-date when neither modified nor new files exist', () => {
    const s: Staleness = { indexMtime: MTIME, modifiedFiles: 0, newFiles: 0 };
    expect(formatFreshnessFooter(s, false)).toBe(`> _Index up-to-date as of ${MTIME}._`);
  });

  it('uses a gentle hint (no "may be stale") when only new files were added', () => {
    const s: Staleness = { indexMtime: MTIME, modifiedFiles: 0, newFiles: 1857 };
    const out = formatFreshnessFooter(s, false);
    expect(out).toBe(
      `> _1857 new file(s) since ${MTIME}; run \`kb search --refresh\` to include them._`,
    );
    expect(out).not.toMatch(/may be stale/);
  });

  it('still warns "may be stale" when at least one file was modified', () => {
    const s: Staleness = { indexMtime: MTIME, modifiedFiles: 3, newFiles: 0 };
    expect(formatFreshnessFooter(s, false)).toBe(
      `> _Index may be stale: 3 modified, 0 new file(s) since ${MTIME}. Run \`kb search --refresh\` to update._`,
    );
  });

  it('still warns "may be stale" when files were both modified and added', () => {
    const s: Staleness = { indexMtime: MTIME, modifiedFiles: 2, newFiles: 5 };
    expect(formatFreshnessFooter(s, false)).toBe(
      `> _Index may be stale: 2 modified, 5 new file(s) since ${MTIME}. Run \`kb search --refresh\` to update._`,
    );
  });
});

describe('computeAutoThreshold', () => {
  it('returns kept=0 with null knee for empty input', () => {
    expect(computeAutoThreshold([])).toEqual({ threshold: 0, kneeIndex: null, kept: 0 });
  });

  it('keeps the single result with null knee when only one score', () => {
    expect(computeAutoThreshold([0.42])).toEqual({
      threshold: 0.42,
      kneeIndex: null,
      kept: 1,
    });
  });

  it('detects a clear knee at the largest first-difference', () => {
    // diffs: [0.1, 0.1, 0.5, 0.1] — biggest jump between scores[2] and scores[3]
    const d = computeAutoThreshold([0.30, 0.40, 0.50, 1.00, 1.10]);
    expect(d.kneeIndex).toBe(2);
    expect(d.kept).toBe(3);
    expect(d.threshold).toBeCloseTo(0.50, 6);
  });

  it('reports the knee at result 4 when the elbow is the fourth score', () => {
    // Mirrors the example in the issue body.
    // diffs: [0.05, 0.05, 0.06, 0.20, 0.04, 0.04] → max at idx 3 (between 0.71 and 0.91)
    const d = computeAutoThreshold([0.50, 0.55, 0.60, 0.66, 0.71, 0.91, 0.95, 0.99]);
    expect(d.kneeIndex).toBe(4);
    expect(d.kept).toBe(5);
    expect(d.threshold).toBeCloseTo(0.71, 6);
  });

  it('treats a uniform distribution as no clear knee and keeps all results', () => {
    // diffs: [0.1, 0.1, 0.1, 0.1] — meanDiff == maxDiff
    const d = computeAutoThreshold([0.10, 0.20, 0.30, 0.40, 0.50]);
    expect(d.kneeIndex).toBeNull();
    expect(d.kept).toBe(5);
    expect(d.threshold).toBeCloseTo(0.50, 6);
  });

  it('treats nearly-uniform diffs (within 10% of mean) as no clear knee', () => {
    // diffs: [0.10, 0.105, 0.10, 0.10] — max is 5% over mean, well within 10% slack.
    const d = computeAutoThreshold([0.30, 0.40, 0.505, 0.605, 0.705]);
    expect(d.kneeIndex).toBeNull();
    expect(d.kept).toBe(5);
  });

  it('treats identical scores as no clear knee', () => {
    const d = computeAutoThreshold([0.42, 0.42, 0.42]);
    expect(d.kneeIndex).toBeNull();
    expect(d.kept).toBe(3);
    expect(d.threshold).toBeCloseTo(0.42, 6);
  });

  it('takes the earliest argmax when multiple gaps tie for the largest', () => {
    // diffs: [0.05, 0.50, 0.05, 0.50] — earliest max at idx 1
    const d = computeAutoThreshold([0.30, 0.35, 0.85, 0.90, 1.40]);
    expect(d.kneeIndex).toBe(1);
    expect(d.kept).toBe(2);
    expect(d.threshold).toBeCloseTo(0.35, 6);
  });
});

describe('formatAutoThresholdHeader', () => {
  it('reports the knee position and kept count when a knee is detected', () => {
    const d: AutoThresholdDecision = { threshold: 0.71, kneeIndex: 3, kept: 4 };
    expect(formatAutoThresholdHeader(d)).toBe(
      '> _Auto-threshold: 0.71 (knee at result 4; kept 4)._',
    );
  });

  it('reports "no clear knee" when the distribution is uniform', () => {
    const d: AutoThresholdDecision = { threshold: 0.85, kneeIndex: null, kept: 10 };
    expect(formatAutoThresholdHeader(d)).toBe(
      '> _Auto-threshold: 0.85 (no clear knee; kept all 10 results)._',
    );
  });

  it('handles the single-result case', () => {
    const d: AutoThresholdDecision = { threshold: 0.42, kneeIndex: null, kept: 1 };
    expect(formatAutoThresholdHeader(d)).toBe(
      '> _Auto-threshold: 0.42 (1 result; no knee detection)._',
    );
  });

  it('handles the empty-result case', () => {
    const d: AutoThresholdDecision = { threshold: 0, kneeIndex: null, kept: 0 };
    expect(formatAutoThresholdHeader(d)).toBe('> _Auto-threshold: no results to score._');
  });
});
