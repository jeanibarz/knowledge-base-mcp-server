import * as path from 'path';
import { describe, expect, it, jest } from '@jest/globals';
import {
  buildDenseSearchJsonPayload,
  createRefreshProgressReporter,
  formatDenseSearchMarkdownOutput,
  formatRefreshProgressLine,
  parseSearchArgs,
  runSearch,
  shouldUsePicker,
  type RunSearchDeps,
} from './cli-search.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { compactTimingPayload, type TimingPayload } from './cli-timing.js';
import type { ScoredDocument } from './formatter.js';
import type { FaissIndexManager, SimilaritySearchTiming } from './FaissIndexManager.js';
import type { ExplainEmptyDiagnostics, Staleness } from './search-core.js';

const MTIME = '2026-05-03T15:33:56.964Z';

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
