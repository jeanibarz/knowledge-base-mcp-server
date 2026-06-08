import { describe, expect, it } from '@jest/globals';
import { probeJudgeBias, probePanelBias, type ProbeItem } from './bias-probes.js';
import { rubricScores } from './types.js';
import { createStubJudge } from './judges.js';
import type { Judge, JudgeGradeInput, JudgeRawVerdict } from './panel.js';

// A fully-controllable judge for the probe tests: a flat base score plus
// independently-injectable position / verbosity / self-preference distortions,
// so each probe's detection can be asserted in isolation.
interface BiasKnobs {
  base?: number;
  /** Flip the preference on the BA ordering (pure position bias). */
  flipOnBA?: boolean;
  /** Score lift per filler token beyond the gold length (verbosity). */
  verbosityPerToken?: number;
  /** Lift applied to a candidate tagged `[self]` (self-preference). */
  selfLift?: number;
}

function biasedJudge(name: string, family: string, knobs: BiasKnobs): Judge {
  const base = knobs.base ?? 0.6;
  return {
    name,
    family,
    async grade(input: JudgeGradeInput): Promise<JudgeRawVerdict> {
      const extraTokens = Math.max(0, input.candidate.split(/\s+/).filter(Boolean).length - 2);
      const verbosityLift = (knobs.verbosityPerToken ?? 0) * extraTokens;
      const selfLift = knobs.selfLift !== undefined && input.candidate.includes('[self]') ? knobs.selfLift : 0;
      const dimensions = rubricScores(() => base + verbosityLift + selfLift);
      const preferredCandidate = knobs.flipOnBA ? input.order === 'AB' : true;
      return { dimensions, preferredCandidate };
    },
  };
}

const probes: ProbeItem[] = [
  {
    id: 'p1',
    question: 'Q1',
    contexts: ['ctx one'],
    goldAnswer: 'gold one [self]',
    otherFamilyAnswer: 'gold one other',
    selfFamily: 'alpha',
  },
];

describe('probeJudgeBias — position', () => {
  it('measures a high flip-rate and drops the order-sensitive judge', async () => {
    const profile = await probeJudgeBias(biasedJudge('jp', 'alpha', { flipOnBA: true }), probes, { samples: 3 });
    expect(profile.positionBias).toBe(1);
    expect(profile.dropped).toBe(true);
    expect(profile.dropReason).toMatch(/position flip-rate/);
  });

  it('reads zero position bias off an order-invariant stub judge', async () => {
    const profile = await probeJudgeBias(createStubJudge({ name: 'clean', family: 'beta' }), probes, { samples: 3 });
    expect(profile.positionBias).toBe(0);
  });
});

describe('probeJudgeBias — verbosity', () => {
  it('detects positive score drift from filler padding', async () => {
    const profile = await probeJudgeBias(
      biasedJudge('jv', 'beta', { verbosityPerToken: 0.02 }),
      probes,
      { samples: 2 },
    );
    expect(profile.verbosityBias).toBeGreaterThan(0);
    expect(profile.biasCoefficient).toBeGreaterThan(0);
  });
});

describe('probeJudgeBias — self-preference', () => {
  it('detects a judge over-crediting its own family', async () => {
    const profile = await probeJudgeBias(
      biasedJudge('js', 'alpha', { selfLift: 0.4 }),
      probes,
      { samples: 2 },
    );
    // probe.selfFamily 'alpha' === judge family 'alpha' → gap counts.
    expect(profile.selfPreferenceBias).toBeGreaterThan(0);
  });

  it('does not attribute self-preference to a different family', async () => {
    const profile = await probeJudgeBias(
      biasedJudge('jo', 'gamma', { selfLift: 0.4 }),
      probes,
      { samples: 2 },
    );
    // probe.selfFamily 'alpha' !== judge family 'gamma' → not counted.
    expect(profile.selfPreferenceBias).toBe(0);
  });
});

describe('probePanelBias', () => {
  it('returns coefficients + dropped set for the whole panel', async () => {
    const judges = [
      biasedJudge('jp', 'alpha', { flipOnBA: true }),
      createStubJudge({ name: 'clean', family: 'beta' }),
      createStubJudge({ name: 'clean2', family: 'gamma' }),
    ];
    const result = await probePanelBias(judges, probes, { samples: 2 });
    expect(result.profiles).toHaveLength(3);
    expect(result.droppedJudges.has('jp')).toBe(true);
    expect(result.biasCoefficients.get('clean')).toBe(0);
  });
});
