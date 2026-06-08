import { describe, expect, it } from '@jest/globals';
import {
  aggregateReferenceScores,
  contextPrecision,
  contextRecall,
  exactMatch,
  normalizeAnswer,
  scoreReferenceItem,
  tokenF1,
  tokenF1Pair,
} from './reference.js';
import type { GoldQaItem, RagAnswer } from './types.js';

describe('normalizeAnswer', () => {
  it('lowercases and strips punctuation + articles (SQuAD scheme)', () => {
    expect(normalizeAnswer('The  Eiffel-Tower!')).toBe('eiffel tower');
    expect(normalizeAnswer('A cat.')).toBe('cat');
    expect(normalizeAnswer('  ')).toBe('');
  });
});

describe('exactMatch', () => {
  it('matches modulo casing/punctuation/articles', () => {
    expect(exactMatch('the Paris.', ['paris'])).toBe(1);
    expect(exactMatch('London', ['Paris', 'paris city'])).toBe(0);
  });
});

describe('tokenF1', () => {
  it('is 1 for an exact token set and partial for overlap', () => {
    expect(tokenF1Pair('william shakespeare', 'William Shakespeare')).toBe(1);
    const f1 = tokenF1('shakespeare wrote it', ['william shakespeare']);
    expect(f1).toBeGreaterThan(0);
    expect(f1).toBeLessThan(1);
  });

  it('is 0 with no shared tokens', () => {
    expect(tokenF1('dog', ['cat'])).toBe(0);
  });
});

describe('context recall / precision', () => {
  const contexts = [
    { id: 'a', text: 'The Eiffel Tower is located in Paris France.' },
    { id: 'b', text: 'Bananas are yellow and grow on trees.' },
  ];
  const facts = ['The Eiffel Tower is in Paris.'];

  it('recall finds the covered fact', () => {
    expect(contextRecall(contexts, facts)).toBe(1);
  });

  it('precision penalises the irrelevant chunk', () => {
    // 1 of 2 chunks covers the fact → 0.5.
    expect(contextPrecision(contexts, facts)).toBe(0.5);
  });

  it('returns null when there are no gold facts', () => {
    expect(contextRecall(contexts, [])).toBeNull();
    expect(contextPrecision(contexts, [])).toBeNull();
  });
});

describe('scoreReferenceItem + aggregate', () => {
  const item: GoldQaItem = {
    id: 'q1',
    dataset: 'hotpotqa',
    question: 'Where is the Eiffel Tower?',
    goldAnswers: ['Paris'],
    goldSupportingFacts: ['The Eiffel Tower is in Paris.'],
    answerType: 'short',
  };
  const answer: RagAnswer = {
    id: 'q1',
    answer: 'Paris',
    contexts: [{ id: 'c', text: 'The Eiffel Tower is in Paris.' }],
  };

  it('scores a correct short answer with full context recall', () => {
    const score = scoreReferenceItem(item, answer);
    expect(score.exactMatch).toBe(1);
    expect(score.tokenF1).toBe(1);
    expect(score.contextRecall).toBe(1);
    expect(score.hasGoldFacts).toBe(true);
  });

  it('aggregates EM/F1 over answered items and recall over fact-bearing items', () => {
    const score = scoreReferenceItem(item, answer);
    const agg = aggregateReferenceScores([score]);
    expect(agg.items).toBe(1);
    expect(agg.exactMatch).toBe(1);
    expect(agg.contextRecall).toBe(1);
    expect(agg.itemsWithGoldFacts).toBe(1);
  });
});
