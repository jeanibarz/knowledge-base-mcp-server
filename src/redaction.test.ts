import { describe, expect, it } from '@jest/globals';
import { redactSecrets } from './redaction.js';

describe('redactSecrets', () => {
  it('redacts common support-bundle secret shapes', () => {
    const input = [
      'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz',
      'Authorization: Bearer abcdefghijklmnop',
      '{"github_token":"ghp_abcdefghijklmnopqrstuvwxyz"}',
      'https://user:password@example.com/path',
    ].join('\n');

    const result = redactSecrets(input);

    expect(result.text).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(result.text).toContain('Authorization: Bearer [REDACTED]');
    expect(result.text).toContain('"github_token":"[REDACTED]"');
    expect(result.text).toContain('https://[REDACTED]@example.com/path');
    expect(result.summary.total).toBeGreaterThanOrEqual(4);
  });
});
