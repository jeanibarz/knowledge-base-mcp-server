import { describe, expect, it } from '@jest/globals';

import {
  DEFAULT_RERANK_MODEL,
  DEFAULT_RERANK_TOP_N,
  parseRerankFlag,
  parseRerankTopN,
  resolveRerankerConfig,
} from './reranker.js';

describe('reranker config (RFC 019)', () => {
  it('defaults the reranker off with the fast local model and topN=40', () => {
    expect(resolveRerankerConfig({})).toEqual({
      enabled: false,
      model: DEFAULT_RERANK_MODEL,
      topN: DEFAULT_RERANK_TOP_N,
    });
  });

  it('parses KB_RERANK as an on/off feature flag', () => {
    expect(parseRerankFlag(undefined)).toBe(false);
    expect(parseRerankFlag('')).toBe(false);
    expect(parseRerankFlag('off')).toBe(false);
    expect(parseRerankFlag('false')).toBe(false);
    expect(parseRerankFlag('0')).toBe(false);
    expect(parseRerankFlag('on')).toBe(true);
    expect(parseRerankFlag('true')).toBe(true);
    expect(parseRerankFlag('1')).toBe(true);
    expect(() => parseRerankFlag('maybe')).toThrow(/KB_RERANK/);
  });

  it('parses KB_RERANK_TOP_N as a positive bounded integer', () => {
    expect(parseRerankTopN(undefined)).toBe(DEFAULT_RERANK_TOP_N);
    expect(parseRerankTopN('')).toBe(DEFAULT_RERANK_TOP_N);
    expect(parseRerankTopN('7')).toBe(7);
    expect(() => parseRerankTopN('7.9')).toThrow(/KB_RERANK_TOP_N/);
    expect(() => parseRerankTopN('0')).toThrow(/KB_RERANK_TOP_N/);
    expect(() => parseRerankTopN('1001')).toThrow(/KB_RERANK_TOP_N/);
  });

  it('lets per-call overrides win over the environment flag', () => {
    expect(resolveRerankerConfig({ KB_RERANK: 'off' }, 'on').enabled).toBe(true);
    expect(resolveRerankerConfig({ KB_RERANK: 'on' }, 'off').enabled).toBe(false);
    expect(resolveRerankerConfig({ KB_RERANK: 'on', KB_RERANK_MODEL: 'custom/model', KB_RERANK_TOP_N: '12' })).toEqual({
      enabled: true,
      model: 'custom/model',
      topN: 12,
    });
  });

  it('does not validate reranker-only topN config when reranking is disabled', () => {
    expect(resolveRerankerConfig({ KB_RERANK: 'off', KB_RERANK_TOP_N: 'nope' })).toEqual({
      enabled: false,
      model: DEFAULT_RERANK_MODEL,
      topN: DEFAULT_RERANK_TOP_N,
    });
    expect(resolveRerankerConfig({ KB_RERANK: 'on', KB_RERANK_TOP_N: 'nope' }, 'off')).toEqual({
      enabled: false,
      model: DEFAULT_RERANK_MODEL,
      topN: DEFAULT_RERANK_TOP_N,
    });
    expect(() => resolveRerankerConfig({ KB_RERANK: 'on', KB_RERANK_TOP_N: 'nope' })).toThrow(/KB_RERANK_TOP_N/);
  });
});
