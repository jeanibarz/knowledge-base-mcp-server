import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as path from 'path';
import yaml from 'js-yaml';
import { parseEvalArgs, toJsonReport } from './cli-eval.js';
import type { ScoredDocument } from './formatter.js';
import type { Staleness } from './cli-search.js';
import {
  evaluateRetrievalCase,
  formatRetrievalEvalMarkdown,
  normalizeRetrievalEvalFixture,
  retrievalEvalExitCode,
  resolveRetrievalEvalMode,
  summarizeRetrievalEval,
  type RetrievalEvalCase,
} from './retrieval-eval.js';

const FRESH: Staleness = { indexMtime: '2026-05-09T08:00:00.000Z', modifiedFiles: 0, newFiles: 0 };

function doc(source: string, score = 0.5, metadata: Record<string, unknown> = {}): ScoredDocument {
  return {
    pageContent: `content from ${source}`,
    score,
    metadata: {
      source,
      relativePath: source,
      ...metadata,
    },
  };
}

function fixtureCase(overrides: Partial<RetrievalEvalCase> = {}): RetrievalEvalCase {
  return {
    name: 'case',
    query: 'deployment notes',
    requiredSources: [],
    forbiddenSources: [],
    expectedMetadata: [],
    relevanceJudgments: [],
    stalePolicy: 'fresh',
    ...overrides,
  };
}

describe('normalizeRetrievalEvalFixture', () => {
  it('normalizes fixture-level and case-level retrieval modes', () => {
    const fixture = normalizeRetrievalEvalFixture({
      gate: false,
      mode: 'hybrid',
      cases: [{
        name: 'auto exact token',
        query: 'INDEX_NOT_INITIALIZED',
        mode: 'auto',
      }],
    });

    expect(fixture.mode).toBe('hybrid');
    expect(fixture.cases[0].mode).toBe('auto');
  });

  it('rejects invalid retrieval modes in fixtures', () => {
    expect(() => normalizeRetrievalEvalFixture({
      mode: 'sparse',
      cases: [{ query: 'deployment notes' }],
    })).toThrow('fixture mode must be "dense", "lexical", "hybrid", or "auto"');
  });

  it('normalizes fixture cases with source, metadata, duplicate, judgment, gate, and stale policy fields', () => {
    const fixture = normalizeRetrievalEvalFixture({
      gate: true,
      cases: [{
        name: 'routing',
        query: 'routing bug',
        kb: 'ops',
        k: 5,
        threshold: 0.8,
        gate: false,
        required_sources: ['runbooks/routing.md'],
        forbidden_sources: ['archive/old-routing.md'],
        relevant_sources: [
          { source: 'runbooks/routing.md', relevance: 3 },
          'runbooks/fallback.md',
        ],
        expected_metadata: { 'frontmatter.status': 'approved' },
        max_duplicate_groups: 1,
        stale_policy: { expect: 'fresh' },
      }],
    });

    expect(fixture.gate).toBe(true);
    expect(fixture.cases[0]).toMatchObject({
      name: 'routing',
      query: 'routing bug',
      kb: 'ops',
      k: 5,
      threshold: 0.8,
      gate: false,
      requiredSources: ['runbooks/routing.md'],
      forbiddenSources: ['archive/old-routing.md'],
      relevanceJudgments: [
        { source: 'runbooks/routing.md', relevance: 3 },
        { source: 'runbooks/fallback.md', relevance: 1 },
      ],
      maxDuplicateGroups: 1,
      stalePolicy: 'fresh',
    });
    expect(fixture.cases[0].expectedMetadata).toEqual([
      { path: 'frontmatter.status', equals: 'approved' },
    ]);
  });

  it('normalizes compact judgment objects', () => {
    const fixture = normalizeRetrievalEvalFixture({
      cases: [{
        query: 'deployment notes',
        judgments: {
          'runbooks/deploy.md': 2,
          'runbooks/fallback.md': 1,
        },
      }],
    });

    expect(fixture.cases[0].relevanceJudgments).toEqual([
      { source: 'runbooks/deploy.md', relevance: 2 },
      { source: 'runbooks/fallback.md', relevance: 1 },
    ]);
  });

  it('preserves the normalized fixture shape when judgments are absent', () => {
    const fixture = normalizeRetrievalEvalFixture({
      cases: [{ query: 'deployment notes' }],
    });

    expect(fixture.cases[0].relevanceJudgments).toBeUndefined();
  });

  it('parses the methodology starter fixture against the eval schema', async () => {
    const raw = await fsp.readFile(
      path.join(process.cwd(), 'docs/testing/fixtures/methodology-starter.yml'),
      'utf-8',
    );
    const fixture = normalizeRetrievalEvalFixture(yaml.load(raw));

    expect(fixture.gate).toBe(false);
    expect(fixture.cases).toHaveLength(5);
    expect(fixture.cases.map((fixtureCase) => fixtureCase.name)).toEqual([
      'smoke - docs answer doctor availability',
      'recall - per-file hash sidecars remain discoverable',
      'precision - archived deploy runbook stays out',
      'metadata - approved baseline carries owner',
      'near miss - scoped query does not leak personal notes',
    ]);
    expect(fixture.cases[3].expectedMetadata).toEqual([
      { path: 'frontmatter.status', equals: 'approved' },
      { path: 'frontmatter.owner', equals: 'search-platform' },
    ]);
    expect(fixture.cases[4].stalePolicy).toBe('allow_stale');
  });
});

describe('parseEvalArgs', () => {
  it('parses retrieval mode selection', () => {
    expect(parseEvalArgs(['fixture.yml', '--mode=hybrid']).mode).toBe('hybrid');
    expect(parseEvalArgs(['fixture.yml']).mode).toBeUndefined();
  });

  it('rejects invalid retrieval modes', () => {
    expect(() => parseEvalArgs(['fixture.yml', '--mode=sparse'])).toThrow(
      "invalid --mode: --mode=sparse (expected 'dense', 'lexical', 'hybrid', or 'auto')",
    );
  });
});

describe('resolveRetrievalEvalMode', () => {
  it('preserves explicit dense mode', () => {
    expect(resolveRetrievalEvalMode('dense', 'INDEX_NOT_INITIALIZED')).toEqual({
      requestedMode: 'dense',
      effectiveMode: 'dense',
    });
  });

  it('records auto mode decisions per query', () => {
    expect(resolveRetrievalEvalMode('auto', 'INDEX_NOT_INITIALIZED')).toEqual({
      requestedMode: 'auto',
      effectiveMode: 'hybrid',
      autoMode: { mode: 'hybrid', reason: 'constant or error-code token' },
    });
  });
});

describe('evaluateRetrievalCase', () => {
  it('passes when required sources and metadata are present and duplicate budget is respected', () => {
    const result = evaluateRetrievalCase(
      fixtureCase({
        requiredSources: ['runbooks/routing.md'],
        forbiddenSources: ['archive/old-routing.md'],
        expectedMetadata: [{ path: 'frontmatter.status', equals: 'approved' }],
        maxDuplicateGroups: 1,
      }),
      [
        doc('/tmp/kbs/ops/runbooks/routing.md', 0.2, {
          frontmatter: { status: 'approved' },
        }),
        doc('notes/design.md'),
        doc('notes/design.md'),
      ],
      FRESH,
    );

    expect(result.passed).toBe(true);
    expect(result.duplicateGroups).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.requestedMode).toBe('dense');
    expect(result.effectiveMode).toBe('dense');
  });

  it('records requested and effective retrieval mode in case results', () => {
    const result = evaluateRetrievalCase(
      fixtureCase(),
      [],
      FRESH,
      false,
      {
        requestedMode: 'auto',
        effectiveMode: 'hybrid',
        autoMode: { mode: 'hybrid', reason: 'constant or error-code token' },
      },
    );

    expect(summarizeRetrievalEval([result]).cases[0]).toMatchObject({
      requestedMode: 'auto',
      effectiveMode: 'hybrid',
      autoMode: { mode: 'hybrid', reason: 'constant or error-code token' },
    });
  });

  it('fails when a required source is missing', () => {
    const result = evaluateRetrievalCase(
      fixtureCase({ requiredSources: ['runbooks/incident.md'] }),
      [doc('runbooks/routing.md')],
      FRESH,
    );

    expect(result.passed).toBe(false);
    expect(result.failures).toContain('missing required source: runbooks/incident.md');
  });

  it('fails when a forbidden source is present', () => {
    const result = evaluateRetrievalCase(
      fixtureCase({ forbiddenSources: ['archive/obsolete.md'] }),
      [doc('archive/obsolete.md')],
      FRESH,
    );

    expect(result.passed).toBe(false);
    expect(result.failures).toContain('forbidden source present: archive/obsolete.md');
  });

  it('fails when duplicate source groups exceed the budget', () => {
    const result = evaluateRetrievalCase(
      fixtureCase({ maxDuplicateGroups: 1 }),
      [
        doc('notes/a.md'),
        doc('notes/a.md'),
        doc('notes/b.md'),
        doc('notes/b.md'),
        doc('notes/c.md'),
      ],
      FRESH,
    );

    expect(result.passed).toBe(false);
    expect(result.duplicateGroups).toBe(2);
    expect(result.failures).toContain('duplicate source groups 2 exceeds budget 1');
  });

  it('only produces a nonzero exit when a failing case is gated', () => {
    const warning = evaluateRetrievalCase(
      fixtureCase({ requiredSources: ['missing.md'] }),
      [],
      FRESH,
      false,
    );
    const gated = evaluateRetrievalCase(
      fixtureCase({ gate: true, requiredSources: ['missing.md'] }),
      [],
      FRESH,
      false,
    );

    expect(retrievalEvalExitCode(summarizeRetrievalEval([warning]))).toBe(0);
    expect(retrievalEvalExitCode(summarizeRetrievalEval([gated]))).toBe(1);
  });

  it('computes perfect ranked metrics for a perfect ranking', () => {
    const result = evaluateRetrievalCase(
      fixtureCase({
        k: 3,
        relevanceJudgments: [
          { source: 'runbooks/deploy.md', relevance: 1 },
          { source: 'runbooks/fallback.md', relevance: 1 },
        ],
      }),
      [
        doc('runbooks/deploy.md'),
        doc('runbooks/fallback.md'),
        doc('notes/other.md'),
      ],
      FRESH,
    );

    expect(result.rankedMetrics).toEqual({
      k: 3,
      judgedRelevantCount: 2,
      retrievedRelevantCount: 2,
      ndcgAt10: 1,
      mrrAt10: 1,
      recallAtK: 1,
      precisionAtK: 2 / 3,
      map: 1,
      mapAtK: 1,
      hitRate: 1,
    });
  });

  it('penalizes a relevant source that is retrieved at a low rank', () => {
    const result = evaluateRetrievalCase(
      fixtureCase({
        k: 10,
        relevanceJudgments: [{ source: 'runbooks/deploy.md', relevance: 1 }],
      }),
      [
        doc('noise/1.md'),
        doc('noise/2.md'),
        doc('noise/3.md'),
        doc('noise/4.md'),
        doc('noise/5.md'),
        doc('noise/6.md'),
        doc('noise/7.md'),
        doc('noise/8.md'),
        doc('noise/9.md'),
        doc('runbooks/deploy.md'),
      ],
      FRESH,
    );

    expect(result.rankedMetrics?.hitRate).toBe(1);
    expect(result.rankedMetrics?.mrrAt10).toBeCloseTo(0.1, 6);
    expect(result.rankedMetrics?.recallAtK).toBe(1);
    expect(result.rankedMetrics?.precisionAtK).toBeCloseTo(0.1, 6);
    expect(result.rankedMetrics?.map).toBeCloseTo(0.1, 6);
    expect(result.rankedMetrics?.mapAtK).toBeCloseTo(0.1, 6);
    expect(result.rankedMetrics?.ndcgAt10).toBeCloseTo(1 / Math.log2(11), 6);
  });

  it('reports zero ranked metrics for a missing judged source without failing the binary case', () => {
    const result = evaluateRetrievalCase(
      fixtureCase({
        k: 5,
        relevanceJudgments: [{ source: 'runbooks/deploy.md', relevance: 1 }],
      }),
      [doc('notes/other.md')],
      FRESH,
    );

    expect(result.passed).toBe(true);
    expect(result.rankedMetrics).toMatchObject({
      retrievedRelevantCount: 0,
      ndcgAt10: 0,
      mrrAt10: 0,
      recallAtK: 0,
      precisionAtK: 0,
      map: 0,
      mapAtK: 0,
      hitRate: 0,
    });
  });

  it('uses graded relevance for nDCG and binary relevance for AP-style metrics', () => {
    const result = evaluateRetrievalCase(
      fixtureCase({
        k: 3,
        relevanceJudgments: [
          { source: 'runbooks/deploy.md', relevance: 3 },
          { source: 'runbooks/fallback.md', relevance: 2 },
          { source: 'runbooks/checklist.md', relevance: 1 },
        ],
      }),
      [
        doc('runbooks/fallback.md'),
        doc('runbooks/deploy.md'),
        doc('runbooks/checklist.md'),
      ],
      FRESH,
    );

    const dcg = 3 + (7 / Math.log2(3)) + (1 / Math.log2(4));
    const idealDcg = 7 + (3 / Math.log2(3)) + (1 / Math.log2(4));
    expect(result.rankedMetrics?.ndcgAt10).toBeCloseTo(dcg / idealDcg, 6);
    expect(result.rankedMetrics?.mrrAt10).toBe(1);
    expect(result.rankedMetrics?.map).toBe(1);
  });
});

describe('summarizeRetrievalEval', () => {
  it('aggregates ranked metrics across judged cases and omits them when absent', () => {
    const judged = evaluateRetrievalCase(
      fixtureCase({
        k: 2,
        relevanceJudgments: [{ source: 'runbooks/deploy.md', relevance: 1 }],
      }),
      [doc('runbooks/deploy.md'), doc('notes/other.md')],
      FRESH,
    );
    const unjudged = evaluateRetrievalCase(fixtureCase(), [doc('notes/other.md')], FRESH);

    const report = summarizeRetrievalEval([judged, unjudged]);

    expect(report.rankedMetrics).toEqual({
      judgedCaseCount: 1,
      ndcgAt10: 1,
      mrrAt10: 1,
      recallAtK: 1,
      precisionAtK: 0.5,
      map: 1,
      mapAtK: 1,
      hitRate: 1,
    });
    expect(report.cases[1].rankedMetrics).toBeUndefined();
  });

  it('prints ranked metrics in markdown when judgments are present', () => {
    const result = evaluateRetrievalCase(
      fixtureCase({
        k: 2,
        relevanceJudgments: [{ source: 'runbooks/deploy.md', relevance: 1 }],
      }),
      [doc('runbooks/deploy.md'), doc('notes/other.md')],
      FRESH,
    );

    const markdown = formatRetrievalEvalMarkdown(summarizeRetrievalEval([result]));

    expect(markdown).toContain('ranked: nDCG@10=1.000');
    expect(markdown).toContain('Ranked metrics: nDCG@10=1.000');
  });

  it('includes ranked metrics in JSON output when judgments are present', () => {
    const result = evaluateRetrievalCase(
      fixtureCase({
        k: 2,
        relevanceJudgments: [{ source: 'runbooks/deploy.md', relevance: 1 }],
      }),
      [doc('runbooks/deploy.md'), doc('notes/other.md')],
      FRESH,
    );

    expect(toJsonReport(summarizeRetrievalEval([result]))).toMatchObject({
      ranked_metrics: {
        judged_case_count: 1,
        ndcg_at_10: 1,
        mrr_at_10: 1,
        recall_at_k: 1,
        precision_at_k: 0.5,
        map: 1,
        map_at_k: 1,
        hit_rate: 1,
      },
      cases: [{
        ranked_metrics: {
          k: 2,
          judged_relevant_count: 1,
          retrieved_relevant_count: 1,
          ndcg_at_10: 1,
          mrr_at_10: 1,
          recall_at_k: 1,
          precision_at_k: 0.5,
          map: 1,
          map_at_k: 1,
          hit_rate: 1,
        },
      }],
    });
  });
});
