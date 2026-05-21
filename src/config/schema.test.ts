import { describe, expect, it } from '@jest/globals';

import { parseDotEnvText, validateConfigEnv } from './schema.js';

describe('config schema validation (FR-OBS-470)', () => {
  it('emits ok findings and counts for valid known environment variables', () => {
    const report = validateConfigEnv({
      EMBEDDING_PROVIDER: 'fake',
      KB_FAKE_DIM: '512',
      KB_RERANK: 'on',
      KB_RERANK_MODEL: 'Xenova/ms-marco-MiniLM-L-6-v2',
      KB_RERANK_TOP_N: '12',
      KB_RELEVANCE_GATE: 'on',
      KB_GATE_LLM_ENDPOINT: 'http://127.0.0.1:8080/v1/chat/completions',
      KB_GATE_SCORE_FLOOR: '0.75',
      KB_AGE_BUDGET_HOURS_ALPHA: '24',
      MCP_TRANSPORT: 'http',
      MCP_AUTH_TOKEN: 'x'.repeat(32),
      MCP_PORT: '8765',
    }, { source: 'process.env' });

    expect(report.schema_version).toBe('kb.config-validate.v1');
    expect(report.status).toBe('ok');
    expect(report.counts.error).toBe(0);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'EMBEDDING_PROVIDER', status: 'ok', value: 'fake' }),
      expect.objectContaining({ name: 'KB_AGE_BUDGET_HOURS_ALPHA', status: 'ok', value: '24' }),
      expect.objectContaining({ name: 'KB_RERANK_TOP_N', status: 'ok', value: '12' }),
      expect.objectContaining({ name: 'MCP_AUTH_TOKEN', status: 'ok', value: '<redacted>' }),
    ]));
  });

  it('emits errors for invalid booleans, enums, numbers, ranges, and URLs', () => {
    const report = validateConfigEnv({
      EMBEDDING_PROVIDER: 'bogus',
      KB_RERANK: 'maybe',
      KB_RERANK_TOP_N: '1001',
      KB_GATE_SCORE_FLOOR: '0.95.0',
      KB_GATE_LLM_ENDPOINT: 'not a url',
      MCP_PORT: '70000',
    }, { source: '/tmp/bad.env' });

    expect(report.status).toBe('error');
    expect(report.counts.error).toBeGreaterThanOrEqual(6);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'EMBEDDING_PROVIDER', status: 'error', message: expect.stringContaining('expected one of') }),
      expect.objectContaining({ name: 'KB_RERANK', status: 'error', message: expect.stringContaining('expected boolean') }),
      expect.objectContaining({ name: 'KB_RERANK_TOP_N', status: 'error', message: expect.stringContaining('<= 1000') }),
      expect.objectContaining({ name: 'KB_GATE_SCORE_FLOOR', status: 'error', message: expect.stringContaining('number') }),
      expect.objectContaining({ name: 'KB_GATE_LLM_ENDPOINT', status: 'error', message: expect.stringContaining('URL') }),
      expect.objectContaining({ name: 'MCP_PORT', status: 'error', message: expect.stringContaining('<= 65535') }),
    ]));
    expect(report.findings.every((finding) => finding.source === '/tmp/bad.env')).toBe(true);
  });

  it('matches strict runtime parsers for reranker booleans and digit-only integers', () => {
    const report = validateConfigEnv({
      KB_RERANK: 'yes',
      KB_RERANK_TOP_N: '1e2',
      KB_INDEX_VERSION_RETENTION: '0',
    });

    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'KB_RERANK', status: 'error' }),
      expect.objectContaining({ name: 'KB_RERANK_TOP_N', status: 'error', message: expect.stringContaining('integer') }),
      expect.objectContaining({ name: 'KB_INDEX_VERSION_RETENTION', status: 'ok', value: '0' }),
    ]));
  });

  it('emits static dependency findings without probing live endpoints', () => {
    const report = validateConfigEnv({
      KB_RELEVANCE_GATE: 'on',
      KB_CONTEXTUAL_RETRIEVAL: 'on',
      MCP_TRANSPORT: 'sse',
      MCP_AUTH_TOKEN: 'short',
    }, { source: 'process.env' });

    expect(report.status).toBe('error');
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'KB_RELEVANCE_GATE',
        status: 'warn',
        message: expect.stringContaining('KB_GATE_LLM_ENDPOINT or KB_LLM_ENDPOINT'),
      }),
      expect.objectContaining({
        name: 'KB_CONTEXTUAL_RETRIEVAL',
        status: 'error',
        message: expect.stringContaining('KB_LLM_ENDPOINT'),
      }),
      expect.objectContaining({
        name: 'MCP_AUTH_TOKEN',
        status: 'error',
        message: expect.stringContaining('at least 32 characters'),
      }),
    ]));
  });

  it('parses dotenv comments, export prefixes, quotes, escapes, and inline comments', () => {
    const parsed = parseDotEnvText(`
      # comment
      export KB_RERANK=on
      KB_RERANK_MODEL="local\\tmodel # not comment"
      KB_GATE_LLM_ENDPOINT='http://127.0.0.1:8080/v1/chat/completions'
      KB_GATE_JUDGE_INPUT=5 # inline comment
      EMPTY=
    `);

    expect(parsed.env).toMatchObject({
      KB_RERANK: 'on',
      KB_RERANK_MODEL: 'local\tmodel # not comment',
      KB_GATE_LLM_ENDPOINT: 'http://127.0.0.1:8080/v1/chat/completions',
      KB_GATE_JUDGE_INPUT: '5',
      EMPTY: '',
    });
    expect(parsed.errors).toEqual([]);
  });
});
