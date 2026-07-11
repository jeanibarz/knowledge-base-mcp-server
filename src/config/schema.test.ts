import { describe, expect, it } from '@jest/globals';

import { CONFIG_SCHEMA, isRegisteredConfigName, parseDotEnvText, showConfigEnv, validateConfigEnv } from './schema.js';

describe('config schema validation (FR-OBS-470)', () => {
  it('emits ok findings and counts for valid known environment variables', () => {
    const report = validateConfigEnv({
      EMBEDDING_PROVIDER: 'fake',
      KB_FAKE_DIM: '512',
      KB_RERANK: 'on',
      KB_RERANK_MODEL: 'Xenova/ms-marco-MiniLM-L-6-v2',
      KB_RERANK_TOP_N: '12',
      KB_RERANK_BATCH_SIZE: '16',
      KB_RELEVANCE_GATE: 'on',
      KB_GATE_LLM_ENDPOINT: 'http://127.0.0.1:8080/v1/chat/completions',
      KB_GATE_SCORE_FLOOR: '0.75',
      KB_FLAT_SEARCH_P95_ADVISORY_MS: '75',
      KB_DAEMON_CLIENT_TIMEOUT_MS: '1500',
      KB_DAEMON_HEALTH_TIMEOUT_MS: '500',
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
      expect.objectContaining({ name: 'KB_DAEMON_CLIENT_TIMEOUT_MS', status: 'ok', value: '1500' }),
      expect.objectContaining({ name: 'KB_DAEMON_HEALTH_TIMEOUT_MS', status: 'ok', value: '500' }),
      expect.objectContaining({ name: 'KB_RERANK_TOP_N', status: 'ok', value: '12' }),
      expect.objectContaining({ name: 'KB_RERANK_BATCH_SIZE', status: 'ok', value: '16' }),
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
      KB_DAEMON_CLIENT_TIMEOUT_MS: '0',
      KB_DAEMON_HEALTH_TIMEOUT_MS: '300001',
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
      expect.objectContaining({ name: 'KB_DAEMON_CLIENT_TIMEOUT_MS', status: 'error', message: expect.stringContaining('>= 1') }),
      expect.objectContaining({ name: 'KB_DAEMON_HEALTH_TIMEOUT_MS', status: 'error', message: expect.stringContaining('<= 300000') }),
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

describe('CONFIG_SCHEMA registrations for env-usage guard baseline (#776)', () => {
  const baselinedNames = [
    'KB_DECOMPOSE_LLM_ENDPOINT',
    'KB_DECOMPOSE_LLM_MODEL',
    'KB_DENSE_DEGRADE_ON_PROVIDER_ERROR',
    'KB_EMBEDDING_TASK_PREFIXES',
    'KB_LOG_MAX_BYTES',
    'KB_LOG_MAX_FILES',
    'KB_MAX_FILTER_ITEMS',
    'KB_MAX_GLOB_CHARS',
    'KB_MAX_GLOB_WILDCARDS',
    'KB_MAX_QUERY_CHARS',
    'KB_MIN_FREE_DISK_BYTES',
    'KB_RERANK_CACHE',
    'KB_RERANK_CACHE_DISK_MAX_BYTES',
    'KB_RERANK_DEVICE',
    'KB_RERANK_DTYPE',
    'KB_SEARCH_SNIPPET',
    'KB_SHIELD',
  ] as const;

  it('registers every previously allowlisted production env read', () => {
    for (const name of baselinedNames) {
      expect(isRegisteredConfigName(name)).toBe(true);
    }
  });

  it('validates representative values for the registered knobs', () => {
    const report = validateConfigEnv({
      KB_DECOMPOSE_LLM_ENDPOINT: 'mock://decompose',
      KB_DECOMPOSE_LLM_MODEL: 'local-model',
      KB_DENSE_DEGRADE_ON_PROVIDER_ERROR: 'on',
      KB_EMBEDDING_TASK_PREFIXES: 'off',
      KB_LOG_MAX_BYTES: '1048576',
      KB_LOG_MAX_FILES: '3',
      KB_MAX_FILTER_ITEMS: '8',
      KB_MAX_GLOB_CHARS: '512',
      KB_MAX_GLOB_WILDCARDS: '12',
      KB_MAX_QUERY_CHARS: '4096',
      KB_MIN_FREE_DISK_BYTES: '0',
      KB_RERANK_CACHE: 'enabled',
      KB_RERANK_CACHE_DISK_MAX_BYTES: '33554432',
      KB_RERANK_DEVICE: 'cuda',
      KB_RERANK_DTYPE: 'fp32',
      KB_SEARCH_SNIPPET: '2',
      KB_SHIELD: 'off',
    });

    expect(report.status).toBe('ok');
    for (const name of baselinedNames) {
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ name, status: 'ok' }),
      ]));
    }
  });

  it('matches runtime parsing for registered free-form knobs', () => {
    const valid = validateConfigEnv({
      KB_SEARCH_SNIPPET: 'yes',
      KB_RERANK_CACHE: 'disabled',
      KB_SHIELD: 'off',
    });
    const invalid = validateConfigEnv({
      KB_SEARCH_SNIPPET: 'garbage',
      KB_RERANK_CACHE: 'yes',
      KB_SHIELD: 'OFF',
    });

    expect(valid.status).toBe('ok');
    expect(invalid.status).toBe('error');
    expect(invalid.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'KB_SEARCH_SNIPPET', status: 'error', message: expect.stringContaining('positive integer') }),
      expect.objectContaining({ name: 'KB_RERANK_CACHE', status: 'error', message: expect.stringContaining('expected boolean') }),
      expect.objectContaining({ name: 'KB_SHIELD', status: 'error', message: expect.stringContaining('expected one of') }),
    ]));
  });

  it('surfaces the registered knobs in config show output', () => {
    const report = showConfigEnv({});
    const names = report.entries.map((entry) => entry.name);

    expect(names).toEqual(expect.arrayContaining([...baselinedNames]));
  });
});
