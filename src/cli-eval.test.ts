import { describe, expect, it } from '@jest/globals';
import { parseEvalArgs } from './cli-eval.js';

describe('parseEvalArgs', () => {
  it('accepts delimited output formats for eval runs', () => {
    expect(parseEvalArgs(['fixture.yml', '--format=csv'])).toMatchObject({
      action: 'run',
      fixturePath: 'fixture.yml',
      format: 'csv',
    });
    expect(parseEvalArgs(['fixture.yml', '--format=tsv'])).toMatchObject({ format: 'tsv' });
    expect(parseEvalArgs(['fixture.yml', '--format=ndjson'])).toMatchObject({ format: 'ndjson' });
  });

  it('continues to reject --format for scaffold', () => {
    expect(() => parseEvalArgs(['scaffold', 'rollback', '--format=csv'])).toThrow(
      /--format is not supported for scaffold/,
    );
  });
});
