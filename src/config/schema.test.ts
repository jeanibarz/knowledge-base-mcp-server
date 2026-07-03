import { describe, expect, it } from '@jest/globals';

import { CONFIG_SCHEMA, parseDotEnvText, showConfigEnv, validateConfigEnv } from './schema.js';

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
      KB_FLAT_SEARCH_P95_ADVISORY_MS: '75',
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
      expect.objectContaining({ name: 'KB_FLAT_SEARCH_P95_ADVISORY_MS', status: 'ok', value: '75' }),
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
      KB_FLAT_SEARCH_P95_ADVISORY_MS: '0',
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
      expect.objectContaining({ name: 'KB_FLAT_SEARCH_P95_ADVISORY_MS', status: 'error', message: expect.stringContaining('>= 1') }),
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

  it('matches the runtime KB_INDEX_TYPE parser for case-insensitive values', () => {
    const validation = validateConfigEnv({
      KB_INDEX_TYPE: ' HNSW ',
      KB_HNSW_M: '32',
      KB_HNSW_EF_CONSTRUCTION: '200',
      KB_HNSW_EF_SEARCH: '100',
    });
    const show = showConfigEnv({
      KB_INDEX_TYPE: ' HNSW ',
    });

    expect(validation.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'KB_INDEX_TYPE', status: 'ok', value: 'hnsw' }),
      expect.objectContaining({ name: 'KB_HNSW_M', status: 'ok', value: '32' }),
      expect.objectContaining({ name: 'KB_HNSW_EF_CONSTRUCTION', status: 'ok', value: '200' }),
      expect.objectContaining({ name: 'KB_HNSW_EF_SEARCH', status: 'ok', value: '100' }),
    ]));
    expect(show.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'KB_INDEX_TYPE', value: 'hnsw', source: 'env' }),
      expect.objectContaining({ name: 'KB_HNSW_M', value: '32', source: 'default' }),
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

  it('accepts MCP_AUTH_TOKEN_FILE as the remote transport bearer source', () => {
    const report = validateConfigEnv({
      MCP_TRANSPORT: 'http',
      MCP_AUTH_TOKEN: 'short-env-fallback',
      MCP_AUTH_TOKEN_FILE: '/run/secrets/kb-mcp-token',
    });

    expect(report.status).toBe('ok');
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'MCP_AUTH_TOKEN_FILE',
        status: 'ok',
        value: '/run/secrets/kb-mcp-token',
      }),
    ]));
    expect(report.findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'MCP_AUTH_TOKEN',
        status: 'error',
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

  it('emits effective config entries with env/default provenance', () => {
    const report = showConfigEnv({
      EMBEDDING_PROVIDER: 'ollama',
      KNOWLEDGE_BASES_ROOT_DIR: '/tmp/kbs',
      HUGGINGFACE_API_KEY: 'hf_secret',
    });

    expect(report.schema_version).toBe('kb.config-show.v1');
    expect(report.entries.map((entry) => entry.name)).toEqual(CONFIG_SCHEMA.map((spec) => spec.name));
    expect(report.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'KNOWLEDGE_BASES_ROOT_DIR',
        value: '/tmp/kbs',
        source: 'env',
        redacted: false,
      }),
      expect.objectContaining({
        name: 'FAISS_INDEX_PATH',
        value: '/tmp/kbs/.faiss',
        source: 'default',
        redacted: false,
      }),
      expect.objectContaining({
        name: 'INDEXING_BATCH_SIZE',
        value: '16',
        source: 'default',
        redacted: false,
      }),
      expect.objectContaining({
        name: 'KB_INDEXING_CONCURRENCY',
        value: '1',
        source: 'default',
        redacted: false,
      }),
      expect.objectContaining({
        name: 'HUGGINGFACE_API_KEY',
        value: '<redacted>',
        source: 'env',
        redacted: true,
      }),
      expect.objectContaining({
        name: 'KB_CONTEXTUAL_MAX_TOKENS',
        value: '150',
        source: 'default',
        redacted: false,
      }),
      expect.objectContaining({
        name: 'KB_INGEST_SECRET_SCAN',
        value: 'off',
        source: 'default',
        redacted: false,
      }),
      expect.objectContaining({
        name: 'KB_FLAT_SEARCH_P95_ADVISORY_MS',
        value: '50',
        source: 'default',
        redacted: false,
      }),
    ]));
  });

  it('uses runtime defaults for empty string values that runtime treats as unset', () => {
    const report = showConfigEnv({
      HUGGINGFACE_MODEL_NAME: '',
    });

    expect(report.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'HUGGINGFACE_MODEL_NAME',
        value: 'BAAI/bge-small-en-v1.5',
        source: 'default',
      }),
      expect.objectContaining({
        name: 'HUGGINGFACE_ENDPOINT_URL',
        value: 'https://router.huggingface.co/hf-inference/models/BAAI/bge-small-en-v1.5/pipeline/feature-extraction',
        source: 'default',
      }),
    ]));
  });

  it('filters effective config entries to non-default values', () => {
    const report = showConfigEnv({
      KB_RELEVANCE_GATE: 'on',
      KB_QUERY_CACHE: '',
    }, { nonDefaultOnly: true });

    expect(report.entries).toEqual([
      {
        name: 'KB_RELEVANCE_GATE',
        kind: 'boolean',
        value: 'on',
        source: 'env',
        redacted: false,
      },
    ]);
  });

  it('keeps schema documentation metadata portable', () => {
    const names = CONFIG_SCHEMA.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);

    const dynamicDefaultSpecs = CONFIG_SCHEMA.filter((spec) => spec.defaultValue !== undefined);
    expect(dynamicDefaultSpecs.length).toBeGreaterThan(0);
    for (const spec of dynamicDefaultSpecs) {
      expect(spec.docDefault).toEqual(expect.any(String));
      expect(spec.docDefault).not.toContain('/home/');
      expect(spec.docDefault).not.toContain('/Users/');
      expect(spec.docDefault).not.toMatch(/[A-Za-z]:\\Users\\/);
    }
  });
});
