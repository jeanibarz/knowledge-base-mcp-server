import { describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as path from 'path';
import yaml from 'js-yaml';
import { parseEvalArgs, toJsonReport } from './cli-eval.js';
import type { ScoredDocument } from './formatter.js';
import type { Staleness } from './search-core.js';
import {
  buildRetrievalEvalScaffoldFixture,
  evaluateRetrievalCase,
  formatRetrievalEvalMarkdown,
  normalizeRetrievalEvalFixture,
  retrieveForRetrievalEvalCase,
  retrievalEvalExitCode,
  resolveRetrievalEvalMode,
  summarizeRetrievalEval,
  type RetrievalEvalCase,
} from './retrieval-eval.js';
import { setRerankerFactoryForTests } from './reranker.js';
import * as hybridRetrieval from './hybrid-retrieval.js';
import { LexicalIndex } from './lexical-index.js';

const FRESH: Staleness = { indexMtime: '2026-05-09T08:00:00.000Z', modifiedFiles: 0, newFiles: 0 };
const STALE: Staleness = { indexMtime: '2026-05-09T08:00:00.000Z', modifiedFiles: 1, newFiles: 0 };

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

  it('normalizes optional expected_gate_verdict with judge-suggested unverified provenance', () => {
    const fixture = normalizeRetrievalEvalFixture({
      cases: [{
        query: 'deployment notes',
        expected_gate_verdict: {
          state: 'no-relevant-context',
          provenance: 'judge-suggested',
          verification: 'unverified',
        },
      }],
    });

    expect(fixture.cases[0].expectedGateVerdict).toEqual({
      state: 'no-relevant-context',
      provenance: 'judge-suggested',
      verification: 'unverified',
    });
  });

  it('rejects invalid expected_gate_verdict states', () => {
    expect(() => normalizeRetrievalEvalFixture({
      cases: [{
        query: 'deployment notes',
        expected_gate_verdict: 'maybe',
      }],
    })).toThrow('expected_gate_verdict must be "bypassed", "empty-index", "injected", or "no-relevant-context"');
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

  it('parses scaffold query and narrow scaffold options', () => {
    expect(parseEvalArgs([
      'scaffold',
      'rollback procedure',
      '--kb=ops',
      '--k=5',
      '--mode=hybrid',
      '--required-sources=2',
    ])).toMatchObject({
      action: 'scaffold',
      query: 'rollback procedure',
      kb: 'ops',
      k: 5,
      mode: 'hybrid',
      requiredSources: 2,
    });
  });

  it('rejects invalid retrieval modes', () => {
    expect(() => parseEvalArgs(['fixture.yml', '--mode=sparse'])).toThrow(
      "invalid --mode: --mode=sparse (expected 'dense', 'lexical', 'hybrid', or 'auto')",
    );
  });

  it('keeps scaffold-only flags out of fixture runner mode', () => {
    expect(() => parseEvalArgs(['fixture.yml', '--kb=ops'])).toThrow(
      '--kb=<name> is only supported for scaffold',
    );
    expect(() => parseEvalArgs(['scaffold', 'query', '--format=json'])).toThrow(
      '--format is not supported for scaffold',
    );
  });
});

describe('buildRetrievalEvalScaffoldFixture', () => {
  it('emits starter YAML that normalizes as a retrieval eval fixture', () => {
    const scaffold = buildRetrievalEvalScaffoldFixture([
      doc('/tmp/kbs/ops/runbooks/deploy.md', 0.1, {
        relativePath: 'runbooks/deploy.md',
        frontmatter: { status: 'approved', owner: 'search-platform' },
      }),
      doc('/tmp/kbs/ops/runbooks/deploy.md', 0.2, {
        relativePath: 'runbooks/deploy.md',
      }),
      doc('/tmp/kbs/ops/runbooks/rollback.md', 0.3, {
        relativePath: 'runbooks/rollback.md',
        frontmatter: { status: 'draft' },
      }),
    ], {
      query: 'rollback procedure',
      kb: 'ops',
      k: 5,
      mode: 'hybrid',
      maxRequiredSources: 2,
      staleness: FRESH,
    });
    const rawYaml = yaml.dump(scaffold, { lineWidth: -1, noRefs: true, sortKeys: false });
    const normalized = normalizeRetrievalEvalFixture(yaml.load(rawYaml));

    expect(scaffold).toEqual({
      gate: false,
      cases: [{
        name: 'scaffold - rollback procedure',
        query: 'rollback procedure',
        kb: 'ops',
        k: 5,
        mode: 'hybrid',
        required_sources: [
          'runbooks/deploy.md',
          'runbooks/rollback.md',
        ],
        expected_metadata: {
          'frontmatter.status': 'approved',
          'frontmatter.owner': 'search-platform',
        },
        stale_policy: 'fresh',
      }],
    });
    expect(normalized.cases[0]).toMatchObject({
      query: 'rollback procedure',
      requiredSources: ['runbooks/deploy.md', 'runbooks/rollback.md'],
      expectedMetadata: [
        { path: 'frontmatter.status', equals: 'approved' },
        { path: 'frontmatter.owner', equals: 'search-platform' },
      ],
      stalePolicy: 'fresh',
    });
  });

  it('uses allow_stale for scaffold output when the live index is stale', () => {
    const scaffold = buildRetrievalEvalScaffoldFixture([doc('notes/drift.md')], {
      query: 'drift',
      k: 10,
      staleness: STALE,
    });

    expect(scaffold.cases[0].stale_policy).toBe('allow_stale');
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

describe('retrieveForRetrievalEvalCase', () => {
  it('serializes concurrent default lexical refresh/save operations', async () => {
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const holdWrite = async (): Promise<void> => {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeWrites -= 1;
    };
    const lexicalIndex = {
      numFiles: jest.fn(() => 0),
      refresh: jest.fn(async () => {
        await holdWrite();
        return { added: 0, updated: 1, removed: 0, failed: 0, totalFiles: 1, totalChunks: 1 };
      }),
      save: jest.fn(async () => holdWrite()),
      query: jest.fn(async () => []),
    } as unknown as LexicalIndex;
    const listLexicalKbs = jest.spyOn(hybridRetrieval, 'listLexicalKbs').mockResolvedValue([
      { kbName: 'eval-lock-853', kbPath: '/kb/eval-lock-853' },
    ]);
    const load = jest.spyOn(LexicalIndex, 'load').mockResolvedValue(lexicalIndex);

    try {
      const context = {
        defaultK: 10,
        defaultThreshold: 2,
        manager: { similaritySearch: jest.fn(async () => []) },
      };
      await Promise.all([
        retrieveForRetrievalEvalCase(fixtureCase({ query: 'q' }), context, 'lexical'),
        retrieveForRetrievalEvalCase(fixtureCase({ query: 'q' }), context, 'lexical'),
      ]);
    } finally {
      load.mockRestore();
      listLexicalKbs.mockRestore();
    }

    expect(maxActiveWrites).toBe(1);
    expect(lexicalIndex.refresh).toHaveBeenCalledTimes(2);
    expect(lexicalIndex.save).toHaveBeenCalledTimes(2);
  });

  it('reranks the hybrid runtime path before returning eval results', async () => {
    const previousRerank = process.env.KB_RERANK;
    const previousTopN = process.env.KB_RERANK_TOP_N;
    process.env.KB_RERANK = 'on';
    process.env.KB_RERANK_TOP_N = '2';
    const restoreFactory = setRerankerFactoryForTests(async () => ({
      id: 'stub-reranker',
      rerank: async (_query, candidates) =>
        candidates.map((candidate) => (candidate.includes('winner') ? 5 : 0)),
    }));

    try {
      const result = await retrieveForRetrievalEvalCase(
        fixtureCase({ k: 1, query: 'deployment winner' }),
        {
          defaultK: 10,
          defaultThreshold: 2,
          manager: {
            similaritySearch: async () => [
              {
                pageContent: 'content from /kb/dense-loser.md',
                metadata: { source: '/kb/dense-loser.md', relativePath: '/kb/dense-loser.md' },
                score: 0.1,
              },
            ],
          },
          retrieveLexical: async () => [
            doc('/kb/lexical-winner.md', 10),
          ],
        },
        'hybrid',
      );

      expect(result.effectiveMode).toBe('hybrid');
      expect(result.results).toHaveLength(1);
      expect(result.results[0].metadata.source).toBe('/kb/lexical-winner.md');
      expect(result.results[0].rerankScore).toBe(5);
    } finally {
      restoreFactory();
      if (previousRerank === undefined) delete process.env.KB_RERANK;
      else process.env.KB_RERANK = previousRerank;
      if (previousTopN === undefined) delete process.env.KB_RERANK_TOP_N;
      else process.env.KB_RERANK_TOP_N = previousTopN;
    }
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

  it('warns when an expected gate verdict cannot be checked', () => {
    const result = evaluateRetrievalCase(
      fixtureCase({
        expectedGateVerdict: {
          state: 'no-relevant-context',
          provenance: 'judge-suggested',
          verification: 'unverified',
        },
      }),
      [],
      FRESH,
    );

    expect(result.warnings).toEqual([
      'expected gate verdict no-relevant-context was not checked; retrieval path did not report a gate verdict',
      'expected gate verdict is judge-suggested and unverified',
    ]);
    expect(summarizeRetrievalEval([result]).expectedGateVerdictWarnings).toBe(1);
  });

  it('compares expected gate verdicts against reported retrieval results', () => {
    const matching = evaluateRetrievalCase(
      fixtureCase({ expectedGateVerdict: { state: 'injected' } }),
      [],
      FRESH,
      false,
      {
        requestedMode: 'dense',
        effectiveMode: 'dense',
        gateVerdictState: 'injected',
      },
    );
    const mismatched = evaluateRetrievalCase(
      fixtureCase({ expectedGateVerdict: { state: 'no-relevant-context' } }),
      [],
      FRESH,
      false,
      {
        requestedMode: 'dense',
        effectiveMode: 'dense',
        gateVerdictState: 'injected',
      },
    );

    expect(matching.warnings).toEqual([]);
    expect(mismatched.warnings).toContain('expected gate verdict no-relevant-context, got injected');
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

  it('reports source crowding metrics for duplicate chunks from one source', () => {
    const result = evaluateRetrievalCase(
      fixtureCase({ k: 4, maxDuplicateGroups: 1 }),
      [
        doc('runbooks/deploy.md'),
        doc('runbooks/deploy.md'),
        doc('runbooks/deploy.md'),
        doc('runbooks/fallback.md'),
      ],
      FRESH,
    );

    expect(result.passed).toBe(true);
    expect(result.duplicateGroups).toBe(1);
    expect(result.diversityMetrics.source).toEqual({
      k: 4,
      resultCount: 4,
      uniqueSourceCountAtK: 2,
      duplicateSourceGroupsAtK: 1,
      maxSourceShareAtK: 0.75,
    });
  });

  it('rewards diversified relevant sources in source diversity metrics', () => {
    const result = evaluateRetrievalCase(
      fixtureCase({
        k: 4,
        relevanceJudgments: [
          { source: 'runbooks/deploy.md', relevance: 1 },
          { source: 'runbooks/fallback.md', relevance: 1 },
          { source: 'runbooks/checklist.md', relevance: 1 },
        ],
      }),
      [
        doc('runbooks/deploy.md'),
        doc('runbooks/fallback.md'),
        doc('runbooks/checklist.md'),
        doc('notes/other.md'),
      ],
      FRESH,
    );

    expect(result.diversityMetrics.source.uniqueSourceCountAtK).toBe(4);
    expect(result.diversityMetrics.source.maxSourceShareAtK).toBe(0.25);
    expect(result.rankedMetrics?.recallAtK).toBe(1);
  });

  it('computes intent-aware diversity when judgments define groups', () => {
    const fixture = normalizeRetrievalEvalFixture({
      cases: [{
        query: 'deployment readiness',
        k: 4,
        relevant_sources: [
          { source: 'runbooks/deploy.md', relevance: 3, intent: 'procedure' },
          { source: 'runbooks/checklist.md', relevance: 2, groups: ['checklist'] },
          { source: 'runbooks/rollback.md', relevance: 2, intents: ['rollback'] },
        ],
      }],
    });
    const fixtureCaseWithGroups = fixture.cases[0];

    const crowded = evaluateRetrievalCase(
      fixtureCaseWithGroups,
      [
        doc('runbooks/deploy.md'),
        doc('runbooks/deploy.md'),
        doc('runbooks/deploy.md'),
        doc('runbooks/checklist.md'),
      ],
      FRESH,
    );
    const diverse = evaluateRetrievalCase(
      fixtureCaseWithGroups,
      [
        doc('runbooks/deploy.md'),
        doc('runbooks/checklist.md'),
        doc('runbooks/rollback.md'),
        doc('notes/other.md'),
      ],
      FRESH,
    );

    expect(fixtureCaseWithGroups.relevanceJudgments).toEqual([
      { source: 'runbooks/deploy.md', relevance: 3, groups: ['procedure'] },
      { source: 'runbooks/checklist.md', relevance: 2, groups: ['checklist'] },
      { source: 'runbooks/rollback.md', relevance: 2, groups: ['rollback'] },
    ]);
    expect(crowded.diversityMetrics.intent).toMatchObject({
      k: 4,
      groupCount: 3,
      retrievedGroupCountAtK: 2,
      intentRecallAtK: 2 / 3,
    });
    expect(diverse.diversityMetrics.intent).toMatchObject({
      k: 4,
      groupCount: 3,
      retrievedGroupCountAtK: 3,
      intentRecallAtK: 1,
      alphaNdcgAtK: 1,
    });
    expect(crowded.diversityMetrics.intent?.alphaNdcgAtK).toBeLessThan(
      diverse.diversityMetrics.intent?.alphaNdcgAtK ?? 0,
    );
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
    expect(report.diversityMetrics.source).toEqual({
      caseCount: 2,
      uniqueSourceCountAtK: 1.5,
      duplicateSourceGroupsAtK: 0,
      maxSourceShareAtK: 0.75,
    });
    expect(report.cases[1].rankedMetrics).toBeUndefined();
  });

  it('prints ranked and diversity metrics in markdown when judgments are present', () => {
    const result = evaluateRetrievalCase(
      fixtureCase({
        k: 2,
        expectedGateVerdict: {
          state: 'injected',
          provenance: 'human-labeled',
          verification: 'verified',
        },
        relevanceJudgments: [{ source: 'runbooks/deploy.md', relevance: 1 }],
      }),
      [doc('runbooks/deploy.md'), doc('notes/other.md')],
      FRESH,
    );

    const markdown = formatRetrievalEvalMarkdown(summarizeRetrievalEval([result]));

    expect(markdown).toContain('ranked: nDCG@10=1.000');
    expect(markdown).toContain('diversity: unique-source@2=2');
    expect(markdown).toContain('Ranked metrics: nDCG@10=1.000');
    expect(markdown).toContain('Diversity metrics: unique-source@k=2.000');
  });

  it('prints expected gate verdict metadata and warning totals in markdown', () => {
    const result = evaluateRetrievalCase(
      fixtureCase({ expectedGateVerdict: { state: 'no-relevant-context' } }),
      [],
      FRESH,
    );

    const markdown = formatRetrievalEvalMarkdown(summarizeRetrievalEval([result]));

    expect(markdown).toContain('expected gate: no-relevant-context');
    expect(markdown).toContain('1 expected gate warning(s).');
  });

  it('includes ranked and diversity metrics in JSON output when judgments are present', () => {
    const result = evaluateRetrievalCase(
      fixtureCase({
        k: 2,
        expectedGateVerdict: {
          state: 'injected',
          provenance: 'human-labeled',
          verification: 'verified',
        },
        relevanceJudgments: [{ source: 'runbooks/deploy.md', relevance: 1 }],
      }),
      [doc('runbooks/deploy.md'), doc('notes/other.md')],
      FRESH,
    );

    expect(toJsonReport(summarizeRetrievalEval([result]))).toMatchObject({
      diversity_metrics: {
        source: {
          case_count: 1,
          unique_source_count_at_k: 2,
          duplicate_source_groups_at_k: 0,
          max_source_share_at_k: 0.5,
        },
      },
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
        expected_gate_verdict: {
          state: 'injected',
          provenance: 'human-labeled',
          verification: 'verified',
        },
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
        diversity_metrics: {
          source: {
            k: 2,
            result_count: 2,
            unique_source_count_at_k: 2,
            duplicate_source_groups_at_k: 0,
            max_source_share_at_k: 0.5,
          },
        },
      }],
    });
  });
});
