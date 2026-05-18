import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { normalizeGateEvalFixture, type GateEvalAggregate, type GateEvalCase } from './relevance-gate-eval.js';
import {
  analyzeBm25Veto,
  decideGoNoGo,
  effectiveTaskContext,
  formatFloorSweepMarkdown,
  formatPositionSwapMarkdown,
  parseFloorSweepSpec,
  runFloorSweep,
  runPositionSwapProbe,
  type M1RecallSummary,
} from './relevance-gate-m1.js';

const fixture = normalizeGateEvalFixture(
  yaml.load(
    fs.readFileSync(path.join('docs', 'testing', 'fixtures', 'rfc-018-gate-eval', 'queries.yml'), 'utf-8'),
  ),
);

describe('parseFloorSweepSpec', () => {
  it('expands lo:hi:step into an inclusive ascending list', () => {
    const floors = parseFloorSweepSpec('0.80:1.10:0.05');
    expect(floors).toHaveLength(7);
    expect(floors[0]).toBe(0.8);
    expect(floors[6]).toBeCloseTo(1.1);
    expect(floors).toEqual([...floors].sort((a, b) => a - b));
  });

  it('rejects malformed specs', () => {
    expect(() => parseFloorSweepSpec('0.8:1.0')).toThrow(/lo:hi:step/);
    expect(() => parseFloorSweepSpec('0.8:1.0:0')).toThrow(/positive/);
    expect(() => parseFloorSweepSpec('1.0:0.5:0.1')).toThrow(/>= lo/);
    expect(() => parseFloorSweepSpec('a:b:c')).toThrow(/finite/);
  });
});

describe('runFloorSweep against the committed RFC 018 fixture', () => {
  const sweep = runFloorSweep(fixture, parseFloorSweepSpec('0.80:1.10:0.05'));

  it('sweeps every floor', () => {
    expect(sweep.rows).toHaveLength(7);
    expect(sweep.rows[0].floor).toBe(0.8);
    expect(sweep.rows[6].floor).toBeCloseTo(1.1);
  });

  it('shows the answer-present-but-distant class forcing the floor up', () => {
    // The distant answers sit at dense distance 1.05 / 1.07 — a tight floor
    // drops them, so only the loosest floor preserves 100% recall.
    expect(sweep.rows[0].distantAnswerRecall).toBe(0);
    expect(sweep.rows[6].distantAnswerRecall).toBe(1);
    expect(sweep.rows[6].hasAnswerRecall).toBe(1);
    expect(sweep.recommendedFloor).toBeCloseTo(1.1);
  });

  it('shows a tight floor clearing all no-good-answer near-misses', () => {
    expect(sweep.rows[0].noGoodAnswerClearedRate).toBe(1);
    expect(sweep.rows[6].noGoodAnswerClearedRate).toBe(0);
  });

  it('recommends nothing when no swept floor is recall-safe', () => {
    const tight = runFloorSweep(fixture, parseFloorSweepSpec('0.50:0.90:0.10'));
    expect(tight.recommendedFloor).toBeNull();
    expect(tight.rationale).toMatch(/recall/i);
  });
});

describe('analyzeBm25Veto', () => {
  it('reports the lexical-hit distribution of the committed fixture', () => {
    const veto = analyzeBm25Veto(fixture);
    expect(veto.lexicalHitCases).toBe(1);
    expect(veto.lexicalHitNoGoodAnswer).toBe(1);
    expect(veto.lexicalHitHasAnswer).toBe(0);
    expect(veto.vetoBlocksCorrectEmpty).toBe(1);
  });
});

describe('effectiveTaskContext', () => {
  it('passes an authored task_context through unchanged', () => {
    const withCtx = fixture.cases.find((c) => c.taskContext !== undefined) as GateEvalCase;
    expect(effectiveTaskContext(withCtx)).toBe(withCtx.taskContext);
  });

  it('synthesizes a task_context from the query when absent', () => {
    const withoutCtx = fixture.cases.find((c) => c.taskContext === undefined) as GateEvalCase;
    const synthesized = effectiveTaskContext(withoutCtx);
    expect(synthesized).toContain(withoutCtx.query);
    expect(synthesized.split(/\s+/).length).toBeGreaterThanOrEqual(8);
  });
});

describe('decideGoNoGo', () => {
  const agg = (o: Partial<GateEvalAggregate>): GateEvalAggregate =>
    ({ directionalPass: false, noGoodAnswerDelta: 0, hasAnswerDelta: 0, epsilon: 0.1, caseCount: 15, ...o } as GateEvalAggregate);
  const rec = (o: Partial<M1RecallSummary>): M1RecallSummary =>
    ({ hasAnswerTotal: 10, hasAnswerRecalled: 10, distantTotal: 2, distantRecalled: 2, recallRate: 1, distantRecallRate: 1, ...o } as M1RecallSummary);

  it('GO when quality improves and recall is preserved', () => {
    const d = decideGoNoGo(agg({ directionalPass: true, noGoodAnswerDelta: 0.2 }), rec({}));
    expect(d.decision).toBe('go');
    expect(d.answerQualityImproved).toBe(true);
    expect(d.recallPreserved).toBe(true);
  });

  it('CONDITIONAL when quality improves but the gate drops a real answer', () => {
    const d = decideGoNoGo(
      agg({ directionalPass: true, noGoodAnswerDelta: 0.2 }),
      rec({ recallRate: 0.9, distantRecallRate: 0.5 }),
    );
    expect(d.decision).toBe('conditional');
  });

  it('NO-GO when answer quality does not improve', () => {
    const d = decideGoNoGo(agg({ directionalPass: false }), rec({}));
    expect(d.decision).toBe('no-go');
  });
});

// ---------------------------------------------------------------------------
// Position-swap probe — fake judge endpoint
// ---------------------------------------------------------------------------

function judgeJson(overall: string): string {
  return JSON.stringify({
    overall,
    verdicts: [
      { id: 'c1', decision: 'keep', reason: 'mechanism explained here' },
      { id: 'c2', decision: 'keep', reason: 'related supporting material' },
    ],
  });
}

function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], model: 'fake-judge' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const probeCase: GateEvalCase = {
  name: 'probe case',
  kb: 'codeops',
  query: 'how does the mechanism work',
  bucket: 'has-answer',
  fixtureClass: 'standard',
  referenceAnswer: 'It works by the documented mechanism.',
  answerSources: ['codeops/x.md'],
  candidates: [
    { id: 'c1', source: 'codeops/x.md', content: 'The mechanism works by a documented step.', denseDistance: 0.5, lexicalHit: false },
    { id: 'c2', source: 'codeops/z.md', content: 'Unrelated note about other supporting material.', denseDistance: 0.8, lexicalHit: false },
  ],
};

describe('runPositionSwapProbe', () => {
  it('reports no disagreement for an order-stable judge', async () => {
    const fetchImpl = (() => Promise.resolve(chatResponse(judgeJson('relevant')))) as unknown as typeof fetch;
    const probe = await runPositionSwapProbe([probeCase], {
      endpoint: 'http://fake/v1/chat/completions',
      scoreFloor: 0.95,
      floorSweepSpec: '0.80:1.10:0.05',
      fetchImpl,
    });
    expect(probe.scored).toBe(1);
    expect(probe.errors).toBe(0);
    expect(probe.overallDisagreementRate).toBe(0);
    expect(probe.emptyVerdictOrderSensitiveCount).toBe(0);
    expect(probe.recommendation).toMatch(/order-stable/);
  });

  it('flags an order-sensitive empty verdict and recommends the double call', async () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;
      return Promise.resolve(chatResponse(judgeJson(calls === 1 ? 'relevant' : 'no-relevant-context')));
    }) as unknown as typeof fetch;
    const probe = await runPositionSwapProbe([probeCase], {
      endpoint: 'http://fake/v1/chat/completions',
      scoreFloor: 0.95,
      floorSweepSpec: '0.80:1.10:0.05',
      fetchImpl,
    });
    expect(probe.scored).toBe(1);
    expect(probe.overallDisagreementRate).toBe(1);
    expect(probe.emptyVerdictOrderSensitiveCount).toBe(1);
    expect(probe.recommendation).toMatch(/reintroduce/);
  });

  it('counts judge errors without crashing', async () => {
    const fetchImpl = (() => Promise.resolve(chatResponse('not json at all'))) as unknown as typeof fetch;
    const probe = await runPositionSwapProbe([probeCase], {
      endpoint: 'http://fake/v1/chat/completions',
      scoreFloor: 0.95,
      floorSweepSpec: '0.80:1.10:0.05',
      fetchImpl,
    });
    expect(probe.errors).toBe(1);
    expect(probe.scored).toBe(0);
  });
});

describe('M1 report formatters', () => {
  it('renders the floor-sweep table', () => {
    const md = formatFloorSweepMarkdown(runFloorSweep(fixture, parseFloorSweepSpec('0.80:1.10:0.05')));
    expect(md).toContain('| floor | mean kept |');
    expect(md).toMatch(/Recommended/);
  });

  it('renders the position-swap summary', () => {
    const md = formatPositionSwapMarkdown({
      cases: [],
      scored: 0,
      errors: 0,
      overallDisagreementRate: 0,
      keepSetDisagreementRate: 0,
      emptyVerdictOrderSensitiveCount: 0,
      recommendation: 'order-stable',
    });
    expect(md).toContain('disagreement rate');
  });
});
