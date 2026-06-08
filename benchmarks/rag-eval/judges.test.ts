import { describe, expect, it } from '@jest/globals';
import {
  buildJudgeMessages,
  createLlmJudge,
  createStubJudge,
  parseJudgeVerdict,
  type ChatCompletionLike,
} from './judges.js';

describe('buildJudgeMessages', () => {
  it('presents two answers and never leaks a dataset name (§6)', () => {
    const messages = buildJudgeMessages('Where is Paris?', 'In France', 'In Spain', ['Paris is in France.']);
    const user = messages[1].content;
    expect(user).toContain('Answer A:\nIn France');
    expect(user).toContain('Answer B:\nIn Spain');
    expect(user.toLowerCase()).not.toContain('hotpotqa');
  });
});

describe('parseJudgeVerdict', () => {
  it('maps the candidate slot per ordering and rescales 0-10 to [0,1]', () => {
    const json = '{"A":{"faithfulness":10,"relevance":8,"completeness":6},"B":{"faithfulness":2,"relevance":2,"completeness":2},"preferred":"A"}';
    const ab = parseJudgeVerdict(json, true); // candidate is A
    expect(ab.dimensions.faithfulness).toBe(1);
    expect(ab.dimensions.relevance).toBeCloseTo(0.8, 5);
    expect(ab.preferredCandidate).toBe(true);
    const ba = parseJudgeVerdict(json, false); // candidate is B
    expect(ba.dimensions.faithfulness).toBeCloseTo(0.2, 5);
    expect(ba.preferredCandidate).toBe(false);
  });

  it('survives fenced JSON and junk by defaulting to zeros', () => {
    expect(parseJudgeVerdict('```json\n{"A":{"faithfulness":5,"relevance":5,"completeness":5},"preferred":"tie"}\n```', true).dimensions.faithfulness).toBe(0.5);
    expect(parseJudgeVerdict('garbage', true).dimensions.faithfulness).toBe(0);
  });
});

describe('createLlmJudge', () => {
  it('drives the injected chat fn, varies temperature by sample, parses the verdict', async () => {
    const seen: number[] = [];
    const chat: ChatCompletionLike = async (options) => {
      seen.push(options.temperature ?? 0);
      return { content: '{"A":{"faithfulness":9,"relevance":9,"completeness":9},"B":{"faithfulness":3,"relevance":3,"completeness":3},"preferred":"A"}', model: 'fake' };
    };
    const judge = createLlmJudge({ name: 'j', family: 'fam', endpoint: 'mock://x', chat, baseTemperature: 0.2 });
    const v0 = await judge.grade({ question: 'q', candidate: 'c', reference: 'r', contexts: [], order: 'AB', sample: 0 });
    const v1 = await judge.grade({ question: 'q', candidate: 'c', reference: 'r', contexts: [], order: 'AB', sample: 1 });
    expect(v0.dimensions.faithfulness).toBe(0.9);
    expect(v0.preferredCandidate).toBe(true);
    expect(seen[1]).toBeGreaterThan(seen[0]); // self-consistency temperature spread
    void v1;
  });
});

describe('createStubJudge', () => {
  it('scores a matching candidate high and shows no position flip', async () => {
    const judge = createStubJudge({ name: 's', family: 'stub' });
    const ab = await judge.grade({ question: 'q', candidate: 'Paris', reference: 'Paris', contexts: ['Paris is a city.'], order: 'AB', sample: 0 });
    const ba = await judge.grade({ question: 'q', candidate: 'Paris', reference: 'Paris', contexts: ['Paris is a city.'], order: 'BA', sample: 0 });
    expect(ab.dimensions.relevance).toBe(1);
    expect(ab.preferredCandidate).toBe(ba.preferredCandidate);
  });
});
