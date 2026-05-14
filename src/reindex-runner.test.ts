// RFC 017 M0b — unit tests for src/reindex-runner.ts.
//
// Each test isolates FAISS_INDEX_PATH + KNOWLEDGE_BASES_ROOT_DIR under
// a fresh temp dir and re-imports the runner so its module-level
// `FAISS_INDEX_PATH` snapshot picks up the per-test value. The actual
// `updateIndex` call is mocked via the `runUpdateIndex` test seam, so
// no real embedding provider or FAISS native code runs.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

type RunnerModule = typeof import('./reindex-runner.js');

let tempDir: string;
let savedEnv: Record<string, string | undefined>;
let runner: RunnerModule;

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function makeNeverRunSummary(): import('./FaissIndexManager.js').IndexUpdateSummary {
  return {
    status: 'success',
    scope: 'global',
    model_id: 'test-model',
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 1,
    files_scanned: 0,
    files_changed: 0,
    files_unchanged: 0,
    files_failed: 0,
    failure_count: 0,
    failures: [],
  } as unknown as import('./FaissIndexManager.js').IndexUpdateSummary;
}

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-reindex-runner-'));
  savedEnv = {
    FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
    KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
  };
  setEnv('FAISS_INDEX_PATH', path.join(tempDir, 'faiss'));
  setEnv('KNOWLEDGE_BASES_ROOT_DIR', path.join(tempDir, 'kbs'));
  await fsp.mkdir(path.join(tempDir, 'kbs', 'alpha'), { recursive: true });
  await fsp.mkdir(path.join(tempDir, 'kbs', 'beta'), { recursive: true });
  // Need a real ingestable file so listKnowledgeBases finds the KBs.
  await fsp.writeFile(path.join(tempDir, 'kbs', 'alpha', 'a.md'), '# a\n');
  await fsp.writeFile(path.join(tempDir, 'kbs', 'beta', 'b.md'), '# b\n');
  // jest.resetModules() ensures the runner re-reads the env at import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jest.resetModules();
  runner = (await import('./reindex-runner.js')) as RunnerModule;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) setEnv(key, value);
  await fsp.rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Guard boundary cases (deterministic UTC math).
// ---------------------------------------------------------------------------

describe('LRA guard window — UTC arithmetic', () => {
  it('rejects a run started exactly at 06:00:00 UTC', async () => {
    const now = new Date(Date.UTC(2026, 4, 15, 6, 0, 0));
    const result = await runner.runReindex({
      knowledgeBases: [],
      force: false,
      now,
      resolveKbs: async () => ['alpha'],
      runUpdateIndex: async () => makeNeverRunSummary(),
    });
    expect(result.outcome).toBe('guard_blocked');
  });

  it('allows a run at 05:59:59 UTC when the estimated runtime fits before 06:00', async () => {
    // No chunk manifest exists → estimate is 0 → cannot cross the window.
    const now = new Date(Date.UTC(2026, 4, 15, 5, 59, 59));
    const result = await runner.runReindex({
      knowledgeBases: [],
      force: false,
      now,
      resolveKbs: async () => ['alpha'],
      runUpdateIndex: async () => makeNeverRunSummary(),
    });
    expect(result.outcome).toBe('completed');
  });

  it('rejects a run at 10:29:59 UTC (still inside the window)', async () => {
    const now = new Date(Date.UTC(2026, 4, 15, 10, 29, 59));
    const result = await runner.runReindex({
      knowledgeBases: [],
      force: false,
      now,
      resolveKbs: async () => ['alpha'],
      runUpdateIndex: async () => makeNeverRunSummary(),
    });
    expect(result.outcome).toBe('guard_blocked');
  });

  it('allows a run at 10:30:00 UTC (window has just ended)', async () => {
    const now = new Date(Date.UTC(2026, 4, 15, 10, 30, 0));
    const result = await runner.runReindex({
      knowledgeBases: [],
      force: false,
      now,
      resolveKbs: async () => ['alpha'],
      runUpdateIndex: async () => makeNeverRunSummary(),
    });
    expect(result.outcome).toBe('completed');
  });

  it('--force bypasses the window guard', async () => {
    const now = new Date(Date.UTC(2026, 4, 15, 8, 0, 0));
    const result = await runner.runReindex({
      knowledgeBases: [],
      force: true,
      now,
      resolveKbs: async () => ['alpha'],
      runUpdateIndex: async () => makeNeverRunSummary(),
    });
    expect(result.outcome).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Self-runtime estimator — chunk-count → seconds math.
// ---------------------------------------------------------------------------

describe('self-runtime estimator', () => {
  it('computes total_chunks * 8s as the budget upper bound', async () => {
    const kbsDir = path.join(tempDir, 'kbs');
    const indexDir = path.join(kbsDir, 'alpha', '.index');
    await fsp.mkdir(indexDir, { recursive: true });
    // 100 chunks × 8s = 800s estimated.
    await fsp.writeFile(
      path.join(indexDir, 'note.chunks.json'),
      JSON.stringify({ chunks: new Array(100).fill({}) }),
    );
    const got = await runner.estimateChunkCountForKbs(['alpha']);
    expect(got).toBe(100);
  });

  it('refuses to start when the estimated runtime would cross 06:00 UTC', async () => {
    const kbsDir = path.join(tempDir, 'kbs');
    const indexDir = path.join(kbsDir, 'alpha', '.index');
    await fsp.mkdir(indexDir, { recursive: true });
    // 1000 chunks × 8s = 8000s ≈ 2h13m. Starting at 04:00 UTC would
    // cross 06:00 UTC.
    await fsp.writeFile(
      path.join(indexDir, 'note.chunks.json'),
      JSON.stringify({ chunks: new Array(1000).fill({}) }),
    );
    const result = await runner.runReindex({
      knowledgeBases: [],
      force: false,
      now: new Date(Date.UTC(2026, 4, 15, 4, 0, 0)),
      resolveKbs: async () => ['alpha'],
      runUpdateIndex: async () => makeNeverRunSummary(),
    });
    expect(result.outcome).toBe('guard_blocked');
    expect(result.reason).toMatch(/cross the next LRA cron window/);
  });
});

// ---------------------------------------------------------------------------
// .reindex.run.json + PID liveness
// ---------------------------------------------------------------------------

describe('.reindex.run.json + PID liveness', () => {
  it('writes the run-state file during a run and removes it on success', async () => {
    let stateAtMidRun: unknown = null;
    const result = await runner.runReindex({
      knowledgeBases: [],
      force: false,
      now: new Date(Date.UTC(2026, 4, 15, 0, 0, 0)),
      resolveKbs: async () => ['alpha'],
      runUpdateIndex: async () => {
        // The runner has already written the run-state file at this
        // point. Capture it before letting updateIndex "finish".
        stateAtMidRun = await fsp.readFile(runner.runStateFilePath(), 'utf-8');
        return makeNeverRunSummary();
      },
    });
    expect(result.outcome).toBe('completed');
    expect(stateAtMidRun).toBeTruthy();
    const parsed = JSON.parse(stateAtMidRun as string);
    expect(parsed.schema_version).toBe(runner.REINDEX_RUN_SCHEMA_VERSION);
    expect(parsed.pid).toBe(process.pid);

    // File is gone after success.
    await expect(fsp.access(runner.runStateFilePath())).rejects.toThrow();
  });

  it('removes the run-state file when updateIndex throws', async () => {
    await expect(
      runner.runReindex({
        knowledgeBases: [],
        force: false,
        now: new Date(Date.UTC(2026, 4, 15, 0, 0, 0)),
        resolveKbs: async () => ['alpha'],
        runUpdateIndex: async () => {
          throw new Error('synthetic boom');
        },
      }),
    ).resolves.toMatchObject({ outcome: 'failed' });
    await expect(fsp.access(runner.runStateFilePath())).rejects.toThrow();
  });

  it('refuses to start when a peer reindex is alive', async () => {
    // Write a run-state file naming THIS process's PID (always alive).
    await fsp.mkdir(path.dirname(runner.runStateFilePath()), { recursive: true });
    await fsp.writeFile(
      runner.runStateFilePath(),
      JSON.stringify({
        schema_version: runner.REINDEX_RUN_SCHEMA_VERSION,
        pid: process.pid,
        started_at: new Date().toISOString(),
        kbs_in_scope: ['alpha'],
      }),
    );
    const result = await runner.runReindex({
      knowledgeBases: [],
      force: false,
      now: new Date(Date.UTC(2026, 4, 15, 0, 0, 0)),
      resolveKbs: async () => ['alpha'],
      runUpdateIndex: async () => makeNeverRunSummary(),
    });
    // The runner returns a `lock_held` result (not a throw) so the CLI
    // can map it to exit code 4 without unwrapping an exception.
    expect(result.outcome).toBe('lock_held');
    expect(result.reason).toMatch(/in progress/);
  });

  it('cleans up a zombie state file (dead PID) and proceeds', async () => {
    // Write a run-state file naming a definitely-dead PID. PID 1 is
    // alive on most systems; we use a high number unlikely to exist.
    // Worst case the test is brittle on systems where the chosen PID
    // happens to exist — choose Number.MAX_SAFE_INTEGER to make that
    // effectively impossible.
    const zombiePid = 4_294_967_295; // 2^32 - 1; far above any real PID
    await fsp.mkdir(path.dirname(runner.runStateFilePath()), { recursive: true });
    await fsp.writeFile(
      runner.runStateFilePath(),
      JSON.stringify({
        schema_version: runner.REINDEX_RUN_SCHEMA_VERSION,
        pid: zombiePid,
        started_at: '2020-01-01T00:00:00.000Z',
        kbs_in_scope: ['alpha'],
      }),
    );

    expect(runner.isPidAlive(zombiePid)).toBe(false);

    const check = await runner.checkReindexRunState();
    expect(check.alive).toBe(false);
    // File should have been deleted by the zombie cleanup.
    await expect(fsp.access(runner.runStateFilePath())).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Result reporting
// ---------------------------------------------------------------------------

describe('result reporting', () => {
  it('reports completed when updateIndex returns success', async () => {
    const summary = makeNeverRunSummary();
    summary.files_changed = 12;
    const result = await runner.runReindex({
      knowledgeBases: [],
      force: true,
      resolveKbs: async () => ['alpha', 'beta'],
      runUpdateIndex: async () => summary,
    });
    expect(result.outcome).toBe('completed');
    expect(result.kbs_attempted).toBe(2);
    expect(result.summary?.files_changed).toBe(12);
  });

  it('reports partial when updateIndex returns partial', async () => {
    const summary = makeNeverRunSummary();
    summary.status = 'partial';
    summary.failure_count = 3;
    const result = await runner.runReindex({
      knowledgeBases: [],
      force: true,
      resolveKbs: async () => ['alpha'],
      runUpdateIndex: async () => summary,
    });
    expect(result.outcome).toBe('partial');
    expect(result.reason).not.toBeNull();
  });

  it('reports failed when updateIndex throws', async () => {
    const result = await runner.runReindex({
      knowledgeBases: [],
      force: true,
      resolveKbs: async () => ['alpha'],
      runUpdateIndex: async () => {
        throw new Error('embedding provider unreachable');
      },
    });
    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/embedding provider unreachable/);
  });
});
