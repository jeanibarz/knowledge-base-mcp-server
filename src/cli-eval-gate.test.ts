import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { parseEvalGateArgs, runSimulatedGateEval } from './cli-eval-gate.js';
import { aggregateGateEval, normalizeGateEvalFixture } from './relevance-gate-eval.js';

describe('parseEvalGateArgs', () => {
  it('parses the fixture path and every option', () => {
    expect(parseEvalGateArgs([
      'q.yml',
      '--calibration=cal.yml',
      '--endpoint=http://127.0.0.1:8080',
      '--model=local',
      '--dry-run',
      '--format=json',
      '--out=report.md',
    ])).toEqual({
      fixturePath: 'q.yml',
      calibrationPath: 'cal.yml',
      endpoint: 'http://127.0.0.1:8080',
      model: 'local',
      dryRun: true,
      m1: false,
      format: 'json',
      outPath: 'report.md',
    });
  });

  it('parses the M1 canary flags', () => {
    expect(parseEvalGateArgs([
      'q.yml',
      '--m1',
      '--floor-sweep=0.80:1.10:0.05',
      '--score-floor=0.9',
    ])).toEqual({
      fixturePath: 'q.yml',
      dryRun: false,
      m1: true,
      floorSweepSpec: '0.80:1.10:0.05',
      scoreFloor: 0.9,
      format: 'md',
    });
  });

  it('rejects malformed flags', () => {
    expect(() => parseEvalGateArgs(['q.yml', '--format=yaml'])).toThrow(/invalid --format/);
    expect(() => parseEvalGateArgs(['q.yml', '--bogus'])).toThrow(/unknown flag/);
    expect(() => parseEvalGateArgs(['q.yml', 'extra.yml'])).toThrow(/unexpected argument/);
    expect(() => parseEvalGateArgs(['q.yml', '--endpoint='])).toThrow(/requires a non-empty value/);
    expect(() => parseEvalGateArgs(['q.yml', '--floor-sweep=0.8:1.0'])).toThrow(/lo:hi:step/);
    expect(() => parseEvalGateArgs(['q.yml', '--score-floor=-1'])).toThrow(/positive number/);
  });
});

describe('runSimulatedGateEval against the committed RFC 018 fixture', () => {
  const raw = yaml.load(
    fs.readFileSync(path.join('docs', 'testing', 'fixtures', 'rfc-018-gate-eval', 'queries.yml'), 'utf-8'),
  );
  const fixture = normalizeGateEvalFixture(raw);
  const caseResults = runSimulatedGateEval(fixture);
  const aggregate = aggregateGateEval(caseResults, {
    epsilon: fixture.epsilon,
    hasAnswerTolerance: fixture.hasAnswerTolerance,
    graderAdmissibility: null,
  });

  it('runs every case and reports the production-matched bucket mix', () => {
    expect(aggregate.caseCount).toBe(15);
    expect(aggregate.hasAnswerCount).toBe(10);
    expect(aggregate.noGoodAnswerCount).toBe(5);
  });

  it('shows the empty verdict lifting no-good-answer correctness', () => {
    // raw injects near-misses (0/5); the gate empties 4 of 5 -> declined.
    expect(aggregate.buckets.noGoodAnswer.rawScore).toBe(0);
    expect(aggregate.buckets.noGoodAnswer.gatedScore).toBe(4);
    expect(aggregate.noGoodAnswerDelta).toBeCloseTo(0.8);
  });

  it('surfaces the has-answer regression from answer-present-but-distant cases', () => {
    expect(aggregate.buckets.hasAnswer.rawScore).toBe(10);
    expect(aggregate.buckets.hasAnswer.gatedScore).toBe(8);
    expect(aggregate.hasAnswerDelta).toBeCloseTo(-0.2);
    // Criterion 2 (no has-answer regression) fails -> directional NOT met.
    expect(aggregate.directionalPass).toBe(false);
  });

  it('reports pre-registered number (i) — empty-verdict fire rate', () => {
    expect(aggregate.emptyVerdictFireCount).toBe(5);
    expect(aggregate.emptyVerdictFireRate).toBeCloseTo(5 / 15);
  });

  it('reports pre-registered number (ii) — per-chunk drops alone do not help no-good-answer', () => {
    expect(aggregate.perChunkDropNoGoodAnswerDelta).toBeCloseTo(0);
    expect(aggregate.perChunkDropHasAnswerDelta).toBeCloseTo(-0.2);
  });

  it('reports pre-registered number (iii) — judge false-empty rate', () => {
    expect(aggregate.answerPresentButDistantCount).toBe(2);
    expect(aggregate.judgeFalseEmptyCount).toBe(1);
    expect(aggregate.judgeFalseEmptyRate).toBeCloseTo(0.5);
  });
});
