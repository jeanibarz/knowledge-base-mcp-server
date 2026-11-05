import {
  CANONICAL_SCHEMA_VERSION,
  canonicalErrorFromToolResult,
  deriveDegradedStages,
  hashQuery,
  normalizeCanonicalEvent,
  stableCanonicalJson,
  type CanonicalLogEvent,
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
    // `query_sha256` is the first 16 hex chars of sha256 over the *normalized*
    // query (trimmed, inner whitespace collapsed). Pin the literal so a
    // regression in the digest algorithm or the 16-char slice fails here
    // instead of silently tracking the implementation (both sides would change
    // together if we only compared against hashQuery(...)).
    expect(event.query_sha256).toBe('9b74198c555ecc87');
    // The raw padded/duplicate-space query must still hash to the normalized
    // form — this second assertion guards the normalization step specifically.
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

// Issue #1127 — guard the hand-maintained CANONICAL_FIELD_ORDER array against
// the CanonicalLogEvent interface. stableCanonicalJson() serializes *only* the
// keys listed in CANONICAL_FIELD_ORDER, so a field added to the interface but
// forgotten in the array is silently dropped from every emitted log line — the
// compiler can't catch it, because `readonly (keyof CanonicalLogEvent)[]`
// validates that entries are valid keys, not that all keys are present.
//
// Two layers guard the two directions:
//   1. Compile-time (tsc -p tsconfig.tests.json, run by `npm test`): the
//      `Required<CanonicalLogEvent>` annotation below fails to build if a new
//      interface field is not added to this sample, forcing the sample current.
//   2. Runtime (this test): once the sample has the new key, serializing it
//      reveals whether CANONICAL_FIELD_ORDER carries that key — if not, the key
//      is absent from the output and the parity assertion fails.
// The reverse direction (a stale CANONICAL_FIELD_ORDER entry no longer on the
// interface) is already a compile error from the array's own `keyof` typing.
describe('CANONICAL_FIELD_ORDER / CanonicalLogEvent parity (#1127)', () => {
  // A maximal event with *every* CanonicalLogEvent key populated. The
  // `Required<CanonicalLogEvent>` annotation makes a newly added interface
  // field a compile error here until it is added to this literal — the first
  // half of the guard.
  const fullyPopulatedEvent: Required<CanonicalLogEvent> = {
    schema_version: CANONICAL_SCHEMA_VERSION,
    ts: '2026-05-12T00:00:00.000Z',
    request_id: 'req-parity',
    process: 'mcp',
    event: 'search',
    level: 'warn',
    slow: true,
    tool: 'retrieve_knowledge',
    cmd: 'search',
    model_id: 'fake__model',
    kb_scope: 'all',
    query_sha256: 'deadbeefdeadbeef',
    query_len_chars: 10,
    k: 5,
    threshold: 0.5,
    search_mode: 'hybrid',
    result_count: 3,
    top_score: 0.9,
    top_sources: ['a.md'],
    kb_failures: 1,
    failed_kbs: ['kb-broken'],
    took_ms: 12,
    lock_wait_ms: 1,
    lock_hold_ms: 2,
    lock_resource_kind: 'model_index',
    embed_ms: 3,
    faiss_ms: 4,
    format_ms: 5,
    cache: 'memory_hit',
    query_cache: { enabled: true, outcome: 'memory_hit', model_id: 'fake__model', elapsed_ms: 1 },
    error: { code: 'PROVIDER_TIMEOUT', category: 'provider' },
    degraded: true,
    degraded_stages: [{ stage: 'dense', reason: 'provider_timeout' }],
    degrade_reason: 'provider_timeout',
    recovery_hint: 'retry with a broader kb scope',
    rerank: { degraded: false, degrade_reason: null },
    gate: { state: 'passed', degraded: false },
    secret_scan: { findings: 0 },
    llm_provider: 'llama',
  };

  it('emits every CanonicalLogEvent field — none silently dropped by a stale CANONICAL_FIELD_ORDER', () => {
    // Guard precondition: every sample value is defined, so the only reason a
    // key could be absent from the output is CANONICAL_FIELD_ORDER not listing
    // it (stableCanonicalJson skips undefined values).
    const eventKeys = Object.keys(fullyPopulatedEvent);
    expect(
      eventKeys.every((key) => fullyPopulatedEvent[key as keyof CanonicalLogEvent] !== undefined),
    ).toBe(true);

    const emitted = JSON.parse(stableCanonicalJson(fullyPopulatedEvent)) as Record<string, unknown>;
    const emittedKeys = Object.keys(emitted);

    // Fully-populated event must emit every field in the output line. Any key
    // listed here is present on the interface but missing from
    // CANONICAL_FIELD_ORDER (or dropped from serialization for another reason).
    const missingFromOutput = eventKeys.filter((key) => !emittedKeys.includes(key));
    expect(missingFromOutput).toEqual([]);

    // Symmetric check: the serializer must not invent keys beyond the schema.
    const unexpectedInOutput = emittedKeys.filter((key) => !eventKeys.includes(key));
    expect(unexpectedInOutput).toEqual([]);

    // Belt-and-suspenders count: output key set equals the full event key set.
    expect(emittedKeys.length).toBe(eventKeys.length);
  });
});
