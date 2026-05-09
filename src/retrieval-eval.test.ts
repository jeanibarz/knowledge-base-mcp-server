import { describe, expect, it } from '@jest/globals';
import type { ScoredDocument } from './formatter.js';
import type { Staleness } from './cli-search.js';
import {
  evaluateRetrievalCase,
  normalizeRetrievalEvalFixture,
  retrievalEvalExitCode,
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
    stalePolicy: 'fresh',
    ...overrides,
  };
}

describe('normalizeRetrievalEvalFixture', () => {
  it('normalizes fixture cases with source, metadata, duplicate, gate, and stale policy fields', () => {
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
      maxDuplicateGroups: 1,
      stalePolicy: 'fresh',
    });
    expect(fixture.cases[0].expectedMetadata).toEqual([
      { path: 'frontmatter.status', equals: 'approved' },
    ]);
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
});
