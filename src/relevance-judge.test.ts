// Unit tests for relevance-judge JSON parsing and fail-safes (issue #911).
//
// `relevance-gate.test.ts` stubs the judge endpoint and exercises gate
// orchestration; this suite drives `normalizeJudgeResponse` with real /
// adversarial payloads so the parser, drop→keep downgrade, and no-loss
// guarantee are covered directly. Fixtures are synthetic — no provider
// secrets, no live LLM calls.

import { describe, expect, it } from '@jest/globals';
import {
  normalizeJudgeResponse,
  RelevanceJudgeError,
  type RelevanceJudgeCandidate,
} from './relevance-judge.js';

function candidate(
  id: string,
  content: string,
  metadata: Record<string, unknown> = { source: '/kb/note.md' },
): RelevanceJudgeCandidate {
  return { id, content, metadata };
}

function response(content: string, model: string | null = 'test-judge') {
  return { content, model };
}

const CAND_A = candidate(
  'cand-a',
  'Deploy the worker after the postgres migration completes successfully.',
);
const CAND_B = candidate(
  'cand-b',
  'Redis cache invalidation runs on every config reload.',
);
const CAND_C = candidate(
  'cand-c',
  'The embedding provider default is huggingface for local indexes.',
);

describe('normalizeJudgeResponse — JSON salvage', () => {
  it('parses clean JSON with keep/drop verdicts', () => {
    const content = JSON.stringify({
      overall: 'partial',
      verdicts: [
        { id: 'cand-a', decision: 'keep', reason: 'covers postgres migration' },
        { id: 'cand-b', decision: 'drop', reason: 'redis cache unrelated' },
      ],
    });

    const result = normalizeJudgeResponse(response(content), [CAND_A, CAND_B]);

    expect(result.overall).toBe('partial');
    expect(result.model).toBe('test-judge');
    expect(result.rawContent).toBe(content);
    expect(result.verdicts).toEqual([
      { id: 'cand-a', decision: 'keep', reason: 'covers postgres migration' },
      // "redis" and "cache" both appear in cand-b content → legitimate drop
      { id: 'cand-b', decision: 'drop', reason: 'redis cache unrelated' },
    ]);
  });

  it('parses markdown-fenced JSON (```json … ```)', () => {
    const payload = {
      overall: 'relevant',
      verdicts: [{ id: 'cand-a', decision: 'keep', reason: 'postgres migration steps' }],
    };
    const fenced = `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;

    const result = normalizeJudgeResponse(response(fenced), [CAND_A]);

    expect(result.overall).toBe('relevant');
    expect(result.verdicts).toEqual([
      { id: 'cand-a', decision: 'keep', reason: 'postgres migration steps' },
    ]);
  });

  it('parses plain markdown fence without language tag', () => {
    const payload = {
      overall: 'no-relevant-context',
      verdicts: [{ id: 'cand-a', decision: 'drop', reason: 'postgres migration absent here' }],
    };
    // reason overlaps "postgres"/"migration" from cand-a → legitimate drop
    const fenced = `\`\`\`\n${JSON.stringify(payload)}\n\`\`\``;

    const result = normalizeJudgeResponse(response(fenced), [CAND_A]);

    expect(result.overall).toBe('no-relevant-context');
    expect(result.verdicts).toEqual([
      { id: 'cand-a', decision: 'drop', reason: 'postgres migration absent here' },
    ]);
  });

  it('salvages a JSON object wrapped in garbage prose', () => {
    const payload = {
      overall: 'partial',
      verdicts: [{ id: 'cand-b', decision: 'keep', reason: 'redis cache reload' }],
    };
    const wrapped = `Sure, here is my judgment:\n${JSON.stringify(payload)}\nHope that helps!`;

    const result = normalizeJudgeResponse(response(wrapped), [CAND_B]);

    expect(result.overall).toBe('partial');
    expect(result.verdicts).toEqual([
      { id: 'cand-b', decision: 'keep', reason: 'redis cache reload' },
    ]);
  });

  it('throws RelevanceJudgeError when content is not valid JSON and cannot be repaired', () => {
    expect(() => normalizeJudgeResponse(response('not json at all'), [CAND_A])).toThrow(
      RelevanceJudgeError,
    );
    expect(() => normalizeJudgeResponse(response('not json at all'), [CAND_A])).toThrow(
      /not valid JSON/,
    );
  });

  it('throws RelevanceJudgeError when extracted braces do not form valid JSON', () => {
    // extractFirstJsonObject finds {…} but the slice is still unparseable
    expect(() =>
      normalizeJudgeResponse(response('prefix { overall: relevant, broken } suffix'), [CAND_A]),
    ).toThrow(RelevanceJudgeError);
    expect(() =>
      normalizeJudgeResponse(response('prefix { overall: relevant, broken } suffix'), [CAND_A]),
    ).toThrow(/repair failed/);
  });

  it('throws RelevanceJudgeError on malformed overall values', () => {
    const badOveralls = ['', 'maybe', 'RELEVANT', 'no_relevant_context', 42, null, true];

    for (const overall of badOveralls) {
      const content = JSON.stringify({
        overall,
        verdicts: [{ id: 'cand-a', decision: 'keep', reason: 'ok' }],
      });
      expect(() => normalizeJudgeResponse(response(content), [CAND_A])).toThrow(
        RelevanceJudgeError,
      );
      expect(() => normalizeJudgeResponse(response(content), [CAND_A])).toThrow(
        /invalid overall verdict/,
      );
    }
  });

  it('throws when overall key is missing', () => {
    const content = JSON.stringify({
      verdicts: [{ id: 'cand-a', decision: 'keep', reason: 'ok' }],
    });
    expect(() => normalizeJudgeResponse(response(content), [CAND_A])).toThrow(
      /invalid overall verdict/,
    );
  });
});

describe('normalizeJudgeResponse — drop→keep downgrade (hallucinated drop guard)', () => {
  it('downgrades drop when reason has no lexical overlap with the candidate', () => {
    // Reason talks about "kubernetes pods" — terms absent from cand-a content
    const content = JSON.stringify({
      overall: 'partial',
      verdicts: [
        { id: 'cand-a', decision: 'drop', reason: 'kubernetes pods unrelated' },
      ],
    });

    const result = normalizeJudgeResponse(response(content), [CAND_A]);

    expect(result.verdicts).toEqual([
      {
        id: 'cand-a',
        decision: 'keep',
        reason: 'kubernetes pods unrelated',
        downgraded: true,
      },
    ]);
  });

  it('keeps a legitimate drop when reason terms appear in the candidate', () => {
    // cand-b content: "Redis cache invalidation runs on every config reload."
    const content = JSON.stringify({
      overall: 'partial',
      verdicts: [
        { id: 'cand-b', decision: 'drop', reason: 'redis cache topic only' },
      ],
    });

    const result = normalizeJudgeResponse(response(content), [CAND_B]);

    expect(result.verdicts).toEqual([
      { id: 'cand-b', decision: 'drop', reason: 'redis cache topic only' },
    ]);
    expect(result.verdicts[0].downgraded).toBeUndefined();
  });

  it('never downgrades an explicit keep', () => {
    const content = JSON.stringify({
      overall: 'relevant',
      verdicts: [
        { id: 'cand-a', decision: 'keep', reason: 'totally unrelated gibberish xyzzy' },
      ],
    });

    const result = normalizeJudgeResponse(response(content), [CAND_A]);

    expect(result.verdicts).toEqual([
      { id: 'cand-a', decision: 'keep', reason: 'totally unrelated gibberish xyzzy' },
    ]);
    expect(result.verdicts[0].downgraded).toBeUndefined();
  });

  it('downgrades drop when reason only yields stop-words or short tokens', () => {
    // "after with that" → all stop words; "to be" → tokens < 3 chars. Neither
    // produces a content-term, so the hallucinated-drop guard must fire.
    for (const reason of ['after with that', 'to be or of']) {
      const content = JSON.stringify({
        overall: 'partial',
        verdicts: [{ id: 'cand-a', decision: 'drop', reason }],
      });
      const result = normalizeJudgeResponse(response(content), [CAND_A]);
      expect(result.verdicts).toEqual([
        { id: 'cand-a', decision: 'keep', reason, downgraded: true },
      ]);
    }
  });
});

describe('normalizeJudgeResponse — no-loss invariant (missing verdicts)', () => {
  it('re-adds candidates with no verdict as keep', () => {
    const content = JSON.stringify({
      overall: 'partial',
      verdicts: [
        { id: 'cand-a', decision: 'keep', reason: 'postgres migration' },
        // cand-b and cand-c omitted
      ],
    });

    const result = normalizeJudgeResponse(response(content), [CAND_A, CAND_B, CAND_C]);

    expect(result.verdicts.map((v) => v.id).sort()).toEqual(
      ['cand-a', 'cand-b', 'cand-c'].sort(),
    );
    expect(result.verdicts.find((v) => v.id === 'cand-b')).toEqual({
      id: 'cand-b',
      decision: 'keep',
      reason: 'missing judge verdict',
    });
    expect(result.verdicts.find((v) => v.id === 'cand-c')).toEqual({
      id: 'cand-c',
      decision: 'keep',
      reason: 'missing judge verdict',
    });
  });

  it('fills every candidate when verdicts array is empty or missing', () => {
    for (const body of [{ overall: 'relevant' }, { overall: 'relevant', verdicts: [] }]) {
      const result = normalizeJudgeResponse(
        response(JSON.stringify(body)),
        [CAND_A, CAND_B],
      );
      expect(result.verdicts).toEqual([
        { id: 'cand-a', decision: 'keep', reason: 'missing judge verdict' },
        { id: 'cand-b', decision: 'keep', reason: 'missing judge verdict' },
      ]);
    }
  });

  it('ignores unknown ids, non-objects, and duplicate verdicts', () => {
    const content = JSON.stringify({
      overall: 'partial',
      verdicts: [
        null,
        42,
        'skip-me',
        { id: 'unknown-id', decision: 'drop', reason: 'not a candidate' },
        { decision: 'keep', reason: 'missing id field' },
        { id: 'cand-a', decision: 'keep', reason: 'first keep' },
        { id: 'cand-a', decision: 'drop', reason: 'duplicate ignored' },
      ],
    });

    const result = normalizeJudgeResponse(response(content), [CAND_A, CAND_B]);

    expect(result.verdicts).toEqual([
      { id: 'cand-a', decision: 'keep', reason: 'first keep' },
      { id: 'cand-b', decision: 'keep', reason: 'missing judge verdict' },
    ]);
  });

  it('defaults non-drop decisions to keep and empty reasons to a placeholder', () => {
    const content = JSON.stringify({
      overall: 'relevant',
      verdicts: [
        { id: 'cand-a', decision: 'maybe', reason: '' },
        { id: 'cand-b', decision: 'KEEP', reason: '   ' },
        { id: 'cand-c', decision: 'drop' /* reason missing */ },
      ],
    });

    const result = normalizeJudgeResponse(response(content), [CAND_A, CAND_B, CAND_C]);

    // non-'drop' decisions become keep; empty/missing reason → 'no specific reason'
    // drop with no overlapping reason (placeholder) is also downgraded to keep
    expect(result.verdicts).toEqual([
      { id: 'cand-a', decision: 'keep', reason: 'no specific reason' },
      { id: 'cand-b', decision: 'keep', reason: 'no specific reason' },
      {
        id: 'cand-c',
        decision: 'keep',
        reason: 'no specific reason',
        downgraded: true,
      },
    ]);
  });
});

describe('normalizeJudgeResponse — tabulated payload matrix', () => {
  it.each([
    {
      name: 'clean keep/drop',
      content: JSON.stringify({
        overall: 'partial',
        verdicts: [
          { id: 'cand-a', decision: 'keep', reason: 'postgres migration' },
          { id: 'cand-b', decision: 'drop', reason: 'redis cache only' },
        ],
      }),
      candidates: [CAND_A, CAND_B],
      expectedOverall: 'partial' as const,
      expected: [
        { id: 'cand-a', decision: 'keep' as const, reason: 'postgres migration' },
        { id: 'cand-b', decision: 'drop' as const, reason: 'redis cache only' },
      ],
    },
    {
      name: 'fenced JSON with hallucinated drop',
      content: '```json\n'
        + JSON.stringify({
          overall: 'no-relevant-context',
          verdicts: [
            { id: 'cand-a', decision: 'drop', reason: 'quantum entanglement theory' },
          ],
        })
        + '\n```',
      candidates: [CAND_A],
      expectedOverall: 'no-relevant-context' as const,
      expected: [
        {
          id: 'cand-a',
          decision: 'keep' as const,
          reason: 'quantum entanglement theory',
          downgraded: true,
        },
      ],
    },
    {
      name: 'garbage-wrapped + missing sibling verdict',
      content: `Here you go: ${JSON.stringify({
        overall: 'relevant',
        verdicts: [{ id: 'cand-a', decision: 'keep', reason: 'worker deploy' }],
      })} // end`,
      candidates: [CAND_A, CAND_B],
      expectedOverall: 'relevant' as const,
      expected: [
        { id: 'cand-a', decision: 'keep' as const, reason: 'worker deploy' },
        { id: 'cand-b', decision: 'keep' as const, reason: 'missing judge verdict' },
      ],
    },
  ])('$name', ({ content, candidates, expectedOverall, expected }) => {
    const result = normalizeJudgeResponse(response(content), candidates);
    expect(result.overall).toBe(expectedOverall);
    expect(result.verdicts).toEqual(expected);
  });
});
