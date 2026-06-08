import { describe, expect, it } from '@jest/globals';
import {
  assertPanelFamilies,
  calibratePanel,
  distinctFamilies,
  gradePanelItem,
  type Judge,
} from './panel.js';
import { createStubJudge } from './judges.js';

function panel(): Judge[] {
  return [
    createStubJudge({ name: 'j1', family: 'alpha' }),
    createStubJudge({ name: 'j2', family: 'beta' }),
    createStubJudge({ name: 'j3', family: 'gamma' }),
  ];
}

const goodItem = {
  id: 'q1',
  question: 'Where is the Eiffel Tower?',
  candidate: 'The Eiffel Tower is in Paris.',
  reference: 'The Eiffel Tower is in Paris.',
  contexts: ['The Eiffel Tower is located in Paris.'],
};

describe('distinctFamilies / assertPanelFamilies', () => {
  it('counts distinct families and requires ≥3', () => {
    expect(distinctFamilies(panel())).toEqual(['alpha', 'beta', 'gamma']);
    expect(() => assertPanelFamilies(panel())).not.toThrow();
    expect(() => assertPanelFamilies(panel().slice(0, 2))).toThrow(/≥3 distinct/);
  });
});

describe('gradePanelItem', () => {
  it('aggregates per-judge scores, agreement and position flips', async () => {
    const raw = await gradePanelItem(goodItem, panel(), { samples: 4 });
    expect(raw.contributingJudges).toBe(3);
    expect(raw.panelMajorityPass).toBe(true);
    expect(raw.panelMeanOverall).toBeGreaterThan(0.5);
    // No injected position bias → no flips, full self-consistency.
    for (const judge of raw.perJudge) {
      expect(judge.positionFlipRate).toBe(0);
      expect(judge.selfConsistencyAgreement).toBe(1);
    }
  });

  it('subtracts injected bias coefficients and drops flagged judges', async () => {
    const raw = await gradePanelItem(goodItem, panel(), {
      samples: 2,
      biasCoefficients: new Map([['j1', 0.3]]),
      droppedJudges: new Set(['j3']),
    });
    const j1 = raw.perJudge.find((j) => j.judge === 'j1');
    expect(j1?.adjustedOverall).toBeCloseTo((j1?.rawOverall ?? 0) - 0.3, 5);
    expect(raw.perJudge.find((j) => j.judge === 'j3')?.dropped).toBe(true);
    // Dropped judge excluded from the contributing count.
    expect(raw.contributingJudges).toBe(2);
  });
});

describe('calibratePanel', () => {
  it('calibrates confidence and abstains on low-confidence items', async () => {
    const good = await gradePanelItem(goodItem, panel(), { samples: 3 });
    const badItem = { ...goodItem, id: 'q2', candidate: 'Bananas are yellow fruit.', reference: 'Paris', contexts: ['Paris is a city.'] };
    const bad = await gradePanelItem(badItem, panel(), { samples: 3 });

    const calibrated = calibratePanel([good, bad], { method: 'isotonic', abstentionThreshold: 0.5 });
    expect(calibrated.items).toHaveLength(2);
    expect(calibrated.summary.items).toBe(2);
    expect(calibrated.calibrator.method).toBe('isotonic');
    // Every item carries a calibrated confidence in [0,1].
    for (const item of calibrated.items) {
      expect(item.calibratedConfidence).toBeGreaterThanOrEqual(0);
      expect(item.calibratedConfidence).toBeLessThanOrEqual(1);
    }
  });
});
