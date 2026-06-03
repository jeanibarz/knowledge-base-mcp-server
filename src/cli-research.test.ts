import { describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  RESEARCH_HELP,
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
      'agent-task-lessons': {
        file_count: 8,
        chunk_count: 20,
        total_bytes_indexed: 2000,
        last_updated_at: null,
      },
      'job-search-agents': {
        file_count: 7,
        chunk_count: 18,
        total_bytes_indexed: 1500,
        last_updated_at: null,
      },
    },
    quarantined: {},
    filesystem: {
      enumeration_failures: { failure_count: 0, failures: [] },
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
      failure_count: 0,
      failures: [],
      warning_count: 0,
      warnings: [],
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
    ...overrides,
  };
}

function shelfDescriptions(): ShelfDescription[] {
  return [
    { name: 'llm-agents', description: 'Autonomous LLM agents, planning, tool use, and evaluation' },
    { name: 'llm-as-judge', description: 'LLM judge evals, rubric design, bias mitigation, and critic reliability' },
    { name: 'recipes', description: 'Cooking notes and kitchen experiments' },
    { name: 'agent-task-lessons', description: 'Operational task lessons from coding agent runs' },
    { name: 'job-search-agents', description: 'Job search agents, applications, and recruiting workflows' },
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
      const payload = opts.searchPayload ?? fixtureSearchPayload(shelf, input.query);
      return {
        exitCode: 0,
        stdout: JSON.stringify(payload),
        stderr: '',
        payload,
      };
    }),
    now: jest.fn(() => new Date('2026-05-21T09:30:00.000Z')),
    stdout: (text) => { stdout.push(text); },
    stderr: (text) => { stderr.push(text); },
  };
  return { deps, stdout, stderr };
}

function fixtureSearchPayload(shelf: string, query: string): Record<string, unknown> {
  const lines = lineRangeForQuery(query);
  return {
    mode: 'hybrid',
    results: [{
      score: 0.42,
      content: 'Agent evaluation evidence with rubric stability and tool-use traces.',
      chunk_id: `${shelf}/papers/agent-evals.md#L${lines.from}-L${lines.to}`,
      metadata: {
        knowledgeBase: shelf,
        relativePath: `${shelf}/papers/agent-evals.md`,
        loc: { lines },
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

function repeatedPassagePayload(shelf: string): Record<string, unknown> {
  const lines = { from: 10, to: 14 };
  return {
    mode: 'hybrid',
    results: [{
      score: 0.42,
      content: 'Repeated passage about agent evaluation and evidence packet readability.',
      chunk_id: `${shelf}/papers/repeated.md#L${lines.from}-L${lines.to}`,
      metadata: {
        knowledgeBase: shelf,
        relativePath: `${shelf}/papers/repeated.md`,
        loc: { lines },
      },
    }],
    retrievers: {
      dense: { fetched: 1, model: 'ollama__nomic-embed-text-latest' },
      lexical: { fetched: 1, refreshed: 0, failed: 0 },
    },
  };
}

function lineRangeForQuery(query: string): { from: number; to: number } {
  if (query === 'autonomous agents judges') return { from: 20, to: 24 };
  if (query.includes('llm as judge')) return { from: 30, to: 34 };
  return { from: 10, to: 14 };
}

describe('kb research CLI', () => {
  it('explains dense coverage warnings in command help', () => {
    expect(RESEARCH_HELP).toContain('dense_index_empty_coverage');
    expect(RESEARCH_HELP).toContain('lexical-heavy and lower confidence');
    expect(RESEARCH_HELP).toContain('read-only command');
  });

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
      maxShelves: 5,
    });
    expect(parseResearchArgs([
      'plan',
      'agent evals',
      '--kb=llm-agents',
      '--include-kb',
      'llm-as-judge',
      '--exclude-kb=recipes',
      '--max-shelves=2',
    ])).toMatchObject({
      includeShelves: ['llm-agents', 'llm-as-judge'],
      excludeShelves: ['recipes'],
      maxShelves: 2,
    });
    expect(() => parseResearchArgs(['collect', 'agent evals'])).toThrow('collect requires --run-dir');
    expect(() => parseResearchArgs(['collect', 'agent evals', '--run-dir', '--format=json'])).toThrow(
      'missing value for --run-dir',
    );
    expect(() => parseResearchArgs(['plan', 'agent evals', '--max-shelves=0'])).toThrow('invalid --max-shelves');
    expect(() => parseResearchArgs(['plan', 'agent evals', '--kb=llm-agents', '--exclude-kb=llm-agents'])).toThrow(
      'cannot include and exclude the same shelf',
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
      'llm-as-judge',
      'llm-agents',
    ]);
    expect(first.queries[0]).toMatchObject({
      id: 'q1',
      text: 'autonomous agents as judges and evals',
      shelves: ['llm-as-judge', 'llm-agents'],
    });
    expect(first.risks).toContainEqual(expect.objectContaining({
      code: 'dense_index_empty_coverage',
      shelf: 'llm-as-judge',
    }));
    expect(deps.searchHybrid).not.toHaveBeenCalled();
  });

  it('ranks specific domain shelves ahead of broad agent shelves', async () => {
    const { deps } = makeDeps();
    const prompt = 'end-to-end approach for autonomous research agents and evals, including LLM-as-judge bias mitigation';

    const plan = await buildResearchPlan(prompt, 5, deps);

    expect(plan.selected_shelves.map((shelf) => shelf.name)).toEqual([
      'llm-as-judge',
      'llm-agents',
    ]);
    expect(plan.selected_shelves.map((shelf) => shelf.name)).not.toContain('agent-task-lessons');
    expect(plan.selected_shelves.map((shelf) => shelf.name)).not.toContain('job-search-agents');
    const queryTexts = plan.queries.map((query) => query.text);
    expect(queryTexts).toEqual(expect.arrayContaining([
      expect.stringContaining('bias'),
    ]));
    expect(queryTexts.every((text) => /\bbias\b/.test(text))).toBe(true);
    expect(queryTexts.every((text) => !/\bbia\b/.test(text))).toBe(true);
  });

  it('supports explicit include, exclude, and max-shelves controls', async () => {
    const { deps } = makeDeps();
    const prompt = 'end-to-end approach for autonomous research agents and evals, including LLM-as-judge bias mitigation';

    const included = await buildResearchPlan(prompt, 5, deps, {
      includeShelves: ['agent-task-lessons'],
      maxShelves: 2,
    });
    expect(included.selected_shelves.map((shelf) => shelf.name)).toEqual([
      'agent-task-lessons',
      'llm-as-judge',
      'llm-agents',
    ]);

    const excluded = await buildResearchPlan(prompt, 5, deps, {
      excludeShelves: ['llm-as-judge'],
      maxShelves: 1,
    });
    expect(excluded.selected_shelves.map((shelf) => shelf.name)).toEqual(['llm-agents']);
  });

  it('prints plan JSON shape without running search', async () => {
    const { deps, stdout, stderr } = makeDeps();

    const code = await runResearch(['plan', 'autonomous agents as judges', '--format=json'], deps);

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.schema_version).toBe('kb-research-plan.v1');
    expect(parsed.selected_shelves[0].name).toBe('llm-as-judge');
    expect(deps.searchHybrid).not.toHaveBeenCalled();
  });

  it('prints dense coverage confidence guidance in markdown plan output', async () => {
    const { deps, stdout, stderr } = makeDeps();

    const code = await runResearch(['plan', 'autonomous agents as judges'], deps);

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    expect(stdout.join('')).toContain('dense_index_empty_coverage');
    expect(stdout.join('')).toContain('lexical-heavy and lower confidence');
    expect(deps.searchHybrid).not.toHaveBeenCalled();
  });

  it('applies explicit shelf controls through the plan command path', async () => {
    const { deps, stdout, stderr } = makeDeps();

    const code = await runResearch([
      'plan',
      'autonomous agents as judges',
      '--include-kb=agent-task-lessons',
      '--exclude-kb=llm-as-judge',
      '--max-shelves=1',
      '--format=json',
    ], deps);

    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    const parsed = JSON.parse(stdout.join(''));
    expect(parsed.selected_shelves.map((shelf: { name: string }) => shelf.name)).toEqual([
      'agent-task-lessons',
      'llm-agents',
    ]);
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
        source_id: 'llm-as-judge/papers/agent-evals.md#L10-L14',
        shelf: 'llm-as-judge',
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
      expect(packet).toContain('llm-agents/papers/agent-evals.md — 3 passages');
      expect(packet).toContain('llm-as-judge/papers/agent-evals.md — 3 passages');
      expect(packet.match(/papers\/agent-evals\.md — 3 passages/g)).toHaveLength(2);
      expect(packet).toContain('L10-L14 via q1');
      expect(packet).toContain('L20-L24 via q2');
      expect(packet).toContain('L30-L34 via q3');

      const events = parseJsonl(await fsp.readFile(path.join(runDir, 'events.jsonl'), 'utf-8'));
      expect(events.filter((event) => event.type === 'search_completed')).toHaveLength(6);
      expect(deps.searchHybrid).toHaveBeenCalledTimes(6);
      expect(deps.searchHybrid).toHaveBeenNthCalledWith(1, {
        query: 'autonomous agents as judges',
        shelf: 'llm-as-judge',
        k: 5,
      });
      expect(deps.searchHybrid).toHaveBeenNthCalledWith(2, {
        query: 'autonomous agents as judges',
        shelf: 'llm-agents',
        k: 5,
      });
      expect(deps.searchHybrid).toHaveBeenNthCalledWith(3, {
        query: 'autonomous agents judges',
        shelf: 'llm-as-judge',
        k: 5,
      });
      expect(deps.searchHybrid).toHaveBeenNthCalledWith(4, {
        query: 'autonomous agents judges',
        shelf: 'llm-agents',
        k: 5,
      });
      expect(deps.searchHybrid).toHaveBeenNthCalledWith(5, {
        query: 'autonomous agents as judges llm as judge llm agents',
        shelf: 'llm-as-judge',
        k: 5,
      });
      expect(deps.searchHybrid).toHaveBeenNthCalledWith(6, {
        query: 'autonomous agents as judges llm as judge llm agents',
        shelf: 'llm-agents',
        k: 5,
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('deduplicates repeated packet passages while keeping the ledger lossless', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-research-dedupe-'));
    const runDir = path.join(tempDir, 'run');
    const { deps, stdout, stderr } = makeDeps();
    deps.searchHybrid = jest.fn(async (input: { query: string; shelf: string; k: number }) => ({
      exitCode: 0,
      stdout: JSON.stringify(repeatedPassagePayload(input.shelf)),
      stderr: '',
      payload: repeatedPassagePayload(input.shelf),
    }));

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
      expect(JSON.parse(stdout.join('')).status).toBe('complete');

      const ledger = JSON.parse(await fsp.readFile(path.join(runDir, 'ledger.json'), 'utf-8'));
      expect(ledger.entries).toHaveLength(6);

      const packet = await fsp.readFile(path.join(runDir, 'evidence_packet.md'), 'utf-8');
      expect(packet).toContain('llm-agents/papers/repeated.md — 1 unique passage, 3 retrieval matches');
      expect(packet).toContain('llm-as-judge/papers/repeated.md — 1 unique passage, 3 retrieval matches');
      expect(packet.match(/via q1, q2, q3/g)).toHaveLength(2);
      expect(packet.match(/Repeated passage about agent evaluation/g)).toHaveLength(2);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('applies explicit shelf controls through the collect command path', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-research-controls-'));
    const runDir = path.join(tempDir, 'run');
    const { deps, stdout, stderr } = makeDeps();

    try {
      const code = await runResearch([
        'collect',
        'autonomous agents as judges',
        '--include-kb=agent-task-lessons',
        '--exclude-kb=llm-as-judge',
        '--max-shelves=1',
        '--run-dir',
        runDir,
        '--format=json',
      ], deps);

      expect(code).toBe(0);
      expect(stderr.join('')).toBe('');
      const summary = JSON.parse(stdout.join(''));
      expect(summary.status).toBe('complete');
      expect(deps.searchHybrid).toHaveBeenCalledTimes(6);
      const searchedShelves = new Set(
        (deps.searchHybrid as jest.Mock).mock.calls.map(([input]) => (input as { shelf: string }).shelf),
      );
      expect([...searchedShelves]).toEqual(['agent-task-lessons', 'llm-agents']);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('prints dense coverage confidence guidance in markdown collect output', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-research-md-'));
    const runDir = path.join(tempDir, 'run');
    const { deps, stdout, stderr } = makeDeps();

    try {
      const code = await runResearch([
        'collect',
        'autonomous agents as judges',
        '--run-dir',
        runDir,
      ], deps);

      expect(code).toBe(0);
      expect(stderr.join('')).toBe('');
      expect(stdout.join('')).toContain('Coverage note: dense-index coverage warnings');
      expect(stdout.join('')).toContain('lexical-heavy and lower confidence');
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
        shelf: 'llm-as-judge',
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
