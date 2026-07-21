// Property tests for relevance-judge fail-safes (issue #911).
//
// The parser's load-bearing safety invariant: *no candidate is ever lost*.
// Whatever adversarial / partial / malformed JSON shape the model returns
// (as long as `overall` is parseable so `normalizeJudgeResponse` does not
// throw), every input candidate id appears exactly once in the output
// verdict list, and every decision is either `keep` or `drop`.
//
// A second property pins the hallucinated-drop guard: when a verdict says
// `drop` but the reason shares no content terms with the candidate, the
// output decision must be `keep` with `downgraded: true`.

import { describe, expect, it } from '@jest/globals';
import * as fc from 'fast-check';
import {
  normalizeJudgeResponse,
  type RelevanceJudgeCandidate,
  type RelevanceJudgeDecision,
  type RelevanceJudgeOverall,
} from '../relevance-judge.js';

const NUM_RUNS = process.env.KB_PROPERTY_DEEP === '1' ? 1000 : 100;

const OVERALLS: RelevanceJudgeOverall[] = [
  'relevant',
  'partial',
  'no-relevant-context',
];

// Content terms are drawn from a closed vocabulary so we can control whether
// a drop-reason overlaps a candidate (for the downgrade property). Tokens are
// ≥3 chars and not in the judge's stop-word set.
const CONTENT_WORDS = [
  'postgres',
  'migration',
  'worker',
  'deploy',
  'redis',
  'cache',
  'reload',
  'embedding',
  'huggingface',
  'index',
  'vector',
  'document',
] as const;

const NON_OVERLAP_WORDS = [
  'kubernetes',
  'quantum',
  'entanglement',
  'spaceship',
  'xylophone',
  'jazz',
] as const;

const idArb = fc.stringMatching(/^c[a-z0-9]{2,8}$/);

const contentArb = fc
  .array(fc.constantFrom(...CONTENT_WORDS), { minLength: 3, maxLength: 8 })
  .map((words) => words.join(' '));

const candidateArb: fc.Arbitrary<RelevanceJudgeCandidate> = fc.record({
  id: idArb,
  content: contentArb,
  metadata: fc.constant({ source: '/kb/fixture.md' }),
});

const candidatesArb = fc
  .uniqueArray(candidateArb, {
    minLength: 1,
    maxLength: 6,
    selector: (c) => c.id,
  });

const decisionArb = fc.constantFrom<RelevanceJudgeDecision | string>(
  'keep',
  'drop',
  'KEEP',
  'maybe',
  '',
);

const reasonArb = fc.oneof(
  fc.constantFrom(...CONTENT_WORDS).map((w) => `${w} related`),
  fc.constantFrom(...NON_OVERLAP_WORDS).map((w) => `${w} unrelated`),
  fc.constant(''),
  fc.constant('no specific reason'),
);

/** Build a verdict-row arbitrary biased toward the given candidate ids. */
function rawVerdictsFor(candidates: RelevanceJudgeCandidate[]) {
  const knownIdArb = fc.constantFrom(...candidates.map((c) => c.id));
  const wellFormed = fc.record({
    id: fc.oneof(
      // Prefer real candidate ids so keep/drop/duplicate paths fire often
      { arbitrary: knownIdArb, weight: 4 },
      { arbitrary: idArb, weight: 1 },
    ),
    decision: decisionArb,
    reason: reasonArb,
  });
  // Missing fields / wrong types — parser must skip, not throw.
  const junk = fc.constantFrom(
    null,
    42,
    'not-an-object',
    { decision: 'keep' },
    { id: 123, decision: 'drop' },
  );
  return fc.array(fc.oneof(wellFormed, junk), { minLength: 0, maxLength: 12 });
}

function wrapPayload(
  body: object,
  wrapping: 'clean' | 'fenced' | 'fenced-json' | 'garbage',
): string {
  const json = JSON.stringify(body);
  switch (wrapping) {
    case 'fenced':
      return `\`\`\`\n${json}\n\`\`\``;
    case 'fenced-json':
      return `\`\`\`json\n${json}\n\`\`\``;
    case 'garbage':
      return `Here is the answer:\n${json}\nThanks!`;
    default:
      return json;
  }
}

const wrappingArb = fc.constantFrom(
  'clean' as const,
  'fenced' as const,
  'fenced-json' as const,
  'garbage' as const,
);

describe('normalizeJudgeResponse — no candidate is ever lost (issue #911)', () => {
  it('returns exactly one verdict per input candidate for any parseable payload', () => {
    fc.assert(
      fc.property(
        candidatesArb.chain((candidates) =>
          fc.tuple(
            fc.constant(candidates),
            rawVerdictsFor(candidates),
            fc.constantFrom(...OVERALLS),
            wrappingArb,
          ),
        ),
        ([candidates, rawVerdicts, overall, wrapping]) => {
          // Inject an unknown id so the parser must ignore it without
          // dropping real candidates.
          const withUnknown = [
            ...rawVerdicts,
            { id: 'unknown-zz', decision: 'drop', reason: 'xylophone jazz' },
          ];
          const content = wrapPayload(
            { overall, verdicts: withUnknown },
            wrapping,
          );

          const result = normalizeJudgeResponse(
            { content, model: 'prop-test' },
            candidates,
          );

          const inputIds = candidates.map((c) => c.id).sort();
          const outputIds = result.verdicts.map((v) => v.id).sort();
          expect(outputIds).toEqual(inputIds);

          for (const verdict of result.verdicts) {
            expect(verdict.decision === 'keep' || verdict.decision === 'drop').toBe(true);
            expect(typeof verdict.reason).toBe('string');
            expect(verdict.reason.length).toBeGreaterThan(0);
          }

          expect(OVERALLS).toContain(result.overall);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('fills keep verdicts when the model omits the verdicts key entirely', () => {
    fc.assert(
      fc.property(candidatesArb, fc.constantFrom(...OVERALLS), wrappingArb, (
        candidates,
        overall,
        wrapping,
      ) => {
        const content = wrapPayload({ overall }, wrapping);
        const result = normalizeJudgeResponse(
          { content, model: null },
          candidates,
        );
        expect(result.verdicts).toHaveLength(candidates.length);
        for (const verdict of result.verdicts) {
          expect(verdict.decision).toBe('keep');
          expect(verdict.reason).toBe('missing judge verdict');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('normalizeJudgeResponse — hallucinated drop downgrade (issue #911)', () => {
  it('downgrades drop when reason shares no content terms with the candidate', () => {
    fc.assert(
      fc.property(
        candidatesArb,
        fc.array(fc.constantFrom(...NON_OVERLAP_WORDS), {
          minLength: 1,
          maxLength: 4,
        }),
        (candidates, reasonWords) => {
          // Reason built only from NON_OVERLAP_WORDS → no term can appear in
          // candidate content (which uses CONTENT_WORDS exclusively).
          const reason = reasonWords.join(' ');
          const verdicts = candidates.map((c) => ({
            id: c.id,
            decision: 'drop' as const,
            reason,
          }));
          const content = JSON.stringify({
            overall: 'no-relevant-context',
            verdicts,
          });

          const result = normalizeJudgeResponse(
            { content, model: 'prop-test' },
            candidates,
          );

          expect(result.verdicts).toHaveLength(candidates.length);
          for (const verdict of result.verdicts) {
            expect(verdict.decision).toBe('keep');
            expect(verdict.downgraded).toBe(true);
            expect(verdict.reason).toBe(reason);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('preserves drop when at least one reason term appears in the candidate', () => {
    fc.assert(
      fc.property(candidatesArb, (candidates) => {
        // Build a reason that reuses the first content token of each candidate
        // so the overlap check succeeds and the drop is legitimate.
        const verdicts = candidates.map((c) => {
          const firstTerm = c.content.split(/\s+/)[0] ?? 'postgres';
          return {
            id: c.id,
            decision: 'drop' as const,
            reason: `${firstTerm} only`,
          };
        });
        const content = JSON.stringify({
          overall: 'partial',
          verdicts,
        });

        const result = normalizeJudgeResponse(
          { content, model: 'prop-test' },
          candidates,
        );

        for (const verdict of result.verdicts) {
          expect(verdict.decision).toBe('drop');
          expect(verdict.downgraded).toBeUndefined();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
