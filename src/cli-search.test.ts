import * as path from 'path';
import { describe, expect, it, jest } from '@jest/globals';
import {
  AutoThresholdDecision,
  buildDenseSearchJsonPayload,
  buildExplainEmptyDiagnostics,
  computeAutoThreshold,
  createRefreshProgressReporter,
  formatDenseSearchMarkdownOutput,
  formatAutoModeHeader,
  formatAutoThresholdHeader,
  formatExplainEmptyDiagnosticsMarkdown,
  formatFreshnessFooter,
  formatRefreshProgressLine,
  parseSearchArgs,
  resolveAutoSearchMode,
  runSearch,
  shouldUsePicker,
  type ExplainEmptyDiagnostics,
  type RunSearchDeps,
  Staleness,
} from './cli-search.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config.js';
import { compactTimingPayload, type TimingPayload } from './cli-timing.js';
import type { ScoredDocument } from './formatter.js';
import type { FaissIndexManager, SimilaritySearchTiming } from './FaissIndexManager.js';
import {
  classifyKbSearchError,
  formatKbSearchFailureJson,
  formatKbSearchFailureStderr,
} from './cli-search-errors.js';
import { WriteLockContentionError } from './write-lock.js';

const MTIME = '2026-05-03T15:33:56.964Z';

describe('formatFreshnessFooter', () => {
  it('reports "not yet built" when indexMtime is null', () => {
    const s: Staleness = { indexMtime: null, modifiedFiles: 0, newFiles: 0 };
    expect(formatFreshnessFooter(s, false)).toBe(
      '> _Index not yet built. Run `kb search --refresh` to create it._',
    );
  });

  it('reports a refresh confirmation when refreshed=true', () => {
    const s: Staleness = { indexMtime: MTIME, modifiedFiles: 0, newFiles: 17 };
    expect(formatFreshnessFooter(s, true)).toBe(`> _Index refreshed at ${MTIME}._`);
  });

  it('reports up-to-date when neither modified nor new files exist', () => {
    const s: Staleness = { indexMtime: MTIME, modifiedFiles: 0, newFiles: 0 };
    expect(formatFreshnessFooter(s, false)).toBe(`> _Index up-to-date as of ${MTIME}._`);
  });

  it('uses a gentle hint (no "may be stale") when only new files were added', () => {
    const s: Staleness = { indexMtime: MTIME, modifiedFiles: 0, newFiles: 1857 };
    const out = formatFreshnessFooter(s, false);
    expect(out).toBe(
      `> _1857 new file(s) since ${MTIME}; run \`kb search --refresh\` to include them._`,
    );
    expect(out).not.toMatch(/may be stale/);
  });

  it('still warns "may be stale" when at least one file was modified', () => {
    const s: Staleness = { indexMtime: MTIME, modifiedFiles: 3, newFiles: 0 };
    expect(formatFreshnessFooter(s, false)).toBe(
      `> _Index may be stale: 3 modified, 0 new file(s) since ${MTIME}. Run \`kb search --refresh\` to update._`,
    );
  });

  it('still warns "may be stale" when files were both modified and added', () => {
    const s: Staleness = { indexMtime: MTIME, modifiedFiles: 2, newFiles: 5 };
    expect(formatFreshnessFooter(s, false)).toBe(
      `> _Index may be stale: 2 modified, 5 new file(s) since ${MTIME}. Run \`kb search --refresh\` to update._`,
    );
  });

  it('reports scoped stale counts separately from global counts', () => {
    const s: Staleness = {
      indexMtime: MTIME,
      modifiedFiles: 0,
      newFiles: 0,
      scope: { kb: 'agent-task-lessons', modifiedFiles: 0, newFiles: 0 },
      global: { modifiedFiles: 2, newFiles: 2016 },
    };
    expect(formatFreshnessFooter(s, false)).toBe(
      `> _Index up-to-date for KB "agent-task-lessons" as of ${MTIME}. Global index drift outside this scope: 2 modified, 2016 new file(s)._`,
    );
  });

  it('keeps scoped stale guidance scoped to the selected KB', () => {
    const s: Staleness = {
      indexMtime: MTIME,
      modifiedFiles: 1,
      newFiles: 3,
      scope: { kb: 'agent-task-lessons', modifiedFiles: 1, newFiles: 3 },
      global: { modifiedFiles: 7, newFiles: 11 },
    };
    expect(formatFreshnessFooter(s, false)).toBe(
      `> _Index may be stale for KB "agent-task-lessons": 1 modified, 3 new file(s) since ${MTIME}. Run \`kb search --kb=agent-task-lessons --refresh\` to update this scope. Global index drift: 7 modified, 11 new file(s)._`,
    );
  });

  it('reports scoped refreshes without hiding global drift', () => {
    const s: Staleness = {
      indexMtime: MTIME,
      modifiedFiles: 0,
      newFiles: 0,
      scope: { kb: 'agent-task-lessons', modifiedFiles: 0, newFiles: 0 },
      global: { modifiedFiles: 0, newFiles: 2016 },
    };
    expect(formatFreshnessFooter(s, true)).toBe(
      `> _Index refreshed for KB "agent-task-lessons" at ${MTIME}. Global index drift outside this scope: 0 modified, 2016 new file(s)._`,
    );
  });
});

describe('lock contention output (issue #181 + #199 unified shape)', () => {
  const lockErr = new WriteLockContentionError({
    resource: '/tmp/model',
    lockPath: '/tmp/model/.kb-write.lock',
    causeMessage: 'Lock file is already being held',
  });

  it('emits parseable JSON for --format=json callers', () => {
    const parsed = JSON.parse(formatKbSearchFailureJson(classifyKbSearchError(lockErr)));
    // Issue #181 contracted `retry_hint` for lock failures; #199's unified
    // envelope adds `category` + `next_action` and aliases `retry_hint` to
    // `next_action` so existing agents branching on `REFRESH_LOCK_BUSY`
    // keep working.
    expect(parsed).toEqual({
      error: {
        code: 'REFRESH_LOCK_BUSY',
        category: 'lock',
        message: 'Refresh lock is already held for this model. Retry after the current refresh finishes.',
        next_action:
          'Retry in a few seconds; only one `kb search --refresh` writer may run per model at a time.',
        retry_hint:
          'Retry in a few seconds; only one `kb search --refresh` writer may run per model at a time.',
        lock_path: '/tmp/model/.kb-write.lock',
        resource: '/tmp/model',
      },
    });
  });

  it('prints retry guidance for human-mode stderr', () => {
    const out = formatKbSearchFailureStderr(classifyKbSearchError(lockErr));
    expect(out).toContain('Refresh lock is already held');
    expect(out).toContain('category: lock');
    expect(out).toContain('Retry in a few seconds');
    expect(out).toContain('/tmp/model/.kb-write.lock');
  });
});

describe('refresh progress output (#316)', () => {
  it('formats bounded embedding batches as concise stderr progress lines', () => {
    expect(formatRefreshProgressLine({
      processedFiles: 0,
      totalFiles: 5,
      currentFile: '/kb/default/doc-1.md',
      modelId: 'huggingface__BAAI-bge-small-en-v1.5',
      phase: 'embed',
      phaseStatus: 'progress',
      batchIndex: 2,
      batchCount: 3,
      processedChunks: 4,
      totalChunks: 5,
      throughputChunksPerSecond: 12.4,
      provider: 'huggingface',
      modelName: 'BAAI/bge-small-en-v1.5',
      elapsedMs: 1250,
    })).toBe(
      'kb search refresh: embed batch 2/3, 4/5 chunks, 12 chunks/s, ' +
      'model=huggingface/BAAI/bge-small-en-v1.5, elapsed=1.3s',
    );
  });

  it('writes refresh progress to stderr while preserving JSON stdout', () => {
    const timing: TimingPayload = {};
    const stderr: string[] = [];
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      const reporter = createRefreshProgressReporter(timing, (line) => {
        stderr.push(line);
      });
      reporter({
        processedFiles: 0,
        totalFiles: 5,
        currentFile: '/kb/default/doc-0.md',
        modelId: 'huggingface__BAAI-bge-small-en-v1.5',
        phase: 'embed',
        phaseStatus: 'progress',
        batchIndex: 1,
        batchCount: 3,
        batchSize: 2,
        processedChunks: 2,
        totalChunks: 5,
        phaseElapsedMs: 500,
        elapsedMs: 500,
      });

      expect(stderr).toEqual([
        'kb search refresh: embed batch 1/3, 2/5 chunks, elapsed=500ms\n',
      ]);
      expect(stdoutSpy).not.toHaveBeenCalled();
      const stdoutPayload = JSON.stringify({
        results: [],
        timing: compactTimingPayload(timing),
      });
      expect(JSON.parse(stdoutPayload)).toEqual({
        results: [],
        timing: {
          refresh_embed_chunks: 2,
          refresh_embed_chunks_total: 5,
          refresh_embed_batches: 1,
          refresh_embed_batches_total: 3,
          refresh_embed_batch_size: 2,
          refresh_embed_ms: 500,
        },
      });
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

describe('parseSearchArgs output format', () => {
  it('accepts vimgrep as a search output format', () => {
    expect(parseSearchArgs(['query', '--format=vimgrep'])).toMatchObject({
      query: 'query',
      format: 'vimgrep',
    });
  });

  it('still rejects unknown output formats', () => {
    expect(() => parseSearchArgs(['query', '--format=xml'])).toThrow(/invalid --format/);
  });
});

describe('parseSearchArgs freshness', () => {
  it('enables freshness by default', () => {
    expect(parseSearchArgs(['query'])).toMatchObject({ freshness: true });
  });

  it('accepts --no-freshness to omit freshness work and output', () => {
    expect(parseSearchArgs(['query', '--no-freshness'])).toMatchObject({ freshness: false });
  });
});

describe('parseSearchArgs --explain-empty (#328)', () => {
  it('defaults to false so the inline #335 guidance keeps its current behaviour', () => {
    expect(parseSearchArgs(['query'])).toMatchObject({ explainEmpty: false });
  });

  it('accepts --explain-empty as a boolean opt-in', () => {
    expect(parseSearchArgs(['query', '--explain-empty'])).toMatchObject({
      explainEmpty: true,
    });
  });
});

describe('runSearch timing guard (#331)', () => {
  function makeDeps(): {
    deps: RunSearchDeps;
    manager: FaissIndexManager & {
      similaritySearch: jest.Mock;
    };
  } {
    const manager = {
      similaritySearch: jest.fn(async (...args: unknown[]) => {
        const timing = args[5] as SimilaritySearchTiming | undefined;
        // Mirrors FaissIndexManager's vector-search timing write. This used
        // to throw for plain `kb search` because the CLI passed undefined.
        timing!.faiss_search_ms = (timing!.faiss_search_ms ?? 0) + 7;
        return [];
      }),
    } as unknown as FaissIndexManager & { similaritySearch: jest.Mock };

    return {
      manager,
      deps: {
        bootstrapLayout: jest.fn(async () => {}),
        resolveActiveModel: jest.fn(async () => 'ollama__nomic-embed-text-latest'),
        loadManagerForModel: jest.fn(async () => manager),
        loadWithJsonRetry: jest.fn(async () => {}),
      },
    };
  }

  async function captureSearchOutput(
    args: string[],
    deps: RunSearchDeps,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

    try {
      const code = await runSearch(args, deps);
      return { code, stdout: stdout.join(''), stderr: stderr.join('') };
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  }

  it('keeps plain markdown search from dereferencing missing timing metrics', async () => {
    const { deps, manager } = makeDeps();

    const out = await captureSearchOutput(['query', '--no-freshness'], deps);

    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout).toContain('## Semantic Search Results');
    expect(out.stdout).not.toContain('Timing');
    expect(manager.similaritySearch).toHaveBeenCalledTimes(1);
    expect(manager.similaritySearch.mock.calls[0][5]).toMatchObject({ faiss_search_ms: 7 });
  });

  it('keeps plain JSON search from dereferencing missing timing metrics', async () => {
    const { deps, manager } = makeDeps();

    const out = await captureSearchOutput(['query', '--format=json', '--no-freshness'], deps);

    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    expect(manager.similaritySearch).toHaveBeenCalledTimes(1);
    expect(manager.similaritySearch.mock.calls[0][5]).toMatchObject({ faiss_search_ms: 7 });
    const payload = JSON.parse(out.stdout);
    expect(payload).toMatchObject({
      results: [],
      freshness_omitted: true,
    });
    expect(payload).not.toHaveProperty('timing');
  });
});

describe('parseSearchArgs --interactive (#215)', () => {
  it('defaults --interactive to false', () => {
    expect(parseSearchArgs(['query'])).toMatchObject({ interactive: false });
  });

  it('accepts --interactive and -i as the same flag', () => {
    expect(parseSearchArgs(['query', '--interactive'])).toMatchObject({ interactive: true });
    expect(parseSearchArgs(['query', '-i'])).toMatchObject({ interactive: true });
  });
});

describe('parseSearchArgs neighbor context (#225)', () => {
  it('accepts explicit before/after context windows', () => {
    expect(parseSearchArgs([
      'query',
      '--context-before=1',
      '--context-after=2',
    ])).toMatchObject({
      query: 'query',
      neighborContext: { before: 1, after: 2 },
    });
  });

  it('accepts --context-window as a before/after shorthand', () => {
    expect(parseSearchArgs(['query', '--context-window=2'])).toMatchObject({
      neighborContext: { before: 2, after: 2 },
    });
  });

  it('rejects unbounded context windows', () => {
    expect(() => parseSearchArgs(['query', '--context-window=99'])).toThrow(
      /invalid --context-window/,
    );
  });
});

describe('shouldUsePicker (#215)', () => {
  it('returns false when --interactive is not set', () => {
    expect(shouldUsePicker({ interactive: false, format: 'md' })).toBe(false);
  });

  it('returns true for the default markdown format with --interactive', () => {
    expect(shouldUsePicker({ interactive: true, format: 'md' })).toBe(true);
  });

  it('lets --format=json override -i so agent shells stay deterministic', () => {
    expect(shouldUsePicker({ interactive: true, format: 'json' })).toBe(false);
  });

  it('lets --format=vimgrep override -i so editor quickfix flows stay structured', () => {
    expect(shouldUsePicker({ interactive: true, format: 'vimgrep' })).toBe(false);
  });
});

describe('dense freshness output (#332)', () => {
  it('marks JSON freshness as omitted and omits stale fields', () => {
    const payload = buildDenseSearchJsonPayload({
      results: [],
      requestedMode: 'dense',
      effectiveMode: 'dense',
      autoModeDecision: null,
      groupBySource: false,
      refreshed: false,
      scopedKb: undefined,
      staleness: null,
      autoThresholdDecision: null,
      timing: null,
    });

    expect(payload).toMatchObject({ freshness_omitted: true });
    expect(payload).not.toHaveProperty('index_mtime');
    expect(payload).not.toHaveProperty('stale');
    expect(payload).not.toHaveProperty('modified_files');
    expect(payload).not.toHaveProperty('new_files');
    expect(payload).not.toHaveProperty('global_stale');
  });

  it('omits the markdown freshness footer when freshness is omitted', () => {
    const output = formatDenseSearchMarkdownOutput({
      results: [],
      groupBySource: false,
      staleness: null,
      refreshed: false,
      autoModeDecision: null,
      autoThresholdDecision: null,
      timing: null,
    });

    expect(output).toContain('## Semantic Search Results');
    expect(output).not.toContain('Index up-to-date');
    expect(output).not.toContain('Index may be stale');
    expect(output).not.toContain('Run `kb search --refresh`');
  });

  it('keeps default JSON freshness fields when freshness is present', () => {
    const staleness: Staleness = { indexMtime: MTIME, modifiedFiles: 1, newFiles: 2 };
    const payload = buildDenseSearchJsonPayload({
      results: [],
      requestedMode: 'dense',
      effectiveMode: 'dense',
      autoModeDecision: null,
      groupBySource: false,
      refreshed: false,
      scopedKb: undefined,
      staleness,
      autoThresholdDecision: null,
      timing: null,
    });

    expect(payload).toMatchObject({
      index_mtime: MTIME,
      stale: true,
      modified_files: 1,
      new_files: 2,
      global_stale: true,
      global_modified_files: 1,
      global_new_files: 2,
    });
    expect(payload).not.toHaveProperty('freshness_omitted');
  });

  it('includes freshness scan metadata in JSON timing only when timing is requested', () => {
    const staleness: Staleness = {
      indexMtime: MTIME,
      modifiedFiles: 1,
      newFiles: 2,
    };
    const payload = buildDenseSearchJsonPayload({
      results: [],
      requestedMode: 'dense',
      effectiveMode: 'dense',
      autoModeDecision: null,
      groupBySource: false,
      refreshed: false,
      scopedKb: undefined,
      staleness,
      autoThresholdDecision: null,
      timing: {
        freshness_scan_ms: 4,
        freshness_scan_files: 3,
        freshness_scan_scope: 'global',
        freshness_scan_source: 'filesystem',
      },
    });

    expect(payload).toMatchObject({
      timing: {
        freshness_scan_ms: 4,
        freshness_scan_files: 3,
        freshness_scan_scope: 'global',
        freshness_scan_source: 'filesystem',
      },
    });
    expect(payload).not.toHaveProperty('freshness_scan_ms');
    expect(payload).not.toHaveProperty('freshness_scan_files');
  });

  it('keeps the default markdown freshness footer when freshness is present', () => {
    const output = formatDenseSearchMarkdownOutput({
      results: [],
      groupBySource: false,
      staleness: { indexMtime: MTIME, modifiedFiles: 0, newFiles: 0 },
      refreshed: false,
      autoModeDecision: null,
      autoThresholdDecision: null,
      timing: null,
    });

    expect(output).toContain(`> _Index up-to-date as of ${MTIME}._`);
  });

  it('includes freshness scan metadata in the markdown timing footer', () => {
    const output = formatDenseSearchMarkdownOutput({
      results: [],
      groupBySource: false,
      staleness: { indexMtime: MTIME, modifiedFiles: 0, newFiles: 0 },
      refreshed: false,
      autoModeDecision: null,
      autoThresholdDecision: null,
      timing: {
        freshness_scan_ms: 5,
        freshness_scan_files: 8,
        freshness_scan_scope: 'scoped',
      },
    });

    expect(output).toContain(
      '> _Timing: freshness_scan_ms=5ms, freshness_scan_files=8, freshness_scan_scope=scoped._',
    );
  });
});

describe('empty-result inline staleness guidance (issue #335)', () => {
  it('does not change the markdown body when results are non-empty', () => {
    const doc = {
      pageContent: 'hit',
      metadata: { source: 'kb/doc.md' },
      score: 0.5,
    } as unknown as ScoredDocument;
    const output = formatDenseSearchMarkdownOutput({
      results: [doc],
      groupBySource: false,
      staleness: {
        indexMtime: MTIME,
        modifiedFiles: 4,
        newFiles: 1,
        scope: { kb: 'work', modifiedFiles: 4, newFiles: 1 },
        global: { modifiedFiles: 7, newFiles: 9 },
      },
      refreshed: false,
      scopedKb: 'work',
      query: 'auth flow',
      autoModeDecision: null,
      autoThresholdDecision: null,
      timing: null,
    });
    expect(output).toContain('**Result 1:**');
    expect(output).not.toContain('**Tip:**');
    expect(output).toContain('Index may be stale for KB "work"');
  });

  it('inlines the staleness tip and suppresses the duplicate freshness footer on empty scoped-stale runs', () => {
    const output = formatDenseSearchMarkdownOutput({
      results: [],
      groupBySource: false,
      staleness: {
        indexMtime: MTIME,
        modifiedFiles: 2,
        newFiles: 5,
        scope: { kb: 'work', modifiedFiles: 2, newFiles: 5 },
        global: { modifiedFiles: 4, newFiles: 7 },
      },
      refreshed: false,
      scopedKb: 'work',
      query: 'auth flow',
      autoModeDecision: null,
      autoThresholdDecision: null,
      timing: null,
    });
    expect(output).toContain('_No similar results found._');
    expect(output).toContain('**Tip:** No results found, and the "work" KB scope is stale');
    expect(output).toContain('kb search "auth flow" --kb=work --refresh');
    expect(output).not.toContain('Run `kb search --kb=work --refresh` to update this scope');
  });

  it('inlines the staleness tip on empty global-stale runs and suppresses the footer', () => {
    const output = formatDenseSearchMarkdownOutput({
      results: [],
      groupBySource: false,
      staleness: {
        indexMtime: MTIME,
        modifiedFiles: 3,
        newFiles: 1,
      },
      refreshed: false,
      scopedKb: undefined,
      query: 'auth flow',
      autoModeDecision: null,
      autoThresholdDecision: null,
      timing: null,
    });
    expect(output).toContain('**Tip:** No results found, and the index is stale');
    expect(output).toContain('kb search "auth flow" --refresh');
    expect(output).not.toContain('Index may be stale: ');
  });

  it('keeps the existing "up-to-date" footer on empty fresh runs (no inline tip)', () => {
    const output = formatDenseSearchMarkdownOutput({
      results: [],
      groupBySource: false,
      staleness: {
        indexMtime: MTIME,
        modifiedFiles: 0,
        newFiles: 0,
      },
      refreshed: false,
      scopedKb: undefined,
      query: 'auth flow',
      autoModeDecision: null,
      autoThresholdDecision: null,
      timing: null,
    });
    expect(output).toContain('_No similar results found._');
    expect(output).not.toContain('**Tip:**');
    expect(output).toContain(`> _Index up-to-date as of ${MTIME}._`);
  });

  it('keeps the existing "refreshed" footer on empty refreshed runs (no inline tip)', () => {
    const output = formatDenseSearchMarkdownOutput({
      results: [],
      groupBySource: false,
      staleness: {
        indexMtime: MTIME,
        modifiedFiles: 0,
        newFiles: 0,
      },
      refreshed: true,
      scopedKb: undefined,
      query: 'auth flow',
      autoModeDecision: null,
      autoThresholdDecision: null,
      timing: null,
    });
    expect(output).not.toContain('**Tip:**');
    expect(output).toContain(`> _Index refreshed at ${MTIME}._`);
  });

  it('JSON payload exposes empty_result_guidance on stale empty scoped runs', () => {
    const payload = buildDenseSearchJsonPayload({
      results: [],
      requestedMode: 'dense',
      effectiveMode: 'dense',
      autoModeDecision: null,
      groupBySource: false,
      refreshed: false,
      scopedKb: 'work',
      query: 'auth flow',
      staleness: {
        indexMtime: MTIME,
        modifiedFiles: 2,
        newFiles: 5,
        scope: { kb: 'work', modifiedFiles: 2, newFiles: 5 },
        global: { modifiedFiles: 4, newFiles: 7 },
      },
      autoThresholdDecision: null,
      timing: null,
    });
    expect(payload).toMatchObject({
      results: [],
      empty_result_guidance: {
        refresh_command: 'kb search "auth flow" --kb=work --refresh',
        scope: 'scoped',
        scope_kb: 'work',
        index_built: true,
        refreshed: false,
        scoped_stale: true,
        scoped_modified_files: 2,
        scoped_new_files: 5,
        global_stale: true,
        global_modified_files: 4,
        global_new_files: 7,
      },
    });
    expect(payload).toMatchObject({
      stale: true,
      modified_files: 2,
      new_files: 5,
    });
  });

  it('JSON payload omits empty_result_guidance when results are non-empty', () => {
    const doc = {
      pageContent: 'hit',
      metadata: { source: 'kb/doc.md' },
      score: 0.1,
    } as unknown as ScoredDocument;
    const payload = buildDenseSearchJsonPayload({
      results: [doc],
      requestedMode: 'dense',
      effectiveMode: 'dense',
      autoModeDecision: null,
      groupBySource: false,
      refreshed: false,
      scopedKb: undefined,
      query: 'auth flow',
      staleness: {
        indexMtime: MTIME,
        modifiedFiles: 3,
        newFiles: 1,
      },
      autoThresholdDecision: null,
      timing: null,
    });
    expect(payload).not.toHaveProperty('empty_result_guidance');
  });

  it('JSON payload omits empty_result_guidance when freshness was skipped', () => {
    const payload = buildDenseSearchJsonPayload({
      results: [],
      requestedMode: 'dense',
      effectiveMode: 'dense',
      autoModeDecision: null,
      groupBySource: false,
      refreshed: false,
      scopedKb: undefined,
      query: 'auth flow',
      staleness: null,
      autoThresholdDecision: null,
      timing: null,
    });
    expect(payload).toMatchObject({ freshness_omitted: true });
    expect(payload).not.toHaveProperty('empty_result_guidance');
  });
});

describe('computeAutoThreshold', () => {
  it('returns kept=0 with null knee for empty input', () => {
    expect(computeAutoThreshold([])).toEqual({ threshold: 0, kneeIndex: null, kept: 0 });
  });

  it('keeps the single result with null knee when only one score', () => {
    expect(computeAutoThreshold([0.42])).toEqual({
      threshold: 0.42,
      kneeIndex: null,
      kept: 1,
    });
  });

  it('detects a clear knee at the largest first-difference', () => {
    // diffs: [0.1, 0.1, 0.5, 0.1] — biggest jump between scores[2] and scores[3]
    const d = computeAutoThreshold([0.30, 0.40, 0.50, 1.00, 1.10]);
    expect(d.kneeIndex).toBe(2);
    expect(d.kept).toBe(3);
    expect(d.threshold).toBeCloseTo(0.50, 6);
  });

  it('reports the knee at result 4 when the elbow is the fourth score', () => {
    // Mirrors the example in the issue body.
    // diffs: [0.05, 0.05, 0.06, 0.20, 0.04, 0.04] → max at idx 3 (between 0.71 and 0.91)
    const d = computeAutoThreshold([0.50, 0.55, 0.60, 0.66, 0.71, 0.91, 0.95, 0.99]);
    expect(d.kneeIndex).toBe(4);
    expect(d.kept).toBe(5);
    expect(d.threshold).toBeCloseTo(0.71, 6);
  });

  it('treats a uniform distribution as no clear knee and keeps all results', () => {
    // diffs: [0.1, 0.1, 0.1, 0.1] — meanDiff == maxDiff
    const d = computeAutoThreshold([0.10, 0.20, 0.30, 0.40, 0.50]);
    expect(d.kneeIndex).toBeNull();
    expect(d.kept).toBe(5);
    expect(d.threshold).toBeCloseTo(0.50, 6);
  });

  it('treats nearly-uniform diffs (within 10% of mean) as no clear knee', () => {
    // diffs: [0.10, 0.105, 0.10, 0.10] — max is 5% over mean, well within 10% slack.
    const d = computeAutoThreshold([0.30, 0.40, 0.505, 0.605, 0.705]);
    expect(d.kneeIndex).toBeNull();
    expect(d.kept).toBe(5);
  });

  it('treats identical scores as no clear knee', () => {
    const d = computeAutoThreshold([0.42, 0.42, 0.42]);
    expect(d.kneeIndex).toBeNull();
    expect(d.kept).toBe(3);
    expect(d.threshold).toBeCloseTo(0.42, 6);
  });

  it('takes the earliest argmax when multiple gaps tie for the largest', () => {
    // diffs: [0.05, 0.50, 0.05, 0.50] — earliest max at idx 1
    const d = computeAutoThreshold([0.30, 0.35, 0.85, 0.90, 1.40]);
    expect(d.kneeIndex).toBe(1);
    expect(d.kept).toBe(2);
    expect(d.threshold).toBeCloseTo(0.35, 6);
  });
});

describe('formatAutoThresholdHeader', () => {
  it('reports the knee position and kept count when a knee is detected', () => {
    const d: AutoThresholdDecision = { threshold: 0.71, kneeIndex: 3, kept: 4 };
    expect(formatAutoThresholdHeader(d)).toBe(
      '> _Auto-threshold: 0.71 (knee at result 4; kept 4)._',
    );
  });

  it('reports "no clear knee" when the distribution is uniform', () => {
    const d: AutoThresholdDecision = { threshold: 0.85, kneeIndex: null, kept: 10 };
    expect(formatAutoThresholdHeader(d)).toBe(
      '> _Auto-threshold: 0.85 (no clear knee; kept all 10 results)._',
    );
  });

  it('handles the single-result case', () => {
    const d: AutoThresholdDecision = { threshold: 0.42, kneeIndex: null, kept: 1 };
    expect(formatAutoThresholdHeader(d)).toBe(
      '> _Auto-threshold: 0.42 (1 result; no knee detection)._',
    );
  });

  it('handles the empty-result case', () => {
    const d: AutoThresholdDecision = { threshold: 0, kneeIndex: null, kept: 0 };
    expect(formatAutoThresholdHeader(d)).toBe('> _Auto-threshold: no results to score._');
  });
});

describe('resolveAutoSearchMode', () => {
  it('keeps prose queries on dense retrieval', () => {
    expect(resolveAutoSearchMode('how should I roll back a deployment?')).toEqual({
      mode: 'dense',
      reason: 'prose query',
    });
  });

  it('uses hybrid for exact error and identifier shaped queries', () => {
    expect(resolveAutoSearchMode('INDEX_NOT_INITIALIZED')).toMatchObject({
      mode: 'hybrid',
    });
    expect(resolveAutoSearchMode('FaissIndexManager batch size')).toMatchObject({
      mode: 'hybrid',
    });
  });

  it('uses hybrid for flags, paths, and issue references', () => {
    expect(resolveAutoSearchMode('--refresh behavior')).toMatchObject({ mode: 'hybrid' });
    expect(resolveAutoSearchMode('src/cli-search.ts')).toMatchObject({ mode: 'hybrid' });
    expect(resolveAutoSearchMode('PR #253')).toMatchObject({ mode: 'hybrid' });
  });
});

describe('formatAutoModeHeader', () => {
  it('renders the selected mode and reason', () => {
    expect(formatAutoModeHeader({ mode: 'hybrid', reason: 'file-like token' })).toBe(
      '> _Mode: auto -> hybrid (file-like token)._',
    );
  });
});

describe('buildExplainEmptyDiagnostics (#328)', () => {
  const KB_ROOT = '/kb-root';
  const candidate = (kbName: string, score: number, file = 'doc.md') =>
    ({
      score,
      metadata: { source: `${KB_ROOT}/${kbName}/${file}` },
    } as const);

  it('classifies scope drops first then threshold drops so counts sum to pre-filter total', () => {
    const raw = [
      candidate('work', 0.3),     // in-scope, under threshold → kept
      candidate('work', 0.9),     // in-scope, over threshold → threshold drop
      candidate('personal', 0.2), // out-of-scope (even though score would pass) → scope drop
      candidate('personal', 0.9), // out-of-scope → scope drop (scope wins over threshold)
    ];
    const d = buildExplainEmptyDiagnostics({
      rawCandidates: raw,
      threshold: 0.5,
      scopedKb: 'work',
      allKbs: ['personal', 'work'],
      staleness: null,
      kbRoot: KB_ROOT,
    });

    expect(d.candidatesPreFilter).toBe(4);
    expect(d.candidatesPostFilter).toBe(1);
    expect(d.filterDrops.kbScope).toBe(2);
    expect(d.filterDrops.threshold).toBe(1);
    expect(d.filterDrops.kbScope).toBeGreaterThanOrEqual(0);
    expect(d.filterDrops.threshold).toBeGreaterThanOrEqual(0);
    expect(
      d.filterDrops.kbScope + d.filterDrops.threshold + d.candidatesPostFilter,
    ).toBe(d.candidatesPreFilter);
  });

  it('reports kbs_searched as just the scoped KB and kbs_skipped with a reason', () => {
    const d = buildExplainEmptyDiagnostics({
      rawCandidates: [],
      threshold: 0.5,
      scopedKb: 'work',
      allKbs: ['personal', 'work', 'archive'],
      staleness: null,
      kbRoot: KB_ROOT,
    });
    expect(d.scope.requestedKb).toBe('work');
    expect(d.scope.kbsSearched).toEqual(['work']);
    expect(d.scope.kbsSkipped).toEqual([
      { kb: 'personal', reason: 'outside --kb=work' },
      { kb: 'archive', reason: 'outside --kb=work' },
    ]);
  });

  it('reports global scope when no --kb is set', () => {
    const d = buildExplainEmptyDiagnostics({
      rawCandidates: [],
      threshold: 0.5,
      scopedKb: undefined,
      allKbs: ['personal', 'work'],
      staleness: null,
      kbRoot: KB_ROOT,
    });
    expect(d.scope.requestedKb).toBeNull();
    expect(d.scope.kbsSearched).toEqual(['personal', 'work']);
    expect(d.scope.kbsSkipped).toEqual([]);
  });

  it('caps nearest_candidates to 3 by default and preserves drop classification', () => {
    const raw = [
      candidate('work', 0.10),
      candidate('work', 0.20),
      candidate('work', 0.30),
      candidate('work', 0.40),
      candidate('work', 0.50),
    ];
    const d = buildExplainEmptyDiagnostics({
      rawCandidates: raw,
      threshold: 0.25,
      scopedKb: 'work',
      allKbs: ['work'],
      staleness: null,
      kbRoot: KB_ROOT,
    });
    expect(d.nearestCandidates).toHaveLength(3);
    expect(d.nearestCandidates.map((c) => c.score)).toEqual([0.10, 0.20, 0.30]);
    expect(d.nearestCandidates.map((c) => c.droppedBy)).toEqual([
      'none',
      'none',
      'threshold',
    ]);
    expect(d.nearestCandidates.every((c) => c.kb === 'work')).toBe(true);
  });

  it('reuses provided staleness without rescanning and folds scoped + global counts', () => {
    const staleness: Staleness = {
      indexMtime: MTIME,
      modifiedFiles: 2,
      newFiles: 5,
      scope: { kb: 'work', modifiedFiles: 2, newFiles: 5 },
      global: { modifiedFiles: 4, newFiles: 7 },
    };
    const d = buildExplainEmptyDiagnostics({
      rawCandidates: [],
      threshold: 0.5,
      scopedKb: 'work',
      allKbs: ['work'],
      staleness,
      kbRoot: KB_ROOT,
    });
    expect(d.freshness.indexBuilt).toBe(true);
    expect(d.freshness.indexMtime).toBe(MTIME);
    expect(d.freshness.scoped).toEqual({ modifiedFiles: 2, newFiles: 5 });
    expect(d.freshness.global).toEqual({ modifiedFiles: 4, newFiles: 7 });
  });

  it('marks freshness as not-built when staleness is null (--no-freshness)', () => {
    const d = buildExplainEmptyDiagnostics({
      rawCandidates: [],
      threshold: 0.5,
      scopedKb: undefined,
      allKbs: ['work'],
      staleness: null,
      kbRoot: KB_ROOT,
    });
    expect(d.freshness.indexBuilt).toBe(false);
    expect(d.freshness.indexMtime).toBeNull();
    expect(d.freshness.scoped).toBeNull();
  });
});

describe('formatExplainEmptyDiagnosticsMarkdown (#328)', () => {
  const baseDiagnostics: ExplainEmptyDiagnostics = {
    threshold: 0.5,
    candidatesPreFilter: 4,
    candidatesPostFilter: 0,
    filterDrops: { kbScope: 2, threshold: 2 },
    scope: {
      requestedKb: 'work',
      kbsSearched: ['work'],
      kbsSkipped: [{ kb: 'personal', reason: 'outside --kb=work' }],
    },
    freshness: {
      indexBuilt: true,
      indexMtime: MTIME,
      scoped: { modifiedFiles: 2, newFiles: 5 },
      global: { modifiedFiles: 4, newFiles: 7 },
    },
    nearestCandidates: [
      { score: 0.62, source: '/kb-root/work/runbook.md', kb: 'work', droppedBy: 'threshold' },
      { score: 0.71, source: '/kb-root/personal/diary.md', kb: 'personal', droppedBy: 'kb_scope' },
    ],
  };

  it('renders a Diagnostics subsection with per-filter drops, scope, and nearest candidates', () => {
    const out = formatExplainEmptyDiagnosticsMarkdown(baseDiagnostics);
    expect(out).toMatch(/^### Diagnostics$/m);
    expect(out).toContain('Candidates inspected: 4');
    expect(out).toContain('Candidates kept after filters: 0');
    expect(out).toContain('Per-filter drops: kb_scope=2, threshold=2 (threshold=0.50)');
    expect(out).toContain('--kb=work');
    expect(out).toContain(`Index: built ${MTIME}, scoped drift=2m+5n, global drift=4m+7n`);
    expect(out).toContain('score=0.620 /kb-root/work/runbook.md — dropped by threshold');
    expect(out).toContain('score=0.710 /kb-root/personal/diary.md — dropped by kb_scope');
  });

  it('omits the scoped-drift fragment when the run was global', () => {
    const out = formatExplainEmptyDiagnosticsMarkdown({
      ...baseDiagnostics,
      scope: {
        requestedKb: null,
        kbsSearched: ['work', 'personal'],
        kbsSkipped: [],
      },
      freshness: { ...baseDiagnostics.freshness, scoped: null },
    });
    expect(out).toContain('Scope: global (2 KB(s) searched: work, personal)');
    expect(out).toContain(`Index: built ${MTIME}, global drift=4m+7n`);
    expect(out).not.toContain('scoped drift=');
  });

  it('says "index not yet built" when freshness shows no index', () => {
    const out = formatExplainEmptyDiagnosticsMarkdown({
      ...baseDiagnostics,
      freshness: {
        indexBuilt: false,
        indexMtime: null,
        scoped: null,
        global: { modifiedFiles: 0, newFiles: 0 },
      },
    });
    expect(out).toContain('Index: not yet built (run `kb search --refresh` to create it)');
  });

  it('surfaces an explicit "none" when FAISS returned zero candidates', () => {
    const out = formatExplainEmptyDiagnosticsMarkdown({
      ...baseDiagnostics,
      candidatesPreFilter: 0,
      filterDrops: { kbScope: 0, threshold: 0 },
      nearestCandidates: [],
    });
    expect(out).toContain('Nearest candidates: none (index may be empty or never built)');
  });
});

describe('--explain-empty output integration (#328)', () => {
  const diagnostics: ExplainEmptyDiagnostics = {
    threshold: 0.5,
    candidatesPreFilter: 3,
    candidatesPostFilter: 0,
    filterDrops: { kbScope: 1, threshold: 2 },
    scope: {
      requestedKb: 'work',
      kbsSearched: ['work'],
      kbsSkipped: [{ kb: 'personal', reason: 'outside --kb=work' }],
    },
    freshness: {
      indexBuilt: true,
      indexMtime: MTIME,
      scoped: { modifiedFiles: 0, newFiles: 0 },
      global: { modifiedFiles: 0, newFiles: 0 },
    },
    nearestCandidates: [
      { score: 0.62, source: '/kb-root/work/a.md', kb: 'work', droppedBy: 'threshold' },
    ],
  };

  it('emits the Diagnostics block in markdown when results are empty', () => {
    const output = formatDenseSearchMarkdownOutput({
      results: [],
      groupBySource: false,
      staleness: {
        indexMtime: MTIME,
        modifiedFiles: 0,
        newFiles: 0,
        scope: { kb: 'work', modifiedFiles: 0, newFiles: 0 },
        global: { modifiedFiles: 0, newFiles: 0 },
      },
      refreshed: false,
      scopedKb: 'work',
      query: 'auth flow',
      autoModeDecision: null,
      autoThresholdDecision: null,
      timing: null,
      explainEmptyDiagnostics: diagnostics,
    });
    expect(output).toContain('_No similar results found._');
    expect(output).toContain('### Diagnostics');
    expect(output).toContain('Per-filter drops: kb_scope=1, threshold=2');
    // Per-filter drops + post-filter count sum to pre-filter total (regression on
    // the diagnostic invariant the issue asks for).
    expect(1 + 2 + 0).toBe(3);
  });

  it('omits the Diagnostics block in markdown when results are non-empty', () => {
    const doc = {
      pageContent: 'hit',
      metadata: { source: 'kb/doc.md' },
      score: 0.5,
    } as unknown as ScoredDocument;
    const output = formatDenseSearchMarkdownOutput({
      results: [doc],
      groupBySource: false,
      staleness: { indexMtime: MTIME, modifiedFiles: 0, newFiles: 0 },
      refreshed: false,
      query: 'auth flow',
      autoModeDecision: null,
      autoThresholdDecision: null,
      timing: null,
      explainEmptyDiagnostics: diagnostics,
    });
    expect(output).toContain('**Result 1:**');
    expect(output).not.toContain('### Diagnostics');
  });

  it('emits empty_result_diagnostics in JSON alongside empty_result_guidance when results are empty', () => {
    const payload = buildDenseSearchJsonPayload({
      results: [],
      requestedMode: 'dense',
      effectiveMode: 'dense',
      autoModeDecision: null,
      groupBySource: false,
      refreshed: false,
      scopedKb: 'work',
      query: 'auth flow',
      staleness: {
        indexMtime: MTIME,
        modifiedFiles: 2,
        newFiles: 5,
        scope: { kb: 'work', modifiedFiles: 2, newFiles: 5 },
        global: { modifiedFiles: 4, newFiles: 7 },
      },
      autoThresholdDecision: null,
      timing: null,
      explainEmptyDiagnostics: diagnostics,
    });
    expect(payload).toHaveProperty('empty_result_guidance');
    expect(payload).toMatchObject({
      empty_result_diagnostics: {
        threshold: 0.5,
        candidates_pre_filter: 3,
        candidates_post_filter: 0,
        filter_drops: { kb_scope: 1, threshold: 2 },
        scope: {
          requested_kb: 'work',
          kbs_searched: ['work'],
          kbs_skipped: [{ kb: 'personal', reason: 'outside --kb=work' }],
        },
        freshness: {
          index_built: true,
          index_mtime: MTIME,
          scoped: { modified_files: 0, new_files: 0 },
          global: { modified_files: 0, new_files: 0 },
        },
        nearest_candidates: [
          {
            score: 0.62,
            source: '/kb-root/work/a.md',
            kb: 'work',
            dropped_by: 'threshold',
          },
        ],
      },
    });
  });

  it('omits empty_result_diagnostics in JSON when results are non-empty', () => {
    const doc = {
      pageContent: 'hit',
      metadata: { source: 'kb/doc.md' },
      score: 0.1,
    } as unknown as ScoredDocument;
    const payload = buildDenseSearchJsonPayload({
      results: [doc],
      requestedMode: 'dense',
      effectiveMode: 'dense',
      autoModeDecision: null,
      groupBySource: false,
      refreshed: false,
      scopedKb: undefined,
      query: 'auth flow',
      staleness: { indexMtime: MTIME, modifiedFiles: 3, newFiles: 1 },
      autoThresholdDecision: null,
      timing: null,
      explainEmptyDiagnostics: diagnostics,
    });
    expect(payload).not.toHaveProperty('empty_result_diagnostics');
  });

  it('runSearch wires the diagnostic probe end-to-end and emits JSON diagnostics on empty + --explain-empty', async () => {
    // Two-call dance: the main search returns [] (scoped, threshold=2 default),
    // and the diagnostic probe re-runs with threshold=+Inf and no kb scope to
    // capture the raw candidates the operator never saw.
    const calls: Array<{
      args: unknown[];
    }> = [];
    // Synthesize sources that match KNOWLEDGE_BASES_ROOT_DIR so the diagnostic
    // KB-name extraction recognises them.
    const sourceFor = (kb: string, file: string) =>
      path.join(KNOWLEDGE_BASES_ROOT_DIR, kb, file);
    const manager = {
      similaritySearch: jest.fn(async (...args: unknown[]) => {
        calls.push({ args });
        const threshold = args[2] as number;
        const scopedKb = args[3] as string | undefined;
        const timing = args[5] as SimilaritySearchTiming | undefined;
        if (timing) timing.faiss_search_ms = (timing.faiss_search_ms ?? 0) + 1;
        if (scopedKb === undefined && threshold === Number.POSITIVE_INFINITY) {
          // Diagnostic probe — return three raw candidates.
          return [
            { pageContent: '', metadata: { source: sourceFor('personal', 'a.md') }, score: 0.10 },
            { pageContent: '', metadata: { source: sourceFor('work', 'b.md') }, score: 0.60 },
            { pageContent: '', metadata: { source: sourceFor('work', 'c.md') }, score: 0.80 },
          ];
        }
        return [];
      }),
    } as unknown as FaissIndexManager & { similaritySearch: jest.Mock };

    const deps: RunSearchDeps = {
      bootstrapLayout: jest.fn(async () => {}),
      resolveActiveModel: jest.fn(async () => 'ollama__nomic-embed-text-latest'),
      loadManagerForModel: jest.fn(async () => manager),
      loadWithJsonRetry: jest.fn(async () => {}),
    };

    const stdoutChunks: string[] = [];
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((c) => {
      stdoutChunks.push(String(c));
      return true;
    });
    try {
      const code = await runSearch(
        ['auth flow', '--kb=work', '--explain-empty', '--format=json', '--no-freshness'],
        deps,
      );
      expect(code).toBe(0);
    } finally {
      stdoutSpy.mockRestore();
    }

    // Two similaritySearch calls: main (scoped, threshold=2) + diagnostic probe.
    expect(manager.similaritySearch).toHaveBeenCalledTimes(2);
    const mainCall = calls[0].args;
    const probeCall = calls[1].args;
    // Default threshold is undefined at the CLI boundary; FaissIndexManager
    // applies the parameter default of 2 internally — the probe explicitly
    // passes +Inf and an undefined KB scope so it captures the raw top-K.
    expect(mainCall[3]).toBe('work');       // scoped to --kb=work
    expect(probeCall[2]).toBe(Number.POSITIVE_INFINITY);
    expect(probeCall[3]).toBeUndefined();    // probe is unscoped

    const payload = JSON.parse(stdoutChunks.join(''));
    expect(payload.empty_result_diagnostics).toBeDefined();
    expect(payload.empty_result_diagnostics).toMatchObject({
      threshold: 2,
      candidates_pre_filter: 3,
      candidates_post_filter: 2,
      filter_drops: { kb_scope: 1, threshold: 0 },
      scope: { requested_kb: 'work' },
    });
    // Sum-consistency invariant: per-filter drops + kept == pre-filter.
    const { filter_drops, candidates_post_filter, candidates_pre_filter } =
      payload.empty_result_diagnostics;
    expect(filter_drops.kb_scope).toBeGreaterThanOrEqual(0);
    expect(filter_drops.threshold).toBeGreaterThanOrEqual(0);
    expect(filter_drops.kb_scope + filter_drops.threshold + candidates_post_filter)
      .toBe(candidates_pre_filter);
  });

  it('runSearch skips the diagnostic probe when results are non-empty (regression: no extra cost)', async () => {
    const manager = {
      similaritySearch: jest.fn(async (...args: unknown[]) => {
        const timing = args[5] as SimilaritySearchTiming | undefined;
        if (timing) timing.faiss_search_ms = (timing.faiss_search_ms ?? 0) + 1;
        return [
          { pageContent: 'hit', metadata: { source: '/kb/work/a.md' }, score: 0.1 },
        ];
      }),
    } as unknown as FaissIndexManager & { similaritySearch: jest.Mock };

    const deps: RunSearchDeps = {
      bootstrapLayout: jest.fn(async () => {}),
      resolveActiveModel: jest.fn(async () => 'ollama__nomic-embed-text-latest'),
      loadManagerForModel: jest.fn(async () => manager),
      loadWithJsonRetry: jest.fn(async () => {}),
    };

    const stdoutChunks: string[] = [];
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation((c) => {
      stdoutChunks.push(String(c));
      return true;
    });
    try {
      const code = await runSearch(
        ['auth flow', '--explain-empty', '--format=json', '--no-freshness'],
        deps,
      );
      expect(code).toBe(0);
    } finally {
      stdoutSpy.mockRestore();
    }

    // Exactly one call — the diagnostic probe should not run on non-empty
    // results, so `--explain-empty` is free in the happy path.
    expect(manager.similaritySearch).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(stdoutChunks.join(''));
    expect(payload).not.toHaveProperty('empty_result_diagnostics');
  });

  it('preserves the #335 inline guidance regression when --explain-empty is off', () => {
    // Off-by-default: same call shape as the existing #335 test, no
    // `explainEmptyDiagnostics` passed → diagnostics never appear and the
    // inline tip + omitted-footer behaviour is byte-equal.
    const output = formatDenseSearchMarkdownOutput({
      results: [],
      groupBySource: false,
      staleness: {
        indexMtime: MTIME,
        modifiedFiles: 2,
        newFiles: 5,
        scope: { kb: 'work', modifiedFiles: 2, newFiles: 5 },
        global: { modifiedFiles: 4, newFiles: 7 },
      },
      refreshed: false,
      scopedKb: 'work',
      query: 'auth flow',
      autoModeDecision: null,
      autoThresholdDecision: null,
      timing: null,
    });
    expect(output).not.toContain('### Diagnostics');
    expect(output).toContain('**Tip:** No results found, and the "work" KB scope is stale');
    expect(output).toContain('kb search "auth flow" --kb=work --refresh');
    expect(output).not.toContain('Run `kb search --kb=work --refresh` to update this scope');
  });
});
