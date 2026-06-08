import { describe, expect, it } from '@jest/globals';
import { parseGoldQaJsonl } from './dataset.js';

describe('parseGoldQaJsonl', () => {
  it('normalizes HotpotQA-style rows (supporting_facts pairs, single answer)', () => {
    const raw = [
      JSON.stringify({ _id: 'h1', question: 'Who?', answer: 'Ada Lovelace', supporting_facts: [['Ada Lovelace', 'Ada Lovelace was a mathematician.']] }),
    ].join('\n');
    const items = parseGoldQaJsonl(raw, 'hotpotqa');
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('h1');
    expect(items[0].goldAnswers).toEqual(['Ada Lovelace']);
    expect(items[0].goldSupportingFacts).toEqual(['Ada Lovelace was a mathematician.']);
    expect(items[0].answerType).toBe('short');
  });

  it('normalizes NQ-style rows (short_answers array, no facts)', () => {
    const raw = JSON.stringify({ id: 'nq1', query: 'capital?', short_answers: ['Paris', 'Paris, France'] });
    const items = parseGoldQaJsonl(raw, 'nq');
    expect(items[0].goldAnswers).toEqual(['Paris', 'Paris, France']);
    expect(items[0].goldSupportingFacts).toEqual([]);
  });

  it('classifies a long free-form answer as answerType long', () => {
    const raw = JSON.stringify({ id: 'x', question: 'explain', answer: 'a '.repeat(30).trim() });
    const items = parseGoldQaJsonl(raw, 'hotpotqa');
    expect(items[0].answerType).toBe('long');
  });

  it('skips blank lines and throws on malformed JSON', () => {
    expect(parseGoldQaJsonl('\n\n', 'nq')).toEqual([]);
    expect(() => parseGoldQaJsonl('{not json}', 'nq')).toThrow(/not valid JSON/);
  });

  it('throws when a row has no question', () => {
    expect(() => parseGoldQaJsonl(JSON.stringify({ id: 'a', answer: 'b' }), 'nq')).toThrow(/no question/);
  });
});
