// Issue #209 — focused tests for `kb explain` argv parsing, trace
// serialization, schema_version contract, and repro-bundle redaction.
//
// The end-to-end happy path (live index + real provider) is covered by the
// spawn-based integration suite in cli.test.ts; we keep this file fast and
// hermetic by exercising the pure parts in-process.

import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  EXPLAIN_DEFAULT_K,
  EXPLAIN_DEFAULT_NEAR_MISS,
  parseExplainArgs,
  runExplain,
  type RunExplainDeps,
  writeReproBundle,
} from './cli-explain.js';
import {
  buildCandidates,
  buildQueryBlock,
  deriveDiagnostics,
  EXPLAIN_TRACE_SCHEMA_VERSION,
  formatExplainTraceAsJson,
  formatExplainTraceAsMarkdown,
  previewFromContent,
  type ExplainTrace,
} from './explain-trace.js';

describe('parseExplainArgs', () => {
  it('defaults k to 5 and pads candidates by 5 near-misses', () => {
    const a = parseExplainArgs(['hello']);
    expect(a.query).toBe('hello');
    expect(a.k).toBe(EXPLAIN_DEFAULT_K);
    expect(a.candidates).toBe(EXPLAIN_DEFAULT_K + EXPLAIN_DEFAULT_NEAR_MISS);
    expect(a.format).toBe('md');
    expect(a.threshold).toBe(Number.POSITIVE_INFINITY);
    expect(a.thresholdIsDefault).toBe(true);
    expect(a.reproBundle).toBeNull();
    expect(a.includeContent).toBe(false);
    expect(a.reproBundleForce).toBe(false);
  });

  it('honors explicit --k and grows candidates to k + 5 near-misses', () => {
    const a = parseExplainArgs(['q', '--k=8']);
    expect(a.k).toBe(8);
    expect(a.candidates).toBe(13);
  });

  it('accepts an explicit --candidates value above --k', () => {
    const a = parseExplainArgs(['q', '--k=3', '--candidates=20']);
    expect(a.k).toBe(3);
    expect(a.candidates).toBe(20);
  });

  it('rejects --candidates below --k', () => {
    expect(() => parseExplainArgs(['q', '--k=10', '--candidates=4'])).toThrow(
      /invalid --candidates/,
    );
  });

  it('parses --kb, --model, --format, --threshold', () => {
    const a = parseExplainArgs([
      'q',
      '--kb=runbooks',
      '--model=ollama__nomic-embed-text-latest',
      '--format=json',
      '--threshold=0.4',
    ]);
    expect(a.kb).toBe('runbooks');
    expect(a.model).toBe('ollama__nomic-embed-text-latest');
    expect(a.format).toBe('json');
    expect(a.threshold).toBe(0.4);
    expect(a.thresholdIsDefault).toBe(false);
  });

  it('rejects unknown flags', () => {
    expect(() => parseExplainArgs(['q', '--zzz=1'])).toThrow(/unknown flag/);
  });

  it('rejects invalid --format', () => {
    expect(() => parseExplainArgs(['q', '--format=xml'])).toThrow(/invalid --format/);
  });

  it('rejects invalid --k', () => {
    expect(() => parseExplainArgs(['q', '--k=0'])).toThrow(/invalid --k/);
    expect(() => parseExplainArgs(['q', '--k=abc'])).toThrow(/invalid --k/);
  });

  it('rejects invalid --threshold', () => {
    expect(() => parseExplainArgs(['q', '--threshold=notanumber'])).toThrow(
      /invalid --threshold/,
    );
  });

  it('rejects --include-content without --repro-bundle', () => {
    expect(() => parseExplainArgs(['q', '--include-content'])).toThrow(
      /--include-content requires --repro-bundle/,
    );
  });

  it('accepts --repro-bundle with --include-content', () => {
    const a = parseExplainArgs(['q', '--repro-bundle=./out', '--include-content']);
    expect(a.reproBundle).toBe('./out');
    expect(a.includeContent).toBe(true);
  });

  it('accepts --force only with --repro-bundle', () => {
    const a = parseExplainArgs(['q', '--repro-bundle=./out', '--force']);
    expect(a.reproBundleForce).toBe(true);
    expect(() => parseExplainArgs(['q', '--force'])).toThrow(/--force requires --repro-bundle/);
  });

  it('rejects empty --repro-bundle path', () => {
    expect(() => parseExplainArgs(['q', '--repro-bundle='])).toThrow(/--repro-bundle/);
  });

  it('rejects a second positional argument', () => {
    expect(() => parseExplainArgs(['q1', 'q2'])).toThrow(/unexpected argument/);
  });
});

describe('previewFromContent', () => {
  it('returns the trimmed content under the cap unchanged', () => {
    expect(previewFromContent('hello world')).toBe('hello world');
  });

  it('flattens whitespace', () => {
    expect(previewFromContent('hello\n  world')).toBe('hello world');
  });

  it('truncates with an ellipsis past the cap', () => {
    const long = 'x'.repeat(200);
    const out = previewFromContent(long);
    expect(out.endsWith('…')).toBe(true);
    // 80 chars of payload + the ellipsis.
    expect(out.length).toBe(81);
  });
});

describe('buildCandidates', () => {
  it('marks the first k entries as in-topk and the tail as near-misses', () => {
    const scored = [0.1, 0.2, 0.3, 0.4, 0.5].map((score, i) => ({
      pageContent: `chunk ${i}`,
      metadata: { source: `f${i}.md`, relativePath: `f${i}.md`, knowledgeBase: 'kb-a', chunkIndex: i },
      score,
    }));
    const out = buildCandidates(scored, 3);
    expect(out.map((c) => c.in_topk)).toEqual([true, true, true, false, false]);
    expect(out.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(out[0].source).toBe('f0.md');
    expect(out[0].knowledge_base).toBe('kb-a');
    expect(out[0].chunk_index).toBe(0);
  });

  it('falls back gracefully when metadata fields are missing', () => {
    const out = buildCandidates(
      [{ pageContent: 'hello', metadata: {}, score: 0.7 }],
      5,
    );
    expect(out[0].source).toMatch(/unknown source/);
    expect(out[0].relative_path).toBeNull();
    expect(out[0].knowledge_base).toBeNull();
    expect(out[0].chunk_index).toBeNull();
    expect(out[0].in_topk).toBe(true);
  });
});

function makeTrace(overrides: Partial<ExplainTrace> = {}): ExplainTrace {
  const base: ExplainTrace = {
    schema_version: EXPLAIN_TRACE_SCHEMA_VERSION,
    query: buildQueryBlock('rollback procedure'),
    system: {
      active_model_id: 'ollama__nomic-embed-text-latest',
      embedding_provider: 'ollama',
      embedding_model: 'nomic-embed-text-latest',
      index_path: '/tmp/.faiss',
      index_binary_path: '/tmp/.faiss/models/ollama__nomic-embed-text-latest/faiss.index/faiss.index',
      index_mtime: '2026-05-03T15:33:56.964Z',
      cli_version: '0.2.2',
      ingest_extra_extensions: [],
      ingest_exclude_paths: [],
    },
    embedding: {
      provider: 'ollama',
      model: 'nomic-embed-text-latest',
      embed_latency_ms: 12,
      dim: 768,
    },
    retrieval: {
      k: 2,
      near_misses_requested: 1,
      fetch_k: 3,
      candidates: [
        {
          rank: 1,
          score: 0.42,
          source: 'runbooks/rollback.md',
          relative_path: 'runbooks/rollback.md',
          knowledge_base: 'runbooks',
          chunk_index: 0,
          preview: 'Rollback procedure: revert the deploy then…',
          in_topk: true,
        },
        {
          rank: 2,
          score: 0.61,
          source: 'runbooks/deploy.md',
          relative_path: 'runbooks/deploy.md',
          knowledge_base: 'runbooks',
          chunk_index: 4,
          preview: 'Deploy procedure: tag, push, watch…',
          in_topk: true,
        },
        {
          rank: 3,
          score: 1.18,
          source: 'work/other.md',
          relative_path: 'work/other.md',
          knowledge_base: 'work',
          chunk_index: 2,
          preview: 'Other unrelated chunk…',
          in_topk: false,
        },
      ],
    },
    filters: {
      kb_scope: null,
      threshold: Number.POSITIVE_INFINITY,
      threshold_is_default: true,
      excluded_paths: [],
      extra_extensions: [],
    },
    timing: {
      bootstrap_ms: 1,
      model_resolution_ms: 2,
      manager_load_ms: 5,
      index_load_ms: 30,
      embed_query_ms: 12,
      faiss_search_ms: 4,
      post_filter_ms: 0,
      staleness_ms: 3,
      total_ms: 60,
    },
    freshness: {
      index_mtime: '2026-05-03T15:33:56.964Z',
      modified_files: 0,
      new_files: 0,
    },
    diagnostics: [],
  };
  return { ...base, ...overrides };
}

describe('formatExplainTraceAsJson', () => {
  it('round-trips through JSON.parse with the documented schema_version', () => {
    const trace = makeTrace();
    const raw = formatExplainTraceAsJson(trace);
    expect(raw.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(raw);
    expect(parsed.schema_version).toBe('kb-explain.v1');
    expect(parsed.retrieval.candidates).toHaveLength(3);
    expect(parsed.retrieval.candidates[0].in_topk).toBe(true);
    expect(parsed.retrieval.candidates[2].in_topk).toBe(false);
  });

  it('preserves field order matching the ExplainTrace shape', () => {
    const trace = makeTrace();
    const raw = formatExplainTraceAsJson(trace);
    const order = Object.keys(JSON.parse(raw));
    expect(order).toEqual([
      'schema_version',
      'query',
      'system',
      'embedding',
      'retrieval',
      'filters',
      'timing',
      'freshness',
      'diagnostics',
    ]);
  });

  it('serializes +Infinity threshold as null (JSON cannot represent Infinity)', () => {
    const trace = makeTrace();
    const raw = formatExplainTraceAsJson(trace);
    const parsed = JSON.parse(raw);
    // JSON.stringify replaces Infinity with null; the schema documents the
    // sentinel via `threshold_is_default: true`.
    expect(parsed.filters.threshold).toBeNull();
    expect(parsed.filters.threshold_is_default).toBe(true);
  });
});

describe('formatExplainTraceAsMarkdown', () => {
  it('includes the canonical section headers and the schema banner', () => {
    const md = formatExplainTraceAsMarkdown(makeTrace());
    expect(md).toContain('# kb explain trace');
    expect(md).toContain('schema: kb-explain.v1');
    for (const header of [
      '## Query',
      '## System',
      '## Embedding',
      '## Retrieval',
      '## Filters',
      '## Timing',
      '## Freshness',
      '## Diagnostic suggestions',
    ]) {
      expect(md).toContain(header);
    }
  });

  it('marks the k-cutoff with a check column in the candidate table', () => {
    const md = formatExplainTraceAsMarkdown(makeTrace());
    // Three candidates, first two in top-k, third in near-miss tail.
    expect(md).toMatch(/\| 1 \| 0\.420 \| ✓ \|/);
    expect(md).toMatch(/\| 2 \| 0\.610 \| ✓ \|/);
    expect(md).toMatch(/\| 3 \| 1\.180 \|   \|/);
  });

  it('renders a placeholder when no diagnostics fired', () => {
    const md = formatExplainTraceAsMarkdown(makeTrace({ diagnostics: [] }));
    expect(md).toContain('_None — nothing flagged for this query._');
  });

  it('renders each diagnostic as a bullet when present', () => {
    const md = formatExplainTraceAsMarkdown(makeTrace({
      diagnostics: ['first hint', 'second hint'],
    }));
    expect(md).toContain('- first hint');
    expect(md).toContain('- second hint');
  });

  it('escapes pipe characters in the preview to keep the table parseable', () => {
    const trace = makeTrace();
    trace.retrieval.candidates[0].preview = 'has | pipes | inside';
    const md = formatExplainTraceAsMarkdown(trace);
    expect(md).toContain('has \\| pipes \\| inside');
  });
});

describe('deriveDiagnostics', () => {
  it('flags an empty result set with a refresh hint', () => {
    const trace = makeTrace({
      retrieval: { k: 2, near_misses_requested: 0, fetch_k: 2, candidates: [] },
    });
    const { diagnostics: _ignore, ...rest } = trace;
    void _ignore;
    const hints = deriveDiagnostics(rest);
    expect(hints.join('\n')).toMatch(/index may be empty/i);
  });

  it('flags a missing index when index_mtime is null', () => {
    const trace = makeTrace({
      system: { ...makeTrace().system, index_mtime: null, index_binary_path: null },
      freshness: { index_mtime: null, modified_files: 0, new_files: 0 },
    });
    const { diagnostics: _ignore, ...rest } = trace;
    void _ignore;
    const hints = deriveDiagnostics(rest);
    expect(hints.join('\n')).toMatch(/has never been built/i);
  });

  it('flags KB-scope concentration when all top-K share a single KB', () => {
    const { diagnostics: _ignore, ...rest } = makeTrace();
    void _ignore;
    rest.retrieval.candidates = [
      { ...rest.retrieval.candidates[0], knowledge_base: 'runbooks', in_topk: true },
      { ...rest.retrieval.candidates[1], knowledge_base: 'runbooks', in_topk: true },
    ];
    rest.retrieval.k = 2;
    const hints = deriveDiagnostics(rest);
    expect(hints.join('\n')).toMatch(/--kb=runbooks/);
  });

  it('flags near-misses when the candidate tail extends past k', () => {
    const { diagnostics: _ignore, ...rest } = makeTrace();
    void _ignore;
    const hints = deriveDiagnostics(rest);
    expect(hints.join('\n')).toMatch(/near-miss candidate/i);
  });

  it('flags stale index when modified or new files exist since index mtime', () => {
    const { diagnostics: _ignore, ...rest } = makeTrace({
      freshness: { index_mtime: '2026-05-03T15:33:56.964Z', modified_files: 2, new_files: 3 },
    });
    void _ignore;
    const hints = deriveDiagnostics(rest);
    expect(hints.join('\n')).toMatch(/Index is stale/);
  });
});

// -- writeReproBundle redaction test ------------------------------------------
//
// Verifying the *directory* output via fs is the cheapest way to assert the
// privacy and redaction contract: including content is strictly opt-in and
// POSIX bundles are written with private directory/file permissions.

describe('kb explain repro bundle', () => {
  it('refuses --include-content without --repro-bundle (defense in depth)', async () => {
    // runExplain is the dispatch entry point and re-uses parseExplainArgs.
    const origStderr = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await runExplain(['hello', '--include-content']);
      expect(code).toBe(2);
      expect(captured.join('')).toMatch(/--include-content requires --repro-bundle/);
    } finally {
      process.stderr.write = origStderr;
    }
  });

  it('mkdir-creates the bundle target so a non-existing dir is accepted by the parser', async () => {
    // Stage 1 of the bundle invariant: parser must accept a relative path
    // even when the directory does not yet exist. (runExplain creates it.)
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-explain-bundle-'));
    try {
      const bundleDir = path.join(tempRoot, 'inner', 'bundle');
      const a = parseExplainArgs(['q', `--repro-bundle=${bundleDir}`]);
      expect(a.reproBundle).toBe(bundleDir);
      expect(a.includeContent).toBe(false);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('writes a private redacted bundle manifest', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-explain-bundle-'));
    try {
      const bundleDir = path.join(tempRoot, 'bundle');
      await writeReproBundle(bundleDir, makeTrace(), sampleBundleResults(), false);

      const query = await fsp.readFile(path.join(bundleDir, 'query.txt'), 'utf-8');
      expect(query).toBe('rollback procedure\n');

      const topCandidates = JSON.parse(
        await fsp.readFile(path.join(bundleDir, 'top-candidates.json'), 'utf-8'),
      ) as { content_included: boolean; candidates: Array<{ content?: string }> };
      expect(topCandidates.content_included).toBe(false);
      expect(topCandidates.candidates[0]).not.toHaveProperty('content');

      const manifest = JSON.parse(
        await fsp.readFile(path.join(bundleDir, 'manifest.json'), 'utf-8'),
      ) as ReproBundleManifestForTest;
      expect(manifest.schema_version).toBe('kb-explain-repro-bundle.v1');
      expect(manifest.trace_schema_version).toBe('kb-explain.v1');
      expect(manifest.content_included).toBe(false);
      expect(manifest.files.map((f) => f.path).sort()).toEqual([
        'freshness.json',
        'manifest.json',
        'query.txt',
        'system.json',
        'top-candidates.json',
      ]);

      if (process.platform !== 'win32') {
        expect(modeOf(await fsp.stat(bundleDir))).toBe('0700');
        for (const file of manifest.files) {
          expect(file.mode).toBe('0600');
          expect(modeOf(await fsp.stat(path.join(bundleDir, file.path)))).toBe('0600');
        }
      } else {
        expect(manifest.permissions.posix_permissions_enforced).toBe(false);
      }
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('records explicit content inclusion in the manifest', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-explain-bundle-'));
    try {
      const bundleDir = path.join(tempRoot, 'bundle');
      await writeReproBundle(bundleDir, makeTrace(), sampleBundleResults(), true);

      const topCandidates = JSON.parse(
        await fsp.readFile(path.join(bundleDir, 'top-candidates.json'), 'utf-8'),
      ) as { content_included: boolean; candidates: Array<{ content?: string }> };
      expect(topCandidates.content_included).toBe(true);
      expect(topCandidates.candidates[0].content).toBe('secret rollback text');

      const manifest = JSON.parse(
        await fsp.readFile(path.join(bundleDir, 'manifest.json'), 'utf-8'),
      ) as ReproBundleManifestForTest;
      expect(manifest.content_included).toBe(true);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('refuses an existing bundle directory containing non-bundle files', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-explain-bundle-'));
    try {
      const bundleDir = path.join(tempRoot, 'bundle');
      await fsp.mkdir(bundleDir, { mode: 0o700 });
      if (process.platform !== 'win32') await fsp.chmod(bundleDir, 0o700);
      await fsp.writeFile(path.join(bundleDir, 'old-content.json'), 'stale sensitive content\n', 'utf-8');

      await expect(writeReproBundle(bundleDir, makeTrace(), sampleBundleResults(), false))
        .rejects.toThrow(/contains non-bundle file\(s\): old-content\.json/);
      await expect(fsp.access(path.join(bundleDir, 'query.txt'))).rejects.toThrow();
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  const itOnPosix = process.platform === 'win32' ? it.skip : it;

  itOnPosix('refuses an existing bundle directory with group/other permissions', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-explain-bundle-'));
    try {
      const bundleDir = path.join(tempRoot, 'bundle');
      await fsp.mkdir(bundleDir, { mode: 0o755 });
      await fsp.chmod(bundleDir, 0o755);

      await expect(writeReproBundle(bundleDir, makeTrace(), sampleBundleResults(), false))
        .rejects.toThrow(/unsafe permissions 0755/);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  itOnPosix('force-chmods an unsafe existing bundle directory before writing', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-explain-bundle-'));
    try {
      const bundleDir = path.join(tempRoot, 'bundle');
      await fsp.mkdir(bundleDir, { mode: 0o755 });
      await fsp.chmod(bundleDir, 0o755);

      await writeReproBundle(bundleDir, makeTrace(), sampleBundleResults(), false, true);

      expect(modeOf(await fsp.stat(bundleDir))).toBe('0700');
      const manifest = JSON.parse(
        await fsp.readFile(path.join(bundleDir, 'manifest.json'), 'utf-8'),
      ) as ReproBundleManifestForTest;
      expect(manifest.permissions.directory.existing_mode).toBe('0755');
      expect(manifest.permissions.directory.existing_directory_was_unsafe).toBe(true);
      expect(manifest.permissions.directory.unsafe_existing_directory_forced).toBe(true);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  itOnPosix('runExplain forwards --force and --include-content to the repro writer', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-explain-bundle-'));
    try {
      const bundleDir = path.join(tempRoot, 'bundle');
      await fsp.mkdir(bundleDir, { mode: 0o755 });
      await fsp.chmod(bundleDir, 0o755);

      const noForce = await captureExplainOutput(
        ['rollback procedure', `--repro-bundle=${bundleDir}`],
        makeRunExplainDeps(),
      );
      expect(noForce.code).toBe(1);
      expect(noForce.stderr).toMatch(/unsafe permissions 0755/);

      const forced = await captureExplainOutput(
        ['rollback procedure', `--repro-bundle=${bundleDir}`, '--include-content', '--force'],
        makeRunExplainDeps(),
      );
      expect(forced.code).toBe(0);
      expect(modeOf(await fsp.stat(bundleDir))).toBe('0700');

      const manifest = JSON.parse(
        await fsp.readFile(path.join(bundleDir, 'manifest.json'), 'utf-8'),
      ) as ReproBundleManifestForTest;
      expect(manifest.content_included).toBe(true);
      expect(manifest.permissions.directory.unsafe_existing_directory_forced).toBe(true);

      const topCandidates = JSON.parse(
        await fsp.readFile(path.join(bundleDir, 'top-candidates.json'), 'utf-8'),
      ) as { candidates: Array<{ content?: string }> };
      expect(topCandidates.candidates[0].content).toBe('secret rollback text');
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

function sampleBundleResults(): Array<{ pageContent: string; metadata: Record<string, unknown>; score: number }> {
  return [
    { pageContent: 'secret rollback text', metadata: { frontmatter: { type: 'runbook' } }, score: 0.42 },
    { pageContent: 'secret deploy text', metadata: {}, score: 0.61 },
    { pageContent: 'secret other text', metadata: {}, score: 1.18 },
  ];
}

function makeRunExplainDeps(): RunExplainDeps {
  const manager = {
    embeddingProvider: 'fake',
    modelName: 'bag-256d',
    async similaritySearch() {
      return sampleBundleResults();
    },
    getStats() {
      return { dim: 64 };
    },
  };
  return {
    bootstrapLayout: async () => {},
    resolveActiveModel: async () => 'fake__bag-256d',
    loadManagerForModel: async () => manager as never,
    loadWithJsonRetry: async () => {},
    computeStaleness: async () => ({ indexMtime: null, modifiedFiles: 0, newFiles: 0 }),
    resolveFaissIndexBinaryPath: async () => null,
    writeReproBundle,
    readPackageVersion: () => 'test-version',
  };
}

async function captureExplainOutput(
  args: string[],
  deps: RunExplainDeps,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await runExplain(args, deps);
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
}

function modeOf(stats: { mode: number }): string {
  return (stats.mode & 0o777).toString(8).padStart(4, '0');
}

interface ReproBundleManifestForTest {
  schema_version: string;
  trace_schema_version: string;
  content_included: boolean;
  permissions: {
    posix_permissions_enforced: boolean;
    directory: {
      existing_mode: string | null;
      existing_directory_was_unsafe: boolean;
      unsafe_existing_directory_forced: boolean;
    };
  };
  files: Array<{ path: string; mode: string | null }>;
}
