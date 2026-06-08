import { describe, expect, it } from '@jest/globals';

import {
  DEFAULT_RERANK_MODEL,
  DEFAULT_RERANK_TOP_N,
  isRerankSkippedForDomain,
  parseRerankFlag,
  parseRerankTopN,
  parseSkipRerankDomains,
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

  it('selects the reranker model from KB_RERANK_MODEL (the upgrade plug point)', () => {
    // RFC 020 §9 / issue #565 — a Tier-1 reranker upgrade is selected purely by
    // pointing KB_RERANK_MODEL at the candidate; no code change is needed to try
    // bge-reranker-v2-m3 / Qwen3-Reranker through the production path.
    expect(resolveRerankerConfig({ KB_RERANK: 'on', KB_RERANK_MODEL: 'BAAI/bge-reranker-v2-m3' }).model)
      .toBe('BAAI/bge-reranker-v2-m3');
    // Blank model falls back to the default rather than an empty id.
    expect(resolveRerankerConfig({ KB_RERANK: 'on', KB_RERANK_MODEL: '   ' }).model).toBe(DEFAULT_RERANK_MODEL);
  });
});

describe('per-domain skip-rerank fallback (RFC 020 §9)', () => {
  it('parses KB_RERANK_SKIP_DOMAINS into a normalized, deduplicated list', () => {
    expect(parseSkipRerankDomains(undefined)).toEqual([]);
    expect(parseSkipRerankDomains('')).toEqual([]);
    expect(parseSkipRerankDomains('  ,  ,')).toEqual([]);
    expect(parseSkipRerankDomains('code, Skills , CODE')).toEqual(['code', 'skills']);
  });

  it('matches the scoped domain case-insensitively', () => {
    const env = { KB_RERANK_SKIP_DOMAINS: 'code,skills' };
    expect(isRerankSkippedForDomain(env, 'code')).toBe(true);
    expect(isRerankSkippedForDomain(env, 'Code')).toBe(true);
    expect(isRerankSkippedForDomain(env, 'prose')).toBe(false);
    // An unscoped search (no domain) is never skipped — the fallback only fires
    // for an explicitly scoped KB.
    expect(isRerankSkippedForDomain(env, null)).toBe(false);
    expect(isRerankSkippedForDomain(env, undefined)).toBe(false);
    expect(isRerankSkippedForDomain({}, 'code')).toBe(false);
  });

  it('force-disables reranking for a skip domain even under KB_RERANK=on or override=on', () => {
    const env = { KB_RERANK: 'on', KB_RERANK_SKIP_DOMAINS: 'code,skills' };
    // Enabled for a non-skip domain...
    expect(resolveRerankerConfig(env, undefined, 'prose').enabled).toBe(true);
    // ...skipped for a listed high-precision/lexical domain (the §9 fallback),
    // and the skip is authoritative: an explicit override=on does not re-enable it.
    expect(resolveRerankerConfig(env, undefined, 'code').enabled).toBe(false);
    expect(resolveRerankerConfig(env, 'on', 'skills').enabled).toBe(false);
    // A null/omitted domain (unscoped search) is unaffected.
    expect(resolveRerankerConfig(env, undefined, null).enabled).toBe(true);
    expect(resolveRerankerConfig(env).enabled).toBe(true);
  });
});
