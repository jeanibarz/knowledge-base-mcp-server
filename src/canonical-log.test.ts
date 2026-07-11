import {
  CANONICAL_SCHEMA_VERSION,
  canonicalErrorFromToolResult,
  deriveDegradedStages,
  hashQuery,
  normalizeCanonicalEvent,
  stableCanonicalJson,
} from './canonical-log.js';
import { parseKBSlowQueryMs } from './config/logging.js';

describe('canonical log line schema (#216)', () => {
  const originalSlowQueryMs = process.env.KB_SLOW_QUERY_MS;

  afterEach(() => {
    if (originalSlowQueryMs === undefined) delete process.env.KB_SLOW_QUERY_MS;
    else process.env.KB_SLOW_QUERY_MS = originalSlowQueryMs;
  });

  it('pins schema version and redacts raw queries to a stable sha256 prefix', () => {
    const query = '  rollback   procedure  ';
    const event = normalizeCanonicalEvent({
      request_id: 'req-test',
      ts: '2026-05-12T00:00:00.000Z',
      process: 'mcp',
      tool: 'retrieve_knowledge',
      query,
      took_ms: 12.4,
    });

    expect(event.schema_version).toBe(CANONICAL_SCHEMA_VERSION);
    expect(event.query_sha256).toBe(hashQuery('rollback procedure'));
    expect(event.query_len_chars).toBe(query.length);
    expect(JSON.stringify(event)).not.toContain('rollback');
    expect(event.took_ms).toBe(12);
  });

  it('caps top_sources at three and serializes in canonical field order', () => {
    const event = normalizeCanonicalEvent({
      request_id: 'req-test',
      ts: '2026-05-12T00:00:00.000Z',
      process: 'mcp',
      tool: 'retrieve_knowledge',
      took_ms: 5,
      top_sources: ['a.md', 'b.md', 'c.md', 'd.md'],
      lock_wait_ms: 1.2,
      lock_hold_ms: 8.7,
      lock_resource_kind: 'model_index',
      cache: 'memory_hit',
      query_cache: {
        enabled: true,
        outcome: 'memory_hit',
        model_id: 'fake__model',
        elapsed_ms: 1,
      },
      error: { code: 'PROVIDER_TIMEOUT', category: 'provider' },
      degraded: true,
      degraded_stages: [{ stage: 'dense', reason: 'provider_timeout' }],
      degrade_reason: 'provider_timeout',
    });

    const json = stableCanonicalJson(event);
    expect(JSON.parse(json)).toEqual({
      schema_version: 'kb-canonical.v1',
      ts: '2026-05-12T00:00:00.000Z',
      request_id: 'req-test',
      process: 'mcp',
      tool: 'retrieve_knowledge',
      top_sources: ['a.md', 'b.md', 'c.md'],
      took_ms: 5,
      lock_wait_ms: 1,
      lock_hold_ms: 9,
      lock_resource_kind: 'model_index',
      cache: 'memory_hit',
      query_cache: {
        enabled: true,
        outcome: 'memory_hit',
        model_id: 'fake__model',
        elapsed_ms: 1,
      },
      error: { code: 'PROVIDER_TIMEOUT', category: 'provider' },
      degraded: true,
      degraded_stages: [{ stage: 'dense', reason: 'provider_timeout' }],
      degrade_reason: 'provider_timeout',
    });
    expect(json.indexOf('"schema_version"')).toBeLessThan(json.indexOf('"request_id"'));
    expect(json.indexOf('"top_sources"')).toBeLessThan(json.indexOf('"took_ms"'));
    expect(json.indexOf('"took_ms"')).toBeLessThan(json.indexOf('"lock_wait_ms"'));
    expect(json.indexOf('"lock_wait_ms"')).toBeLessThan(json.indexOf('"lock_hold_ms"'));
    expect(json.indexOf('"lock_hold_ms"')).toBeLessThan(json.indexOf('"lock_resource_kind"'));
    expect(json.indexOf('"lock_resource_kind"')).toBeLessThan(json.indexOf('"cache"'));
    expect(json.indexOf('"cache"')).toBeLessThan(json.indexOf('"query_cache"'));
    expect(json.indexOf('"error"')).toBeLessThan(json.indexOf('"degraded"'));
    expect(json.indexOf('"degraded"')).toBeLessThan(json.indexOf('"degraded_stages"'));
    expect(json.indexOf('"degraded_stages"')).toBeLessThan(json.indexOf('"degrade_reason"'));
  });

  // Issue #737 — a partial multi-KB search carries the per-KB fan-out failure
  // count and the failed KB *names* on the canonical line.
  it('carries kb_failures and failed_kbs (names only), capped and ordered', () => {
    const event = normalizeCanonicalEvent({
      request_id: 'req-737',
      ts: '2026-05-12T00:00:00.000Z',
      process: 'cli',
      cmd: 'search',
      took_ms: 7,
      result_count: 3,
      kb_failures: 2,
      failed_kbs: ['kb-broken', 'kb-corrupt'],
    });

    expect(event.kb_failures).toBe(2);
    expect(event.failed_kbs).toEqual(['kb-broken', 'kb-corrupt']);

    const json = stableCanonicalJson(event);
    // Names only — never an absolute path.
    expect(json).not.toContain('/');
    // Canonical field order: kb_failures/failed_kbs sit after top_sources and
    // before took_ms.
    expect(json.indexOf('"kb_failures"')).toBeLessThan(json.indexOf('"failed_kbs"'));
    expect(json.indexOf('"failed_kbs"')).toBeLessThan(json.indexOf('"took_ms"'));
  });

  it('caps failed_kbs to the documented maximum without truncating the count', () => {
    const names = Array.from({ length: 25 }, (_unused, index) => `kb-${index}`);
    const event = normalizeCanonicalEvent({
      request_id: 'req-737-cap',
      ts: '2026-05-12T00:00:00.000Z',
      process: 'cli',
      cmd: 'search',
      took_ms: 7,
      kb_failures: 25,
      failed_kbs: names,
    });

    expect(event.kb_failures).toBe(25);
    expect(event.failed_kbs).toHaveLength(20);
    expect(event.failed_kbs?.[0]).toBe('kb-0');
  });

  it('derives aggregate degraded stages from known classified fallback sub-records', () => {
    const event = normalizeCanonicalEvent({
      request_id: 'req-degraded',
      ts: '2026-05-12T00:00:00.000Z',
      process: 'cli',
      cmd: 'kb search',
      took_ms: 25,
      degraded: true,
      degrade_reason: 'provider_unavailable',
      rerank: {
        degraded: true,
        degrade_reason: 'reranker unavailable',
      },
      gate: {
        degraded: true,
        degrade_reason: 'judge failed',
      },
    });

    expect(event.degraded).toBe(true);
    expect(event.degraded_stages).toEqual([
      { stage: 'dense', reason: 'provider_unavailable' },
      { stage: 'rerank', reason: 'reranker unavailable' },
      { stage: 'gate', reason: 'judge failed' },
    ]);
  });

  it('does not count disabled or successful sub-stages as degraded', () => {
    expect(deriveDegradedStages({
      rerank: { enabled: false, degraded: false, degrade_reason: null },
      gate: { state: 'bypassed', degraded: false, degrade_reason: null },
    })).toEqual([]);
  });

  it('extracts error code and category from MCP tool error payloads', () => {
    const error = canonicalErrorFromToolResult({
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({ error: { code: 'PROVIDER_TIMEOUT' } }),
      }],
    });

    expect(error).toEqual({ code: 'PROVIDER_TIMEOUT', category: 'provider' });
  });

  it('parses KB_SLOW_QUERY_MS as a disabled-by-default positive millisecond threshold', () => {
    expect(parseKBSlowQueryMs(undefined)).toBeUndefined();
    expect(parseKBSlowQueryMs('')).toBeUndefined();
    expect(parseKBSlowQueryMs('0')).toBeUndefined();
    expect(parseKBSlowQueryMs('-1')).toBeUndefined();
    expect(parseKBSlowQueryMs('nope')).toBeUndefined();
    expect(parseKBSlowQueryMs(' 99.6 ')).toBe(100);
  });

  it('marks canonical events as slow warn events when took_ms exceeds KB_SLOW_QUERY_MS', () => {
    process.env.KB_SLOW_QUERY_MS = '100';

    const event = normalizeCanonicalEvent({
      request_id: 'req-slow',
      ts: '2026-05-12T00:00:00.000Z',
      process: 'mcp',
      tool: 'retrieve_knowledge',
      took_ms: 101,
    });

    expect(event.slow).toBe(true);
    expect(event.level).toBe('warn');
  });

  it('does not mark events at or below the slow-query threshold', () => {
    process.env.KB_SLOW_QUERY_MS = '100';

    const event = normalizeCanonicalEvent({
      request_id: 'req-fast',
      ts: '2026-05-12T00:00:00.000Z',
      process: 'mcp',
      tool: 'retrieve_knowledge',
      took_ms: 100,
    });

    expect(event.slow).toBeUndefined();
    expect(event.level).toBeUndefined();
  });

  it('does not mark slow-looking events when KB_SLOW_QUERY_MS is disabled', () => {
    delete process.env.KB_SLOW_QUERY_MS;

    const event = normalizeCanonicalEvent({
      request_id: 'req-disabled',
      ts: '2026-05-12T00:00:00.000Z',
      process: 'mcp',
      tool: 'retrieve_knowledge',
      took_ms: 10_000,
    });

    expect(event.slow).toBeUndefined();
    expect(event.level).toBeUndefined();
  });
});
