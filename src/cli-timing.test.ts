import { describe, expect, it } from '@jest/globals';
import { compactTimingPayload, formatTimingFooter } from './cli-timing.js';

describe('compactTimingPayload', () => {
  it('drops undefined values and rounds numeric measurements', () => {
    expect(compactTimingPayload({
      total_ms: 12.6,
      fetch_k: 4,
      skipped: undefined,
      llm_first_token_ms: null,
    })).toEqual({
      total_ms: 13,
      fetch_k: 4,
      llm_first_token_ms: null,
    });
  });
});

describe('formatTimingFooter', () => {
  it('uses ms suffixes only for *_ms fields', () => {
    expect(formatTimingFooter('Timing', {
      requested_mode: 'auto',
      effective_mode: 'hybrid',
      total_ms: 42,
      fetch_k: 4,
    })).toBe('> _Timing (auto -> hybrid): total_ms=42ms, fetch_k=4._');
  });
});
