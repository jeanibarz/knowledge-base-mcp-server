import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import {
  DEFAULT_GATE_SIM_CONFIG,
  aggregateGateEval,
  computeGraderAdmissibility,
  formatGateEvalReportMarkdown,
  gateConfigGuidance,
  normalizeGateEvalFixture,
  normalizeGraderCalibrationFixture,
  outcomeIsCorrect,
  parseGraderVerdict,
  simulateAgentOutcome,
  simulateGate,
  verdictScore,
  type GateEvalCandidate,
  type GateEvalCase,
  type GateEvalCaseResult,
  type GateSimConfig,
} from './relevance-gate-eval.js';

const FIXTURE_DIR = path.join('docs', 'testing', 'fixtures', 'rfc-018-gate-eval');

function candidate(over: Partial<GateEvalCandidate> & { id: string }): GateEvalCandidate {
  return { source: `${over.id}.md`, content: `content ${over.id}`, lexicalHit: false, ...over };
}

const CFG: GateSimConfig = { ...DEFAULT_GATE_SIM_CONFIG };

describe('normalizeGateEvalFixture', () => {
  const minimal = {
    cases: [
      {
        name: 'a', kb: 'k1', query: 'q', bucket: 'has-answer',
        reference_answer: 'r', answer_sources: ['x.md'],
        candidates: [{ id: 'c1', source: 'x.md', content: 'text', dense_distance: 0.5 }],
      },
      {
        name: 'b', kb: 'k2', query: 'q', bucket: 'no-good-answer', reference_answer: 'r',
        candidates: [{ id: 'c1', source: 'y.md', content: 'text', dense_distance: 1.1 }],
      },
    ],
  };

  it('accepts a well-formed fixture and applies pre-registered defaults', () => {
    const fixture = normalizeGateEvalFixture(minimal);
    expect(fixture.cases).toHaveLength(2);
    expect(fixture.epsilon).toBe(0.1);
    expect(fixture.hasAnswerTolerance).toBe(0);
    expect(fixture.gateSim).toEqual(DEFAULT_GATE_SIM_CONFIG);
    expect(fixture.cases[1].fixtureClass).toBe('standard');
  });

  it('preserves explicit source provenance for live runs', () => {
    const fixture = normalizeGateEvalFixture({
      ...minimal,
      source_paths: { 'x.md': '/tmp/source-policy.md' },
    });
    expect(fixture.sourcePaths).toEqual(new Map([['x.md', '/tmp/source-policy.md']]));
  });

  it('requires >= 2 structurally different KBs', () => {
    const oneKb = { cases: [minimal.cases[0], { ...minimal.cases[1], kb: 'k1' }] };
    expect(() => normalizeGateEvalFixture(oneKb)).toThrow(/>= 2 structurally different KBs/);
  });

  it('rejects a has-answer case with no answer_sources', () => {
    const bad = { cases: [{ ...minimal.cases[0], answer_sources: [] }, minimal.cases[1]] };
    expect(() => normalizeGateEvalFixture(bad)).toThrow(/must list answer_sources/);
  });

  it('rejects a no-good-answer case that declares answer_sources', () => {
    const bad = { cases: [minimal.cases[0], { ...minimal.cases[1], answer_sources: ['y.md'] }] };
    expect(() => normalizeGateEvalFixture(bad)).toThrow(/no answer_sources/);
  });

  it('rejects an answer_source that is not among the candidates', () => {
    const bad = { cases: [{ ...minimal.cases[0], answer_sources: ['missing.md'] }, minimal.cases[1]] };
    expect(() => normalizeGateEvalFixture(bad)).toThrow(/not among the candidates/);
  });

  it('rejects answer-present-but-distant on a no-good-answer case', () => {
    const bad = {
      cases: [minimal.cases[0], { ...minimal.cases[1], fixture_class: 'answer-present-but-distant' }],
    };
    expect(() => normalizeGateEvalFixture(bad)).toThrow(/requires bucket has-answer/);
  });

  it('rejects a negative dense_distance', () => {
    const bad = {
      cases: [
        { ...minimal.cases[0], candidates: [{ id: 'c1', source: 'x.md', content: 't', dense_distance: -1 }] },
        minimal.cases[1],
      ],
    };
    expect(() => normalizeGateEvalFixture(bad)).toThrow(/dense_distance/);
  });
});

// Schema-drift guard for the committed fixtures (mirrors retrieval-eval.test).
describe('committed RFC 018 fixtures', () => {
  it('queries.yml parses, spans 2 KBs, and has both buckets', () => {
    const raw = yaml.load(fs.readFileSync(path.join(FIXTURE_DIR, 'queries.yml'), 'utf-8'));
    const fixture = normalizeGateEvalFixture(raw);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(10);
    expect(new Set(fixture.cases.map((c) => c.kb)).size).toBe(2);
    expect(fixture.cases.some((c) => c.bucket === 'has-answer')).toBe(true);
    expect(fixture.cases.some((c) => c.bucket === 'no-good-answer')).toBe(true);
    expect(fixture.cases.some((c) => c.fixtureClass === 'answer-present-but-distant')).toBe(true);
  });

  it('grader-calibration.yml parses', () => {
    const raw = yaml.load(fs.readFileSync(path.join(FIXTURE_DIR, 'grader-calibration.yml'), 'utf-8'));
    const calibration = normalizeGraderCalibrationFixture(raw);
    expect(calibration.cases.length).toBeGreaterThan(0);
    expect(calibration.admissibilityThreshold).toBeGreaterThan(0);
  });
});

describe('simulateGate — threshold surgery', () => {
  it('raw returns every candidate, bypassed', () => {
    const cands = [candidate({ id: 'c1', denseDistance: 0.5 }), candidate({ id: 'c2', denseDistance: 1.4 })];
    const r = simulateGate(cands, CFG, 'raw');
    expect(r.verdict).toBe('bypassed');
    expect(r.kept).toHaveLength(2);
    expect(r.dropped).toHaveLength(0);
  });

  it('A1 floor drops candidates beyond the score floor', () => {
    const cands = [
      candidate({ id: 'near', denseDistance: 0.5 }),
      candidate({ id: 'far', denseDistance: 1.3 }),
    ];
    const r = simulateGate(cands, CFG, 'gated');
    expect(r.kept.map((c) => c.id)).toEqual(['near']);
    expect(r.dropped.some((d) => d.id === 'far' && d.stage === 'A1-floor')).toBe(true);
  });

  it('lexical-only candidates (no dense distance) pass A1 unfiltered', () => {
    const cands = [candidate({ id: 'lex' }), candidate({ id: 'far', denseDistance: 1.3 })];
    const r = simulateGate(cands, CFG, 'gated');
    expect(r.kept.map((c) => c.id)).toContain('lex');
  });

  it('emits no-relevant-context when every candidate is past the empty floor', () => {
    const cands = [candidate({ id: 'c1', denseDistance: 1.02 }), candidate({ id: 'c2', denseDistance: 1.08 })];
    const r = simulateGate(cands, CFG, 'gated');
    expect(r.verdict).toBe('no-relevant-context');
    expect(r.emptyFired).toBe(true);
    expect(r.kept).toHaveLength(0);
  });

  it('a BM25 lexical hit vetoes the empty verdict and rescues the best candidate', () => {
    const cands = [
      candidate({ id: 'c1', denseDistance: 1.02, lexicalHit: true }),
      candidate({ id: 'c2', denseDistance: 1.08 }),
    ];
    const r = simulateGate(cands, CFG, 'gated');
    expect(r.verdict).toBe('injected');
    expect(r.emptyFired).toBe(false);
    expect(r.lowConfidence).toBe(true);
    expect(r.kept.map((c) => c.id)).toEqual(['c1']);
  });

  it('gated-no-empty never emits no-relevant-context; it rescues instead', () => {
    const cands = [candidate({ id: 'c1', denseDistance: 1.02 }), candidate({ id: 'c2', denseDistance: 1.08 })];
    const r = simulateGate(cands, CFG, 'gated-no-empty');
    expect(r.verdict).toBe('injected');
    expect(r.emptyFired).toBe(false);
    expect(r.lowConfidence).toBe(true);
    expect(r.kept.map((c) => c.id)).toEqual(['c1']);
  });

  it('A2 keeps the closest cluster and drops the long tail', () => {
    const cands = [
      candidate({ id: 'c1', denseDistance: 0.40 }),
      candidate({ id: 'c2', denseDistance: 0.46 }),
      candidate({ id: 'c3', denseDistance: 0.90 }),
    ];
    const r = simulateGate(cands, CFG, 'gated');
    expect(r.kept.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(r.dropped.some((d) => d.id === 'c3' && d.stage === 'A2-knee')).toBe(true);
  });

  it('an empty candidate set is empty-index, not no-relevant-context', () => {
    const r = simulateGate([], CFG, 'gated');
    expect(r.verdict).toBe('empty-index');
    expect(r.emptyFired).toBe(false);
  });
});

describe('simulateAgentOutcome / outcomeIsCorrect', () => {
  const hasAnswer: GateEvalCase = {
    name: 't', kb: 'k', query: 'q', bucket: 'has-answer', fixtureClass: 'standard',
    referenceAnswer: 'r', answerSources: ['ans.md'],
    candidates: [candidate({ id: 'a', source: 'ans.md', denseDistance: 0.5 })],
  };
  const noGood: GateEvalCase = {
    name: 't', kb: 'k', query: 'q', bucket: 'no-good-answer', fixtureClass: 'standard',
    referenceAnswer: 'r', answerSources: [], candidates: [candidate({ id: 'x', denseDistance: 1.1 })],
  };

  it('has-answer: correct iff an answer chunk survives the gate', () => {
    const kept = simulateGate(hasAnswer.candidates, CFG, 'gated');
    expect(simulateAgentOutcome(kept, hasAnswer)).toBe('answered-correct');
    expect(outcomeIsCorrect('answered-correct', 'has-answer')).toBe(true);
  });

  it('no-good-answer: correct only when the gate returns an empty set', () => {
    const gated = simulateGate(noGood.candidates, CFG, 'gated');
    expect(simulateAgentOutcome(gated, noGood)).toBe('declined');
    expect(outcomeIsCorrect('declined', 'no-good-answer')).toBe(true);

    const raw = simulateGate(noGood.candidates, CFG, 'raw');
    expect(simulateAgentOutcome(raw, noGood)).toBe('answered-wrong');
    expect(outcomeIsCorrect('answered-wrong', 'no-good-answer')).toBe(false);
  });
});

describe('parseGraderVerdict', () => {
  it('reads a bare verdict word', () => {
    expect(parseGraderVerdict('correct')).toBe('correct');
    expect(parseGraderVerdict('Partial')).toBe('partial');
  });

  it('does not mistake the "correct" inside "incorrect"', () => {
    expect(parseGraderVerdict('Verdict: incorrect')).toBe('incorrect');
    expect(parseGraderVerdict('```\nincorrect\n```')).toBe('incorrect');
  });

  it('throws when no verdict token is present', () => {
    expect(() => parseGraderVerdict('the model said nothing useful')).toThrow(/no verdict token/);
  });
});

describe('verdictScore', () => {
  it('maps verdicts to directional weights', () => {
    expect(verdictScore('correct')).toBe(1);
    expect(verdictScore('partial')).toBe(0.5);
    expect(verdictScore('incorrect')).toBe(0);
  });
});

describe('aggregateGateEval — pre-registered M0 report', () => {
  function caseResult(over: Partial<GateEvalCaseResult>): GateEvalCaseResult {
    return {
      name: 'c', kb: 'k', bucket: 'has-answer', fixtureClass: 'standard',
      gatedVerdict: 'injected', emptyFired: false,
      conditions: [
        { variant: 'raw', verdict: 'correct' },
        { variant: 'gated', verdict: 'correct' },
        { variant: 'gated-no-empty', verdict: 'correct' },
      ],
      ...over,
    };
  }

  it('computes the per-bucket directional criterion and the three pre-registered numbers', () => {
    const results: GateEvalCaseResult[] = [
      // no-good-answer: raw wrong, gated right (empty fired), no-empty still wrong.
      caseResult({
        bucket: 'no-good-answer', kb: 'k1', emptyFired: true, gatedVerdict: 'no-relevant-context',
        conditions: [
          { variant: 'raw', verdict: 'incorrect' },
          { variant: 'gated', verdict: 'correct' },
          { variant: 'gated-no-empty', verdict: 'incorrect' },
        ],
      }),
      caseResult({
        bucket: 'no-good-answer', kb: 'k1', emptyFired: true, gatedVerdict: 'no-relevant-context',
        conditions: [
          { variant: 'raw', verdict: 'incorrect' },
          { variant: 'gated', verdict: 'correct' },
          { variant: 'gated-no-empty', verdict: 'incorrect' },
        ],
      }),
      // has-answer standard: correct everywhere.
      caseResult({ kb: 'k2' }),
      // has-answer answer-present-but-distant: gate falsely empties it.
      caseResult({
        kb: 'k2', fixtureClass: 'answer-present-but-distant', emptyFired: true,
        gatedVerdict: 'no-relevant-context',
        conditions: [
          { variant: 'raw', verdict: 'correct' },
          { variant: 'gated', verdict: 'incorrect' },
          { variant: 'gated-no-empty', verdict: 'incorrect' },
        ],
      }),
    ];
    const agg = aggregateGateEval(results, { epsilon: 0.1, hasAnswerTolerance: 0, graderAdmissibility: null });

    expect(agg.kbNames).toEqual(['k1', 'k2']);
    expect(agg.noGoodAnswerDelta).toBeCloseTo(1.0); // 0/2 -> 2/2
    expect(agg.hasAnswerDelta).toBeCloseTo(-0.5); // 2/2 -> 1/2
    // Criterion 1 met, criterion 2 (no has-answer regression) not -> overall fail.
    expect(agg.directionalPass).toBe(false);

    // (i) empty-verdict fire rate
    expect(agg.emptyVerdictFireCount).toBe(3);
    expect(agg.emptyVerdictFireRate).toBeCloseTo(0.75);
    // (ii) per-chunk-drop contribution, empty verdict off
    expect(agg.perChunkDropNoGoodAnswerDelta).toBeCloseTo(0); // 0/2 -> 0/2
    // (iii) judge false-empty rate on the answer-present-but-distant class
    expect(agg.answerPresentButDistantCount).toBe(1);
    expect(agg.judgeFalseEmptyCount).toBe(1);
    expect(agg.judgeFalseEmptyRate).toBeCloseTo(1.0);
  });

  it('passes directionally when no-good-answer lifts and has-answer holds', () => {
    const results: GateEvalCaseResult[] = [
      caseResult({
        bucket: 'no-good-answer', kb: 'k1',
        conditions: [
          { variant: 'raw', verdict: 'incorrect' },
          { variant: 'gated', verdict: 'correct' },
          { variant: 'gated-no-empty', verdict: 'incorrect' },
        ],
      }),
      caseResult({ kb: 'k2' }),
    ];
    const agg = aggregateGateEval(results, { epsilon: 0.1, hasAnswerTolerance: 0, graderAdmissibility: null });
    expect(agg.directionalPass).toBe(true);
  });
});

describe('computeGraderAdmissibility', () => {
  it('flags a run admissible only when agreement clears the threshold', () => {
    const ok = computeGraderAdmissibility(
      [
        { humanLabel: 'correct', graderVerdict: 'correct' },
        { humanLabel: 'incorrect', graderVerdict: 'incorrect' },
        { humanLabel: 'partial', graderVerdict: 'correct' },
      ],
      0.6,
    );
    expect(ok.agreement).toBeCloseTo(2 / 3);
    expect(ok.admissible).toBe(true);

    const bad = computeGraderAdmissibility(
      [
        { humanLabel: 'correct', graderVerdict: 'incorrect' },
        { humanLabel: 'incorrect', graderVerdict: 'correct' },
      ],
      0.7,
    );
    expect(bad.admissible).toBe(false);
  });
});

describe('formatGateEvalReportMarkdown / gateConfigGuidance', () => {
  const baseAggregate = aggregateGateEval(
    [
      {
        name: 'n', kb: 'k1', bucket: 'no-good-answer', fixtureClass: 'standard',
        gatedVerdict: 'injected', emptyFired: false,
        conditions: [
          { variant: 'raw', verdict: 'incorrect' },
          { variant: 'gated', verdict: 'incorrect' },
          { variant: 'gated-no-empty', verdict: 'incorrect' },
        ],
      },
      {
        name: 'h', kb: 'k2', bucket: 'has-answer', fixtureClass: 'standard',
        gatedVerdict: 'injected', emptyFired: false,
        conditions: [
          { variant: 'raw', verdict: 'correct' },
          { variant: 'gated', verdict: 'correct' },
          { variant: 'gated-no-empty', verdict: 'correct' },
        ],
      },
    ],
    { epsilon: 0.1, hasAnswerTolerance: 0, graderAdmissibility: null },
  );

  it('renders the pre-registered sections', () => {
    const md = formatGateEvalReportMarkdown(baseAggregate, {
      fixturePath: 'q.yml', mode: 'simulation',
      answererModel: 'm', graderModel: 'm', generatedAt: '2026-05-17T00:00:00Z',
    });
    expect(md).toContain('Directional pass criterion');
    expect(md).toContain('Empty-verdict fire rate');
    expect(md).toContain('Per-chunk-drop contribution');
    expect(md).toContain('Judge false-empty rate');
    expect(md).toContain('Configuration handoff to M0a');
  });

  it('recommends disabling the empty verdict when it almost never fires', () => {
    expect(gateConfigGuidance(baseAggregate)).toMatch(/empty verdict \*\*disabled by default\*\*/);
  });
});
