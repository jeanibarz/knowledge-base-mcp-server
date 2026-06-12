import { describe, expect, it } from '@jest/globals';
import {
  evaluateMetricGate,
  faithfulnessScore,
  semanticScore,
  splitClaims,
  tokenOverlapEntailmentModel,
  tokenOverlapSimilarityModel,
} from './model-metrics.js';

describe('splitClaims', () => {
  it('splits an answer into sentence-sized claims', () => {
    expect(splitClaims('Paris is the capital. It is in France.')).toEqual([
      'Paris is the capital.',
      'It is in France.',
    ]);
    expect(splitClaims('')).toEqual([]);
  });
});

describe('faithfulnessScore (stub NLI)', () => {
  const nli = tokenOverlapEntailmentModel('stub-nli');

  it('is 1 when every claim is supported by the context', async () => {
    const result = await faithfulnessScore(
      'The Eiffel Tower is in Paris.',
      [{ id: 'c', text: 'The Eiffel Tower is located in Paris, France.' }],
      nli,
    );
    expect(result.faithfulness).toBe(1);
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].entailed).toBe(true);
  });

  it('drops a claim the context does not support', async () => {
    const result = await faithfulnessScore(
      'The tower is in Paris. The tower is made of gold.',
      [{ id: 'c', text: 'The Eiffel Tower is located in Paris, France.' }],
      nli,
    );
    expect(result.faithfulness).toBe(0.5);
  });

  it('treats an empty answer as vacuously faithful', async () => {
    const result = await faithfulnessScore('', [{ id: 'c', text: 'anything' }], nli);
    expect(result.faithfulness).toBe(1);
  });

  it('flags a negation mismatch as a contradiction, not entailment', async () => {
    const result = await faithfulnessScore(
      'The tower is not in Paris.',
      [{ id: 'c', text: 'The tower is in Paris.' }],
      nli,
    );
    expect(result.faithfulness).toBe(0);
    expect(result.claims[0].label).toBe('contradiction');
  });
});

describe('semanticScore (stub BERTScore)', () => {
  it('takes the best similarity over references', async () => {
    const model = tokenOverlapSimilarityModel();
    expect(await semanticScore('paris', ['london', 'paris'], model)).toBe(1);
    expect(await semanticScore('paris', [], model)).toBe(0);
  });
});

describe('evaluateMetricGate', () => {
  it('marks a small deterministic fixture delta as inconclusive below the noise floor', () => {
    const result = evaluateMetricGate({
      metric: 'faithfulness',
      baseline: 0.8,
      current: 0.82,
      observations: 25,
    });
    expect(result.delta).toBeCloseTo(0.02, 6);
    expect(result.noiseFloor).toBeCloseTo(0.16, 6);
    expect(result.noiseFloorPassed).toBe(false);
    expect(result.status).toBe('inconclusive-below-noise-floor');
  });

  it('fails a regression only after it exceeds the stated MDE and 2x SE', () => {
    const result = evaluateMetricGate({
      metric: 'semantic',
      baseline: 0.8,
      current: 0.6,
      observations: 25,
      minimumDetectableEffect: 0.05,
      standardError: 0.04,
    });
    expect(result.twoStandardErrors).toBeCloseTo(0.08, 6);
    expect(result.noiseFloor).toBeCloseTo(0.08, 6);
    expect(result.noiseFloorPassed).toBe(true);
    expect(result.status).toBe('fail');
  });
});
