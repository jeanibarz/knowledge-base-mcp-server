import { describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  buildResearchPlan,
  parseResearchArgs,
  runResearch,
  type ResearchDeps,
  type ShelfDescription,
} from './cli-research.js';
import type { KbStatsPayload } from './kb-stats.js';

function statsPayload(overrides: Partial<KbStatsPayload> = {}): KbStatsPayload {
  return {
    knowledge_bases: {
      'llm-agents': {
        file_count: 4,
        chunk_count: 12,
        total_bytes_indexed: 1000,
        last_updated_at: '2026-05-21T08:00:00.000Z',
      },
      'llm-as-judge': {
        file_count: 2,
        chunk_count: 0,
        total_bytes_indexed: 500,
        last_updated_at: null,
      },
      recipes: {
        file_count: 3,
        chunk_count: 9,
        total_bytes_indexed: 300,
        last_updated_at: null,
      },
    },
    quarantined: {},
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
      failure_count: 0,
      failures: [],
    },
    server: {
      version: 'test',
      uptime_ms: 1,
    },
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
    ...overrides,
  };
}

function shelfDescriptions(): ShelfDescription[] {
  return [
    { name: 'llm-agents', description: 'Autonomous LLM agents, planning, tool use, and evaluation' },
    { name: 'llm-as-judge', description: 'LLM judge evals, rubric design, and critic reliability' },
    { name: 'recipes', description: 'Cooking notes and kitchen experiments' },
  ];
}

function makeDeps(opts: {
  stats?: KbStatsPayload;
  searchExitCode?: number;
  searchPayload?: Record<string, unknown>;
} = {}): { deps: ResearchDeps; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: ResearchDeps = {
    loadShelfDescriptions: jest.fn(async () => shelfDescriptions()),
    loadStats: jest.fn(async () => opts.stats ?? statsPayload()),
    searchHybrid: jest.fn(async (input: { query: string; shelf: string; k: number }) => {
      const { shelf } = input;
      if (opts.searchExitCode !== undefined && opts.searchExitCode !== 0) {
        return {
          exitCode: opts.searchExitCode,
          stdout: JSON.stringify({ error: { code: 'INDEX_ERROR', message: 'fixture search failed' } }),
          stderr: 'fixture search failed',
          payload: { error: { code: 'INDEX_ERROR', message: 'fixture search failed' } },
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify(opts.searchPayload ?? fixtureSearchPayload(shelf)),
        stderr: '',
        payload: opts.searchPayload ?? fixtureSearchPayload(shelf),
      };
    }),
    now: jest.fn(() => new Date('2026-05-21T09:30:00.000Z')),
    stdout: (text) => { stdout.push(text); },
    stderr: (text) => { stderr.push(text); },
  };
  return { deps, stdout, stderr };
}

function fixtureSearchPayload(shelf: string): Record<string, unknown> {
  return {
    mode: 'hybrid',
    results: [{
      score: 0.42,
      content: 'Agent evaluation evidence with rubric stability and tool-use traces.',
      chunk_id: `${shelf}/papers/agent-evals.md#L10-L14`,
      metadata: {
        knowledgeBase: shelf,
        relativePath: `${shelf}/papers/agent-evals.md`,
        loc: { lines: { from: 10, to: 14 } },
        frontmatter: {
          source_kind: 'paper-note',
          source_generation: 'lra',
        },
      },
    }],
    retrievers: {
      dense: { fetched: 1, model: 'ollama__nomic-embed-text-latest' },
      lexical: { fetched: 1, refreshed: 0, failed: 0 },
    },
  };
}

describe('kb research CLI', () => {
  it('parses plan and collect arguments', () => {
    expect(parseResearchArgs(['plan', 'agent evals', '--format=json'])).toMatchObject({
      action: 'plan',
      question: 'agent evals',
      format: 'json',
    });
    expect(parseResearchArgs(['collect', 'agent evals', '--run-dir', 'runs/a', '--k=3'])).toMatchObject({
      action: 'collect',
      runDir: 'runs/a',
      k: 3,
    });
    expect(() => parseResearchArgs(['collect', 'agent evals'])).toThrow('collect requires --run-dir');
    expect(() => parseResearchArgs(['collect', 'agent evals', '--run-dir', '--format=json'])).toThrow(
      'missing value for --run-dir',
    );
  });

  it('builds deterministic plan JSON from shelf descriptions and stats', async () => {
    const { deps } = makeDeps();

    const first = await buildResearchPlan('autonomous agents as judges and evals', 5, deps);
    const second = await buildResearchPlan('autonomous agents as judges and evals', 5, deps);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schema_version: 'kb-research-plan.v1',
      question: 'autonomous agents as judges and evals',
      retrieval: { mode: 'hybrid', k: 5 },
    });
    expect(first.selected_shelves.map((shelf) => shelf.name)).toEqual([
      'llm-agents',
      'llm-as-judge',
    ]);
    expect(first.queries[0]).toMatchObject({
      id: 'q1',
      text: 'autonomous agents as judges and evals',
      shelves: ['llm-agents', 'llm-as-judge'],
    });
    expect(first.risks).toContainEqual(expect.objectContaining({
      code: 'dense_index_empty_coverage',
      shelf: 'llm-as-judge',
    }));
    expect(deps.searchHybrid).not.toHaveBeenCalled();
  });

  it('prints plan JSON shape without running search', async () => {
    const { deps, stdout, stderr } = makeDeps();

    const code = await runResearch(['plan', 'autonomous agents as judges', '--format=json'], deps);

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.schema_version).toBe('kb-research-plan.v1');
    expect(parsed.selected_shelves[0].name).toBe('llm-agents');
    expect(deps.searchHybrid).not.toHaveBeenCalled();
  });

  it('collect creates run artifacts and ledger entries from fixture hybrid search results', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-research-test-'));
    const runDir = path.join(tempDir, 'run');
    const { deps, stdout, stderr } = makeDeps();

    try {
      const code = await runResearch([
        'collect',
        'autonomous agents as judges',
        '--run-dir',
        runDir,
        '--format=json',
      ], deps);

      expect(code).toBe(0);
      expect(stderr.join('')).toBe('');
      const summary = JSON.parse(stdout.join(''));
      expect(summary.status).toBe('complete');
      for (const filename of ['run.json', 'plan.json', 'ledger.json', 'evidence_packet.md', 'events.jsonl']) {
        await expect(fsp.stat(path.join(runDir, filename))).resolves.toBeTruthy();
      }

      const ledger = JSON.parse(await fsp.readFile(path.join(runDir, 'ledger.json'), 'utf-8'));
      expect(ledger.schema_version).toBe('kb-research-ledger.v1');
      expect(ledger.entries).toHaveLength(6);
      expect(ledger.entries[0]).toMatchObject({
        source_id: 'llm-agents/papers/agent-evals.md#L10-L14',
        shelf: 'llm-agents',
        relative_path: 'papers/agent-evals.md',
        line_range: { from: 10, to: 14 },
        query: 'autonomous agents as judges',
        retrieval_mode: 'hybrid',
        score: 0.42,
        source_kind: 'paper-note',
        source_generation: 'lra',
      });
      const denseRiskEntry = ledger.entries.find((entry: { shelf: string }) => entry.shelf === 'llm-as-judge');
      expect(denseRiskEntry?.risk_flags).toContain('dense_index_empty_coverage');

      const packet = await fsp.readFile(path.join(runDir, 'evidence_packet.md'), 'utf-8');
      expect(packet).toContain('## Question');
      expect(packet).toContain('## Selected Shelves');
      expect(packet).toContain('## Queries');
      expect(packet).toContain('## Evidence Found');
      expect(packet).toContain('## Evidence Gaps');
      expect(packet).toContain('## Sources');

      const events = parseJsonl(await fsp.readFile(path.join(runDir, 'events.jsonl'), 'utf-8'));
      expect(events.filter((event) => event.type === 'search_completed')).toHaveLength(6);
      expect(deps.searchHybrid).toHaveBeenCalledTimes(6);
      expect(deps.searchHybrid).toHaveBeenNthCalledWith(1, {
        query: 'autonomous agents as judges',
        shelf: 'llm-agents',
        k: 5,
      });
      expect(deps.searchHybrid).toHaveBeenNthCalledWith(2, {
        query: 'autonomous agents as judges',
        shelf: 'llm-as-judge',
        k: 5,
      });
      expect(deps.searchHybrid).toHaveBeenNthCalledWith(3, {
        query: 'autonomous agent judge',
        shelf: 'llm-agents',
        k: 5,
      });
      expect(deps.searchHybrid).toHaveBeenNthCalledWith(4, {
        query: 'autonomous agent judge',
        shelf: 'llm-as-judge',
        k: 5,
      });
      expect(deps.searchHybrid).toHaveBeenNthCalledWith(5, {
        query: 'autonomous agents as judges llm agents llm as judge',
        shelf: 'llm-agents',
        k: 5,
      });
      expect(deps.searchHybrid).toHaveBeenNthCalledWith(6, {
        query: 'autonomous agents as judges llm agents llm as judge',
        shelf: 'llm-as-judge',
        k: 5,
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('records kb search failures as events and exits non-zero after writing partial artifacts', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-research-fail-'));
    const runDir = path.join(tempDir, 'run');
    const { deps, stdout } = makeDeps({ searchExitCode: 1 });

    try {
      const code = await runResearch([
        'collect',
        'autonomous agents as judges',
        '--run-dir',
        runDir,
        '--format=json',
      ], deps);

      expect(code).toBe(1);
      const summary = JSON.parse(stdout.join(''));
      expect(summary.status).toBe('failed');
      expect(summary.search_failure_count).toBeGreaterThan(0);

      const ledger = JSON.parse(await fsp.readFile(path.join(runDir, 'ledger.json'), 'utf-8'));
      expect(ledger.search_failures[0]).toMatchObject({
        shelf: 'llm-agents',
        exit_code: 1,
        message: 'fixture search failed',
      });
      const events = parseJsonl(await fsp.readFile(path.join(runDir, 'events.jsonl'), 'utf-8'));
      expect(events.map((event) => event.type)).toContain('search_failure');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('treats hybrid lexical leg failures as search failures even when search exits 0', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-research-hybrid-fail-'));
    const runDir = path.join(tempDir, 'run');
    const { deps, stdout } = makeDeps({
      searchPayload: {
        mode: 'hybrid',
        results: [],
        retrievers: {
          dense: { fetched: 0, model: 'ollama__nomic-embed-text-latest' },
          lexical: { fetched: 0, refreshed: 0, failed: 1 },
        },
      },
    });
    deps.searchHybrid = jest.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        mode: 'hybrid',
        results: [],
        retrievers: {
          dense: { fetched: 0, model: 'ollama__nomic-embed-text-latest' },
          lexical: { fetched: 0, refreshed: 0, failed: 1 },
        },
      }),
      stderr: 'kb search (hybrid lexical leg): llm-as-judge - broken lexical index',
      payload: {
        mode: 'hybrid',
        results: [],
        retrievers: {
          dense: { fetched: 0, model: 'ollama__nomic-embed-text-latest' },
          lexical: { fetched: 0, refreshed: 0, failed: 1 },
        },
      },
    }));

    try {
      const code = await runResearch([
        'collect',
        'autonomous agents as judges',
        '--run-dir',
        runDir,
        '--format=json',
      ], deps);

      expect(code).toBe(1);
      const summary = JSON.parse(stdout.join(''));
      expect(summary.status).toBe('failed');
      const ledger = JSON.parse(await fsp.readFile(path.join(runDir, 'ledger.json'), 'utf-8'));
      expect(ledger.search_failures[0]).toMatchObject({
        exit_code: 0,
        message: 'kb search (hybrid lexical leg): llm-as-judge - broken lexical index',
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});

function parseJsonl(content: string): Array<Record<string, unknown>> {
  return content.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}
