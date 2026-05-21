import { describe, expect, it, jest } from '@jest/globals';
import {
  formatDenseCoverageSection,
  formatContextualSection,
  formatRemoteTransportSection,
  runStats,
  type RunStatsDeps,
} from './cli-stats.js';
import type { FaissIndexManager } from './FaissIndexManager.js';
import type { KbStatsContextualPrefaceBlock, KbStatsPayload } from './kb-stats.js';
import { KBError } from './errors.js';

function payload(): KbStatsPayload {
  return {
    knowledge_bases: {
      beta: {
        file_count: 1,
        chunk_count: 3,
        total_bytes_indexed: 100,
        last_updated_at: null,
      },
      alpha: {
        file_count: 2,
        chunk_count: 4,
        total_bytes_indexed: 16,
        last_updated_at: '2026-05-09T18:42:18.460Z',
      },
    },
    quarantined: {
      beta: 0,
      alpha: 0,
    },
    embedding: {
      provider: 'ollama',
      model: 'nomic-embed-text:latest',
      dim: 768,
    },
    index_path: '/tmp/kb-index',
    last_index_update: {
      status: 'never_run',
      scope: null,
      model_id: 'ollama__nomic-embed-text-latest',
      started_at: null,
      finished_at: null,
      duration_ms: null,
      files_scanned: 0,
      files_changed: 0,
      files_unchanged: 0,
      files_skipped: 0,
      chunks_attempted: 0,
      chunks_added: 0,
      index_mutated: false,
      saved: false,
      sidecars_written: false,
      warning_count: 0,
      warnings: [],
      failure_count: 0,
      failures: [],
    },
    server: {
      version: 'test-version',
      uptime_ms: 12,
    },
    // Issue #210 — required since the KbStatsPayload now carries
    // per-model provider call telemetry. Empty `{}` matches a fresh
    // process where the active provider has not been called yet.
    provider_calls: {},
    query_cache: {
      hits: 0,
      misses: 0,
      hit_ratio: 0,
      l1_hits: 0,
      disk_hits: 0,
      bypasses: 0,
      writes: 0,
      corruptions: 0,
      l1_size: 0,
      disk_size_bytes: 0,
    },
    relevance_gate: {
      gated_queries: 0,
      verdict_injected: 0,
      verdict_no_relevant_context: 0,
      verdict_empty_index: 0,
      low_confidence_rate: 0,
      drop_rate_A1: 0,
      drop_rate_A2: 0,
      drop_rate_B: 0,
      judge_degrade_rate: 0,
      judge_window: {
        size: 0,
        degraded: 0,
        rate: 0,
        warn_threshold: 0.1,
      },
    },
  };
}

function contextualBlock(
  over: Partial<KbStatsContextualPrefaceBlock> = {},
): KbStatsContextualPrefaceBlock {
  return {
    enabled: true,
    reindex_state: 'completed',
    last_completed_at: '2026-05-18T00:00:00.000Z',
    covered_chunks: 4,
    null_preface_chunks: 0,
    coverage_pct: 100,
    cache_bytes: 1024,
    model: 'mock-llm',
    generator: 'contextual-preface.v1',
    failures: { retry_pending: 0, by_error_code: {} },
    ...over,
  };
}

function makeDeps(opts: {
  payload?: KbStatsPayload;
  computeError?: Error;
} = {}): {
  deps: RunStatsDeps;
  stdout: string[];
  stderr: string[];
  manager: FaissIndexManager & { updateIndex: jest.Mock };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const manager = {
    updateIndex: jest.fn(),
  } as unknown as FaissIndexManager & { updateIndex: jest.Mock };

  const deps: RunStatsDeps = {
    bootstrapLayout: jest.fn(async () => {}),
    resolveActiveModel: jest.fn(async () => 'ollama__nomic-embed-text-latest'),
    loadManagerForModel: jest.fn(async () => manager),
    loadWithJsonRetry: jest.fn(async () => {}),
    computeKbStats: jest.fn(async () => {
      if (opts.computeError !== undefined) throw opts.computeError;
      return opts.payload ?? payload();
    }),
    readPackageVersion: jest.fn(() => '1.2.3'),
    stdout: (text) => { stdout.push(text); },
    stderr: (text) => { stderr.push(text); },
  };
  return { deps, stdout, stderr, manager };
}

describe('kb stats CLI', () => {
  it('prints the computeKbStats payload unchanged as JSON', async () => {
    const { deps, stdout, stderr, manager } = makeDeps();

    const code = await runStats(['--format=json'], deps);

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    expect(JSON.parse(stdout.join(''))).toEqual(payload());
    expect(deps.bootstrapLayout).toHaveBeenCalledTimes(1);
    expect(deps.resolveActiveModel).toHaveBeenCalledTimes(1);
    expect(deps.loadManagerForModel).toHaveBeenCalledWith('ollama__nomic-embed-text-latest');
    expect(deps.loadWithJsonRetry).toHaveBeenCalledWith(manager);
    expect(manager.updateIndex).not.toHaveBeenCalled();
  });

  it('passes --kb through as knowledgeBaseName without mutating the payload shape', async () => {
    const scoped = payload();
    scoped.knowledge_bases = { alpha: scoped.knowledge_bases.alpha };
    const { deps, stdout } = makeDeps({ payload: scoped });

    const code = await runStats(['--kb=alpha', '--format=json'], deps);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toEqual(scoped);
    expect(deps.computeKbStats).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        knowledgeBaseName: 'alpha',
        serverVersion: '1.2.3',
      }),
    );
  });

  it('formats markdown as a compact table plus index metadata', async () => {
    const { deps, stdout } = makeDeps();

    const code = await runStats([], deps);

    expect(code).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('# KB Stats');
    expect(out).toContain('| alpha | 2 | 4 | 16 | 2026-05-09T18:42:18.460Z |');
    expect(out).toContain('| beta | 1 | 3 | 100 | never |');
    expect(out).toContain('- Provider: ollama');
    expect(out).toContain('- Model: nomic-embed-text:latest');
    expect(out).toContain('- Index type: flat');
    expect(out).toContain('- Index path: `/tmp/kb-index`');
    expect(out).toContain('## Relevance Gate');
    expect(out).toContain('- Gated queries: 0');
  });

  it('diagnoses shelves with files but zero dense chunks in markdown stats', async () => {
    const scoped = payload();
    scoped.knowledge_bases.beta.chunk_count = 0;
    scoped.last_index_update = {
      ...scoped.last_index_update,
      status: 'success',
      scope: 'alpha',
      chunks_added: 4,
      finished_at: '2026-05-21T09:00:00.000Z',
    };
    const { deps, stdout } = makeDeps({ payload: scoped });

    const code = await runStats([], deps);

    expect(code).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('## Dense Coverage');
    expect(out).toContain('Knowledge bases with files but 0 dense chunks: `beta` (1 file).');
    expect(out).toContain('Last index update: status=success, scope=kb:alpha, chunks_added=4');
    expect(out).toContain('latest refresh was scoped outside these knowledge bases');
    expect(out).toContain('likely index-scope state rather than missing source files');
    expect(out).toContain('kb search "known phrase" --kb=<name> --refresh');
  });

  it('uses the generic dense coverage interpretation when the latest refresh was not scoped elsewhere', () => {
    const scoped = payload();
    scoped.knowledge_bases.beta.chunk_count = 0;
    scoped.last_index_update = {
      ...scoped.last_index_update,
      status: 'success',
      scope: 'global',
      chunks_added: 4,
      finished_at: '2026-05-21T09:00:00.000Z',
    };

    const lines = formatDenseCoverageSection(scoped);

    expect(lines.join('\n')).toContain(
      'source files exist on disk, but the active dense index has no chunks for these knowledge bases',
    );
    expect(lines.join('\n')).not.toContain('latest refresh was scoped outside');
  });

  it('omits the dense coverage section when every file-backed shelf has chunks', () => {
    expect(formatDenseCoverageSection(payload())).toEqual([]);
  });

  it('renders a Remote Transport section when HTTP/SSE counters are present (#430)', async () => {
    const withTransport = payload();
    withTransport.remote_transport = {
      transport: 'http',
      sessions_opened: 3,
      sessions_closed: 1,
      current_sessions: 2,
      in_flight_requests: 4,
      requests_total: 12,
      response_status_buckets: {
        '1xx': 0,
        '2xx': 8,
        '3xx': 0,
        '4xx': 3,
        '5xx': 1,
      },
      auth_failures: 2,
      origin_denials: 1,
      last_error: {
        at: '2026-05-20T07:00:00.000Z',
        message: 'client socket error',
      },
    };
    const { deps, stdout } = makeDeps({ payload: withTransport });

    const code = await runStats([], deps);

    expect(code).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('## Remote Transport');
    expect(out).toContain('- Mode: http');
    expect(out).toContain('- Sessions: current=2, opened=3, closed=1');
    expect(out).toContain('- Requests: total=12, in_flight=4, 1xx=0, 2xx=8, 3xx=0, 4xx=3, 5xx=1');
    expect(out).toContain('- Auth failures: 2');
    expect(out).toContain('- Origin denials: 1');
    expect(out).toContain('- Last error: 2026-05-20T07:00:00.000Z client socket error');
  });

  it('omits the Remote Transport section for stdio/local stats payloads (#430)', () => {
    expect(formatRemoteTransportSection(payload())).toEqual([]);
  });

  it('renders a Contextual Retrieval section in markdown when sidecars exist (#409)', async () => {
    const withContext = payload();
    withContext.knowledge_bases.alpha.contextual_preface = contextualBlock({
      reindex_state: 'partial',
      covered_chunks: 54,
      null_preface_chunks: 7,
      coverage_pct: 88.5,
      failures: { retry_pending: 3, by_error_code: { llm_unreachable: 5, llm_malformed: 2 } },
    });
    withContext.knowledge_bases.beta.contextual_preface = contextualBlock({
      reindex_state: 'never',
      covered_chunks: 0,
      coverage_pct: 0,
    });
    const { deps, stdout } = makeDeps({ payload: withContext });

    const code = await runStats([], deps);

    expect(code).toBe(0);
    const out = stdout.join('');
    expect(out).toContain('## Contextual Retrieval');
    expect(out).toContain('- Feature flag: enabled');
    // The `partial` KB renders; the `never` KB is folded away.
    expect(out).toContain('| alpha | partial | 88.5% | 54 | 7 | 3 | llm_unreachable=5, llm_malformed=2 |');
    expect(out).not.toContain('| beta | never |');
  });

  it('folds the contextual section to one line when no KB has sidecars (#409)', () => {
    const lines = formatContextualSection({
      knowledge_bases: {
        alpha: {
          file_count: 1,
          chunk_count: 2,
          total_bytes_indexed: 10,
          last_updated_at: null,
          contextual_preface: contextualBlock({ enabled: false, reindex_state: 'never' }),
        },
      },
    } as unknown as KbStatsPayload);
    expect(lines).toContain('## Contextual Retrieval');
    expect(lines).toContain('- Feature flag: disabled');
    expect(lines).toContain('- No contextual-preface sidecars on disk yet.');
  });

  it('returns exit 2 for argv errors', async () => {
    const { deps, stdout, stderr } = makeDeps();

    const code = await runStats(['--bogus'], deps);

    expect(code).toBe(2);
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toContain('kb stats: unknown flag: --bogus');
    expect(deps.bootstrapLayout).not.toHaveBeenCalled();
  });

  it('classifies unknown KB errors as JSON when requested', async () => {
    const { deps, stdout, stderr } = makeDeps({
      computeError: new KBError('KB_NOT_FOUND', 'Knowledge base "missing" not found.'),
    });

    const code = await runStats(['--kb=missing', '--format=json'], deps);

    expect(code).toBe(2);
    expect(stderr.join('')).toBe('');
    expect(JSON.parse(stdout.join(''))).toEqual({
      error: {
        code: 'KB_NOT_FOUND',
        category: 'configuration',
        message: 'Knowledge base "missing" not found.',
        next_action:
          'Run `kb list` to see registered knowledge bases, then re-run search with a valid `--kb=<name>` (or omit it to search across all KBs).',
      },
    });
  });
});
