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
    expect(json.indexOf('"cache"')).toBeLessThan(json.indexOf('"query_cache"'));
    expect(json.indexOf('"error"')).toBeLessThan(json.indexOf('"degraded"'));
    expect(json.indexOf('"degraded"')).toBeLessThan(json.indexOf('"degraded_stages"'));
    expect(json.indexOf('"degraded_stages"')).toBeLessThan(json.indexOf('"degrade_reason"'));
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
