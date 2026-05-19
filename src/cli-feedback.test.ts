import { describe, expect, it } from '@jest/globals';
import { parseFeedbackArgs } from './cli-feedback.js';

describe('parseFeedbackArgs', () => {
  it('parses add, list, and promote modes', () => {
    expect(parseFeedbackArgs([
      'add',
      '--kb=ops',
      '--query=rollback',
      '--source=runbooks/deploy.md',
      '--verdict=relevant',
      '--relevance=2',
      '--group=procedure',
      '--format=json',
    ])).toMatchObject({
      action: 'add',
      kb: 'ops',
      query: 'rollback',
      source: 'runbooks/deploy.md',
      verdict: 'relevant',
      relevance: 2,
      groups: ['procedure'],
      format: 'json',
    });

    expect(parseFeedbackArgs(['list', '--kb=ops', '--limit=10'])).toMatchObject({
      action: 'list',
      limit: 10,
    });

    expect(parseFeedbackArgs([
      'promote',
      '--kb=ops',
      '--query=rollback',
      '--fixture=eval.yml',
      '--yes',
      '--gate',
    ])).toMatchObject({
      action: 'promote',
      fixture: 'eval.yml',
      yes: true,
      gate: true,
    });
  });

  it('requires explicit confirmation before promote writes a fixture', () => {
    expect(() => parseFeedbackArgs([
      'promote',
      '--kb=ops',
      '--query=rollback',
      '--fixture=eval.yml',
    ])).toThrow('--fixture=<path> requires --yes');
  });
});
