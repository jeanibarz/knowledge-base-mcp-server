import { describe, expect, it } from '@jest/globals';
import { parseAskArgs } from './cli-ask.js';

describe('parseAskArgs', () => {
  it('parses retrieval and LLM options', () => {
    expect(parseAskArgs([
      'what changed?',
      '--kb=ops',
      '--model=ollama__nomic',
      '--llm-profile=local',
      '--endpoint=http://127.0.0.1:8080',
      '--k=4',
      '--refresh',
      '--format=json',
      '--timing',
    ])).toEqual({
      question: 'what changed?',
      kb: 'ops',
      model: 'ollama__nomic',
      llmProfile: 'local',
      endpoint: 'http://127.0.0.1:8080',
      k: 4,
      refresh: true,
      stdin: false,
      format: 'json',
      timing: true,
    });
  });

  it('rejects invalid flags', () => {
    expect(() => parseAskArgs(['q', '--k=0'])).toThrow(/invalid --k/);
    expect(() => parseAskArgs(['q', '--format=yaml'])).toThrow(/invalid --format/);
    expect(() => parseAskArgs(['q', '--bad'])).toThrow(/unknown flag/);
    expect(() => parseAskArgs(['q', 'extra'])).toThrow(/unexpected argument/);
  });
});
