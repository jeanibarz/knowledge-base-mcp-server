import { describe, expect, it } from '@jest/globals';
import {
  AutoThresholdDecision,
  computeAutoThreshold,
  formatAutoModeHeader,
  formatAutoThresholdHeader,
  formatFreshnessFooter,
  parseSearchArgs,
  resolveAutoSearchMode,
  shouldUsePicker,
  Staleness,
} from './cli-search.js';
import {
  classifyKbSearchError,
  formatKbSearchFailureJson,
  formatKbSearchFailureStderr,
} from './cli-search-errors.js';
import { WriteLockContentionError } from './write-lock.js';

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

  it('reports scoped stale counts separately from global counts', () => {
    const s: Staleness = {
      indexMtime: MTIME,
      modifiedFiles: 0,
      newFiles: 0,
      scope: { kb: 'agent-task-lessons', modifiedFiles: 0, newFiles: 0 },
      global: { modifiedFiles: 2, newFiles: 2016 },
    };
    expect(formatFreshnessFooter(s, false)).toBe(
      `> _Index up-to-date for KB "agent-task-lessons" as of ${MTIME}. Global index drift outside this scope: 2 modified, 2016 new file(s)._`,
    );
  });

  it('keeps scoped stale guidance scoped to the selected KB', () => {
    const s: Staleness = {
      indexMtime: MTIME,
      modifiedFiles: 1,
      newFiles: 3,
      scope: { kb: 'agent-task-lessons', modifiedFiles: 1, newFiles: 3 },
      global: { modifiedFiles: 7, newFiles: 11 },
    };
    expect(formatFreshnessFooter(s, false)).toBe(
      `> _Index may be stale for KB "agent-task-lessons": 1 modified, 3 new file(s) since ${MTIME}. Run \`kb search --kb=agent-task-lessons --refresh\` to update this scope. Global index drift: 7 modified, 11 new file(s)._`,
    );
  });

  it('reports scoped refreshes without hiding global drift', () => {
    const s: Staleness = {
      indexMtime: MTIME,
      modifiedFiles: 0,
      newFiles: 0,
      scope: { kb: 'agent-task-lessons', modifiedFiles: 0, newFiles: 0 },
      global: { modifiedFiles: 0, newFiles: 2016 },
    };
    expect(formatFreshnessFooter(s, true)).toBe(
      `> _Index refreshed for KB "agent-task-lessons" at ${MTIME}. Global index drift outside this scope: 0 modified, 2016 new file(s)._`,
    );
  });
});

describe('lock contention output (issue #181 + #199 unified shape)', () => {
  const lockErr = new WriteLockContentionError({
    resource: '/tmp/model',
    lockPath: '/tmp/model/.kb-write.lock',
    causeMessage: 'Lock file is already being held',
  });

  it('emits parseable JSON for --format=json callers', () => {
    const parsed = JSON.parse(formatKbSearchFailureJson(classifyKbSearchError(lockErr)));
    // Issue #181 contracted `retry_hint` for lock failures; #199's unified
    // envelope adds `category` + `next_action` and aliases `retry_hint` to
    // `next_action` so existing agents branching on `REFRESH_LOCK_BUSY`
    // keep working.
    expect(parsed).toEqual({
      error: {
        code: 'REFRESH_LOCK_BUSY',
        category: 'lock',
        message: 'Refresh lock is already held for this model. Retry after the current refresh finishes.',
        next_action:
          'Retry in a few seconds; only one `kb search --refresh` writer may run per model at a time.',
        retry_hint:
          'Retry in a few seconds; only one `kb search --refresh` writer may run per model at a time.',
        lock_path: '/tmp/model/.kb-write.lock',
        resource: '/tmp/model',
      },
    });
  });

  it('prints retry guidance for human-mode stderr', () => {
    const out = formatKbSearchFailureStderr(classifyKbSearchError(lockErr));
    expect(out).toContain('Refresh lock is already held');
    expect(out).toContain('category: lock');
    expect(out).toContain('Retry in a few seconds');
    expect(out).toContain('/tmp/model/.kb-write.lock');
  });
});

describe('parseSearchArgs output format', () => {
  it('accepts vimgrep as a search output format', () => {
    expect(parseSearchArgs(['query', '--format=vimgrep'])).toMatchObject({
      query: 'query',
      format: 'vimgrep',
    });
  });

  it('still rejects unknown output formats', () => {
    expect(() => parseSearchArgs(['query', '--format=xml'])).toThrow(/invalid --format/);
  });
});

describe('parseSearchArgs --interactive (#215)', () => {
  it('defaults --interactive to false', () => {
    expect(parseSearchArgs(['query'])).toMatchObject({ interactive: false });
  });

  it('accepts --interactive and -i as the same flag', () => {
    expect(parseSearchArgs(['query', '--interactive'])).toMatchObject({ interactive: true });
    expect(parseSearchArgs(['query', '-i'])).toMatchObject({ interactive: true });
  });
});

describe('parseSearchArgs neighbor context (#225)', () => {
  it('accepts explicit before/after context windows', () => {
    expect(parseSearchArgs([
      'query',
      '--context-before=1',
      '--context-after=2',
    ])).toMatchObject({
      query: 'query',
      neighborContext: { before: 1, after: 2 },
    });
  });

  it('accepts --context-window as a before/after shorthand', () => {
    expect(parseSearchArgs(['query', '--context-window=2'])).toMatchObject({
      neighborContext: { before: 2, after: 2 },
    });
  });

  it('rejects unbounded context windows', () => {
    expect(() => parseSearchArgs(['query', '--context-window=99'])).toThrow(
      /invalid --context-window/,
    );
  });
});

describe('shouldUsePicker (#215)', () => {
  it('returns false when --interactive is not set', () => {
    expect(shouldUsePicker({ interactive: false, format: 'md' })).toBe(false);
  });

  it('returns true for the default markdown format with --interactive', () => {
    expect(shouldUsePicker({ interactive: true, format: 'md' })).toBe(true);
  });

  it('lets --format=json override -i so agent shells stay deterministic', () => {
    expect(shouldUsePicker({ interactive: true, format: 'json' })).toBe(false);
  });

  it('lets --format=vimgrep override -i so editor quickfix flows stay structured', () => {
    expect(shouldUsePicker({ interactive: true, format: 'vimgrep' })).toBe(false);
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

describe('resolveAutoSearchMode', () => {
  it('keeps prose queries on dense retrieval', () => {
    expect(resolveAutoSearchMode('how should I roll back a deployment?')).toEqual({
      mode: 'dense',
      reason: 'prose query',
    });
  });

  it('uses hybrid for exact error and identifier shaped queries', () => {
    expect(resolveAutoSearchMode('INDEX_NOT_INITIALIZED')).toMatchObject({
      mode: 'hybrid',
    });
    expect(resolveAutoSearchMode('FaissIndexManager batch size')).toMatchObject({
      mode: 'hybrid',
    });
  });

  it('uses hybrid for flags, paths, and issue references', () => {
    expect(resolveAutoSearchMode('--refresh behavior')).toMatchObject({ mode: 'hybrid' });
    expect(resolveAutoSearchMode('src/cli-search.ts')).toMatchObject({ mode: 'hybrid' });
    expect(resolveAutoSearchMode('PR #253')).toMatchObject({ mode: 'hybrid' });
  });
});

describe('formatAutoModeHeader', () => {
  it('renders the selected mode and reason', () => {
    expect(formatAutoModeHeader({ mode: 'hybrid', reason: 'file-like token' })).toBe(
      '> _Mode: auto -> hybrid (file-like token)._',
    );
  });
});
