import { describe, expect, it } from '@jest/globals';
import { buildScorecard, formatScorecardMarkdown, type BuildScorecardInput } from './scorecard.js';
import { runCascade } from './cascade.js';
import { tokenOverlapEntailmentModel, tokenOverlapSimilarityModel } from './model-metrics.js';
import { createStubJudge } from './judges.js';
import type { GoldQaItem, RagAnswer } from './types.js';

const items: GoldQaItem[] = [
  { id: 'q1', dataset: 'nq', question: 'Capital of France?', goldAnswers: ['Paris'], goldSupportingFacts: ['Paris is the capital of France.'], answerType: 'short' },
];
const answers: RagAnswer[] = [
  { id: 'q1', answer: 'Paris', contexts: [{ id: 'c', text: 'Paris is the capital of France.' }] },
];

async function makeInput(): Promise<BuildScorecardInput> {
  const outcome = await runCascade(items, answers, {
    tier2: { entailment: tokenOverlapEntailmentModel('stub-nli'), semantic: tokenOverlapSimilarityModel('stub-sem') },
    tier3: {
      judges: [
        createStubJudge({ name: 'j1', family: 'a' }),
        createStubJudge({ name: 'j2', family: 'b' }),
        createStubJudge({ name: 'j3', family: 'c' }),
      ],
      probes: [],
    },
  });
  return {
    generatedAt: '2026-06-08T00:00:00.000Z',
    gitSha: 'test-sha',
    datasets: ['nq'],
    outcome,
    panel: { judges: [{ name: 'j1', family: 'a' }], distinctFamilies: 3, selfConsistencyK: 5, calibrationMethod: 'isotonic', abstentionThreshold: 0.5 },
    config: { provider: 'ollama', embeddingModel: 'nomic', answererModel: 'deepseek', thresholds: {}, tier2Families: { entailment: 'stub-nli', semantic: 'stub-sem' } },
  };
}

describe('buildScorecard', () => {
  it('assembles tier-1 metrics, routing and correctness with no human labels', async () => {
    const scorecard = buildScorecard(await makeInput());
    expect(scorecard.schema_version).toBe('kb.rag-eval-scorecard.v1');
    expect(scorecard.tier1.exactMatch).toBe(1);
    expect(scorecard.routing.tier1Decided).toBe(1);
    expect(scorecard.correctness.accuracy).toBe(1);
    expect(scorecard.panel.distinctFamilies).toBe(3);
    expect(scorecard.caveats.some((c) => /human-label-free/i.test(c))).toBe(true);
  });
});

describe('formatScorecardMarkdown', () => {
  it('renders the tier tables and the bias section header', async () => {
    const md = formatScorecardMarkdown(buildScorecard(await makeInput()));
    expect(md).toContain('# End-to-end RAG eval scorecard — human-label-free');
    expect(md).toContain('## Tier 1 — deterministic reference metrics');
    expect(md).toContain('## Cascade routing (deterministic-first)');
    expect(md).toContain('## Tier 4 — per-judge probe-measured bias coefficients');
  });

  it('flags a partial run when items are pending', () => {
    const input: BuildScorecardInput = {
      generatedAt: '2026-06-08T00:00:00.000Z',
      gitSha: 'sha',
      datasets: ['nq'],
      outcome: {
        decisions: [{ id: 'q', dataset: 'nq', decidedBy: 'pending', correct: null, reference: { id: 'q', dataset: 'nq', exactMatch: 0, tokenF1: 0, contextRecall: null, contextPrecision: null, hasGoldAnswer: true, hasGoldFacts: false }, pendingReason: 'Tier 2 not wired' }],
        reference: { items: 1, exactMatch: 0, tokenF1: 0, contextRecall: null, contextPrecision: null, itemsWithGoldFacts: 0 },
        tier1Decided: 0, tier2Decided: 0, tier3Decided: 0, tier3Abstained: 0, pending: 1,
        biasProfiles: [], panelItems: [], panelCalibration: null,
      },
      panel: { judges: [], distinctFamilies: 0, selfConsistencyK: 5, calibrationMethod: null, abstentionThreshold: 0.5 },
      config: { provider: null, embeddingModel: null, answererModel: null, thresholds: {}, tier2Families: { entailment: null, semantic: null } },
    };
    const md = formatScorecardMarkdown(buildScorecard(input));
    expect(md).toContain('Partial run');
    expect(md).toContain('No bias probes run');
  });
});
