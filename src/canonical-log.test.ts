import {
  CANONICAL_SCHEMA_VERSION,
  canonicalErrorFromToolResult,
  hashQuery,
  normalizeCanonicalEvent,
  stableCanonicalJson,
} from './canonical-log.js';

describe('canonical log line schema (#216)', () => {
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
    });
    expect(json.indexOf('"schema_version"')).toBeLessThan(json.indexOf('"request_id"'));
    expect(json.indexOf('"top_sources"')).toBeLessThan(json.indexOf('"took_ms"'));
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
});
