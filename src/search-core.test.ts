import { describe, expect, it } from '@jest/globals';
import {
  buildExplainEmptyDiagnostics,
  computeAutoThreshold,
  formatAutoModeHeader,
  formatAutoThresholdHeader,
  formatExplainEmptyDiagnosticsMarkdown,
  formatFreshnessFooter,
  resolveAutoSearchMode,
  type AutoThresholdDecision,
  type ExplainEmptyDiagnostics,
  type Staleness,
} from './search-core.js';

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

  it('keeps filesystem enumeration warnings visible in the freshness footer', () => {
    const s: Staleness = {
      indexMtime: MTIME,
      modifiedFiles: 0,
      newFiles: 0,
      scan: {
        scope: 'global',
        source: 'filesystem',
        filesScanned: 1,
        globalFiles: 1,
        kbsScanned: 1,
        enumerationFailures: 1,
        enumerationFailureSamples: [{
          kbName: 'alpha',
          path: '/tmp/kbs/alpha/blocked',
          code: 'EACCES',
          message: 'permission denied',
        }],
      },
    };

    expect(formatFreshnessFooter(s, false)).toBe(
      `> _Index up-to-date as of ${MTIME}._\n` +
      '> _Filesystem enumeration warning: 1 failure(s) while scanning KB files; ' +
      'freshness counts may be partial. First sample: alpha:/tmp/kbs/alpha/blocked (EACCES)._',
    );
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

describe('buildExplainEmptyDiagnostics (#328)', () => {
  const KB_ROOT = '/kb-root';
  const candidate = (kbName: string, score: number, file = 'doc.md') =>
    ({
      score,
      metadata: { source: `${KB_ROOT}/${kbName}/${file}` },
    } as const);

  it('classifies scope drops first then threshold drops so counts sum to pre-filter total', () => {
    const raw = [
      candidate('work', 0.3),     // in-scope, under threshold → kept
      candidate('work', 0.9),     // in-scope, over threshold → threshold drop
      candidate('personal', 0.2), // out-of-scope (even though score would pass) → scope drop
      candidate('personal', 0.9), // out-of-scope → scope drop (scope wins over threshold)
    ];
    const d = buildExplainEmptyDiagnostics({
      rawCandidates: raw,
      threshold: 0.5,
      scopedKb: 'work',
      allKbs: ['personal', 'work'],
      staleness: null,
      kbRoot: KB_ROOT,
    });

    expect(d.candidatesPreFilter).toBe(4);
    expect(d.candidatesPostFilter).toBe(1);
    expect(d.filterDrops.kbScope).toBe(2);
    expect(d.filterDrops.threshold).toBe(1);
    expect(d.filterDrops.kbScope).toBeGreaterThanOrEqual(0);
    expect(d.filterDrops.threshold).toBeGreaterThanOrEqual(0);
    expect(
      d.filterDrops.kbScope + d.filterDrops.threshold + d.candidatesPostFilter,
    ).toBe(d.candidatesPreFilter);
  });

  it('reports kbs_searched as just the scoped KB and kbs_skipped with a reason', () => {
    const d = buildExplainEmptyDiagnostics({
      rawCandidates: [],
      threshold: 0.5,
      scopedKb: 'work',
      allKbs: ['personal', 'work', 'archive'],
      staleness: null,
      kbRoot: KB_ROOT,
    });
    expect(d.scope.requestedKb).toBe('work');
    expect(d.scope.kbsSearched).toEqual(['work']);
    expect(d.scope.kbsSkipped).toEqual([
      { kb: 'personal', reason: 'outside --kb=work' },
      { kb: 'archive', reason: 'outside --kb=work' },
    ]);
  });

  it('reports global scope when no --kb is set', () => {
    const d = buildExplainEmptyDiagnostics({
      rawCandidates: [],
      threshold: 0.5,
      scopedKb: undefined,
      allKbs: ['personal', 'work'],
      staleness: null,
      kbRoot: KB_ROOT,
    });
    expect(d.scope.requestedKb).toBeNull();
    expect(d.scope.kbsSearched).toEqual(['personal', 'work']);
    expect(d.scope.kbsSkipped).toEqual([]);
  });

  it('caps nearest_candidates to 3 by default and preserves drop classification', () => {
    const raw = [
      candidate('work', 0.10),
      candidate('work', 0.20),
      candidate('work', 0.30),
      candidate('work', 0.40),
      candidate('work', 0.50),
    ];
    const d = buildExplainEmptyDiagnostics({
      rawCandidates: raw,
      threshold: 0.25,
      scopedKb: 'work',
      allKbs: ['work'],
      staleness: null,
      kbRoot: KB_ROOT,
    });
    expect(d.nearestCandidates).toHaveLength(3);
    expect(d.nearestCandidates.map((c) => c.score)).toEqual([0.10, 0.20, 0.30]);
    expect(d.nearestCandidates.map((c) => c.droppedBy)).toEqual([
      'none',
      'none',
      'threshold',
    ]);
    expect(d.nearestCandidates.every((c) => c.kb === 'work')).toBe(true);
  });

  it('reuses provided staleness without rescanning and folds scoped + global counts', () => {
    const staleness: Staleness = {
      indexMtime: MTIME,
      modifiedFiles: 2,
      newFiles: 5,
      scope: { kb: 'work', modifiedFiles: 2, newFiles: 5 },
      global: { modifiedFiles: 4, newFiles: 7 },
    };
    const d = buildExplainEmptyDiagnostics({
      rawCandidates: [],
      threshold: 0.5,
      scopedKb: 'work',
      allKbs: ['work'],
      staleness,
      kbRoot: KB_ROOT,
    });
    expect(d.freshness.indexBuilt).toBe(true);
    expect(d.freshness.indexMtime).toBe(MTIME);
    expect(d.freshness.scoped).toEqual({ modifiedFiles: 2, newFiles: 5 });
    expect(d.freshness.global).toEqual({ modifiedFiles: 4, newFiles: 7 });
  });

  it('marks freshness as not-built when staleness is null (--no-freshness)', () => {
    const d = buildExplainEmptyDiagnostics({
      rawCandidates: [],
      threshold: 0.5,
      scopedKb: undefined,
      allKbs: ['work'],
      staleness: null,
      kbRoot: KB_ROOT,
    });
    expect(d.freshness.indexBuilt).toBe(false);
    expect(d.freshness.indexMtime).toBeNull();
    expect(d.freshness.scoped).toBeNull();
  });
});

describe('formatExplainEmptyDiagnosticsMarkdown (#328)', () => {
  const baseDiagnostics: ExplainEmptyDiagnostics = {
    threshold: 0.5,
    candidatesPreFilter: 4,
    candidatesPostFilter: 0,
    filterDrops: { kbScope: 2, threshold: 2 },
    scope: {
      requestedKb: 'work',
      kbsSearched: ['work'],
      kbsSkipped: [{ kb: 'personal', reason: 'outside --kb=work' }],
    },
    freshness: {
      indexBuilt: true,
      indexMtime: MTIME,
      scoped: { modifiedFiles: 2, newFiles: 5 },
      global: { modifiedFiles: 4, newFiles: 7 },
    },
    nearestCandidates: [
      { score: 0.62, source: '/kb-root/work/runbook.md', kb: 'work', droppedBy: 'threshold' },
      { score: 0.71, source: '/kb-root/personal/diary.md', kb: 'personal', droppedBy: 'kb_scope' },
    ],
  };

  it('renders a Diagnostics subsection with per-filter drops, scope, and nearest candidates', () => {
    const out = formatExplainEmptyDiagnosticsMarkdown(baseDiagnostics);
    expect(out).toMatch(/^### Diagnostics$/m);
    expect(out).toContain('Candidates inspected: 4');
    expect(out).toContain('Candidates kept after filters: 0');
    expect(out).toContain('Per-filter drops: kb_scope=2, threshold=2 (threshold=0.50)');
    expect(out).toContain('--kb=work');
    expect(out).toContain(`Index: built ${MTIME}, scoped drift=2m+5n, global drift=4m+7n`);
    expect(out).toContain('score=0.620 /kb-root/work/runbook.md — dropped by threshold');
    expect(out).toContain('score=0.710 /kb-root/personal/diary.md — dropped by kb_scope');
  });

  it('omits the scoped-drift fragment when the run was global', () => {
    const out = formatExplainEmptyDiagnosticsMarkdown({
      ...baseDiagnostics,
      scope: {
        requestedKb: null,
        kbsSearched: ['work', 'personal'],
        kbsSkipped: [],
      },
      freshness: { ...baseDiagnostics.freshness, scoped: null },
    });
    expect(out).toContain('Scope: global (2 KB(s) searched: work, personal)');
    expect(out).toContain(`Index: built ${MTIME}, global drift=4m+7n`);
    expect(out).not.toContain('scoped drift=');
  });

  it('says "index not yet built" when freshness shows no index', () => {
    const out = formatExplainEmptyDiagnosticsMarkdown({
      ...baseDiagnostics,
      freshness: {
        indexBuilt: false,
        indexMtime: null,
        scoped: null,
        global: { modifiedFiles: 0, newFiles: 0 },
      },
    });
    expect(out).toContain('Index: not yet built (run `kb search --refresh` to create it)');
  });

  it('surfaces an explicit "none" when FAISS returned zero candidates', () => {
    const out = formatExplainEmptyDiagnosticsMarkdown({
      ...baseDiagnostics,
      candidatesPreFilter: 0,
      filterDrops: { kbScope: 0, threshold: 0 },
      nearestCandidates: [],
    });
    expect(out).toContain('Nearest candidates: none (index may be empty or never built)');
  });
});
