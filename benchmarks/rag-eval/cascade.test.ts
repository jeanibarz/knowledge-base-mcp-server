import { describe, expect, it } from '@jest/globals';
import { decideTier1, decideTier2, DEFAULT_THRESHOLDS, runCascade, type CascadeConfig } from './cascade.js';
import { tokenOverlapEntailmentModel, tokenOverlapSimilarityModel } from './model-metrics.js';
import { createStubJudge } from './judges.js';
import { scoreReferenceItem } from './reference.js';
import type { GoldQaItem, RagAnswer } from './types.js';
import type { ProbeItem } from './bias-probes.js';

const items: GoldQaItem[] = [
  { id: 'correct', dataset: 'nq', question: 'Capital of France?', goldAnswers: ['Paris'], goldSupportingFacts: [], answerType: 'short' },
  { id: 'wrong', dataset: 'nq', question: 'Capital of Spain?', goldAnswers: ['Madrid'], goldSupportingFacts: [], answerType: 'short' },
  { id: 'longform', dataset: 'hotpotqa', question: 'Explain photosynthesis.', goldAnswers: ['Plants convert sunlight into chemical energy via chlorophyll producing glucose and oxygen'], goldSupportingFacts: ['Photosynthesis converts light to chemical energy.'], answerType: 'long' },
];

const answers: RagAnswer[] = [
  { id: 'correct', answer: 'Paris', contexts: [{ id: 'c1', text: 'Paris is the capital of France.' }] },
  { id: 'wrong', answer: 'Lisbon', contexts: [{ id: 'c2', text: 'Lisbon is the capital of Portugal.' }] },
  // Fully faithful to its context but only a partial token match to the long
  // gold answer → Tier 2 is inconclusive and the item escalates to the panel.
  { id: 'longform', answer: 'Plants make energy from sunlight.', contexts: [{ id: 'c3', text: 'Plants make energy from sunlight using chlorophyll.' }] },
];

const probes: ProbeItem[] = [
  { id: 'pr', question: 'Q', contexts: ['ctx'], goldAnswer: 'gold', otherFamilyAnswer: 'gold', selfFamily: 'a' },
];

function fullConfig(): CascadeConfig {
  return {
    tier2: { entailment: tokenOverlapEntailmentModel('stub-nli'), semantic: tokenOverlapSimilarityModel('stub-semantic') },
    tier3: {
      judges: [
        createStubJudge({ name: 'j1', family: 'a' }),
        createStubJudge({ name: 'j2', family: 'b' }),
        createStubJudge({ name: 'j3', family: 'c' }),
      ],
      probes,
      panelOptions: { samples: 3 },
    },
  };
}

describe('decideTier1 / decideTier2', () => {
  it('Tier 1 decides conclusive short answers and escalates the ambiguous/long', () => {
    const correct = scoreReferenceItem(items[0], answers[0]);
    expect(decideTier1(items[0], correct, DEFAULT_THRESHOLDS)).toBe(true);
    const wrong = scoreReferenceItem(items[1], answers[1]);
    expect(decideTier1(items[1], wrong, DEFAULT_THRESHOLDS)).toBe(false);
    const long = scoreReferenceItem(items[2], answers[2]);
    expect(decideTier1(items[2], long, DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('Tier 2 thresholds gate the escalation', () => {
    expect(decideTier2({ faithfulness: 0.9, semantic: 0.9 }, DEFAULT_THRESHOLDS)).toBe(true);
    expect(decideTier2({ faithfulness: 0.1, semantic: 0.9 }, DEFAULT_THRESHOLDS)).toBe(false);
    expect(decideTier2({ faithfulness: 0.5, semantic: 0.5 }, DEFAULT_THRESHOLDS)).toBeNull();
  });
});

describe('runCascade', () => {
  it('routes deterministic-first and records the deciding tier', async () => {
    const outcome = await runCascade(items, answers, fullConfig());
    const byId = new Map(outcome.decisions.map((d) => [d.id, d]));
    expect(byId.get('correct')?.decidedBy).toBe('tier1');
    expect(byId.get('correct')?.correct).toBe(true);
    expect(byId.get('wrong')?.decidedBy).toBe('tier1');
    expect(byId.get('wrong')?.correct).toBe(false);
    // The long-form item escalates past Tier 1; some later tier (2 or 3) takes it.
    expect(byId.get('longform')?.decidedBy).not.toBe('tier1');
    expect(outcome.tier1Decided).toBe(2);
    expect(outcome.biasProfiles.length).toBe(3);
  });

  it('marks residue PENDING (never fabricated) when later tiers are unwired', async () => {
    const outcome = await runCascade(items, answers, {});
    const long = outcome.decisions.find((d) => d.id === 'longform');
    expect(long?.decidedBy).toBe('pending');
    expect(long?.correct).toBeNull();
    expect(long?.pendingReason).toMatch(/Tier 2/);
    expect(outcome.pending).toBe(1);
    // Tier 1 still decided the two short items with no models in the loop.
    expect(outcome.tier1Decided).toBe(2);
  });

  it('marks an item with no system answer as pending', async () => {
    const outcome = await runCascade(items, answers.slice(0, 2), fullConfig());
    const long = outcome.decisions.find((d) => d.id === 'longform');
    expect(long?.decidedBy).toBe('pending');
    expect(long?.pendingReason).toMatch(/no system answer/);
  });

  it('routes the residue to the judge panel when Tier 2 is unwired but Tier 3 is (judge-direct)', async () => {
    // Tier 3 configured, Tier 2 omitted: the long-form residue must reach the
    // panel rather than being stranded pending.
    const config: CascadeConfig = { tier3: fullConfig().tier3 };
    const outcome = await runCascade(items, answers, config);
    const long = outcome.decisions.find((d) => d.id === 'longform');
    expect(long?.decidedBy).toBe('tier3');
    expect(outcome.tier3Decided + outcome.tier3Abstained).toBe(1);
    expect(outcome.pending).toBe(0);
    expect(outcome.biasProfiles.length).toBe(3);
  });

  it('tier1LowF1 below the F1 floor sends would-be-incorrect items to the panel', async () => {
    // With the default low threshold the "wrong" short answer is decided
    // incorrect at Tier 1; a negative low threshold disables that so it
    // escalates to the judge panel instead.
    const config: CascadeConfig = { thresholds: { tier1LowF1: -1 }, tier3: fullConfig().tier3 };
    const outcome = await runCascade(items, answers, config);
    expect(outcome.decisions.find((d) => d.id === 'wrong')?.decidedBy).toBe('tier3');
  });
});
