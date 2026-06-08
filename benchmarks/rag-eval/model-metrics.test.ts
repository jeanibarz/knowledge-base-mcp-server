import { describe, expect, it } from '@jest/globals';
import {
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
