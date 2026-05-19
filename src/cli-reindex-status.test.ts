// RFC 017 #407 — unit tests for the `kb reindex status` subcommand
// (src/cli-reindex.ts). Each test isolates FAISS_INDEX_PATH +
// KNOWLEDGE_BASES_ROOT_DIR under a temp dir and re-imports the module.
// stdout / stderr are captured via the injectable deps seam.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

type CliReindexModule = typeof import('./cli-reindex.js');
type ProgressModule = typeof import('./reindex-progress.js');

let tempDir: string;
let faissDir: string;
let kbsDir: string;
let savedEnv: Record<string, string | undefined>;
let cli: CliReindexModule;

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function writeSidecar(
  kb: string,
  basename: string,
  chunks: Array<{ preface: string | null; error_code?: string }>,
): Promise<void> {
  const source = path.join(kbsDir, kb, basename);
  const dir = path.join(faissDir, '.contextual-prefaces', kb);
  await fsp.mkdir(dir, { recursive: true });
  const flat = source.replace(/^\/+/, '').replace(/\//g, '__SEP__');
  await fsp.writeFile(
    path.join(dir, `${flat}.json`),
    JSON.stringify({
      schema_version: 'contextual-preface.sidecar.v1',
      source,
      knowledge_base: kb,
      document_hash: `hash-${basename}`,
      generator: 'contextual-preface.v1',
      model: 'test-model',
      chunk_size: 1000,
      chunk_overlap: 100,
      chunks: chunks.map((c, i) => ({
        chunk_index: i,
        chunk_hash: `chunk-${i}`,
        preface: c.preface,
        ...(c.error_code !== undefined ? { error_code: c.error_code } : {}),
      })),
    }),
  );
}

interface Captured {
  out: string;
  err: string;
  deps: { stdout: (t: string) => void; stderr: (t: string) => void };
}

function capture(): Captured {
  const c: Captured = { out: '', err: '', deps: { stdout: () => {}, stderr: () => {} } };
  c.deps.stdout = (t) => {
    c.out += t;
  };
  c.deps.stderr = (t) => {
    c.err += t;
  };
  return c;
}

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-reindex-status-'));
  faissDir = path.join(tempDir, 'faiss');
  kbsDir = path.join(tempDir, 'kbs');
  savedEnv = {
    FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
    KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
  };
  setEnv('FAISS_INDEX_PATH', faissDir);
  setEnv('KNOWLEDGE_BASES_ROOT_DIR', kbsDir);
  jest.resetModules();
  cli = (await import('./cli-reindex.js')) as CliReindexModule;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) setEnv(key, value);
  await fsp.rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Argument handling + routing
// ---------------------------------------------------------------------------

describe('kb reindex status — argv', () => {
  it('rejects an unknown flag with exit code 2', async () => {
    const c = capture();
    const code = await cli.runReindexStatusCli(['--bogus'], c.deps);
    expect(code).toBe(2);
    expect(c.err).toMatch(/unknown option/);
  });

  it('rejects an invalid --format value with exit code 2', async () => {
    const c = capture();
    const code = await cli.runReindexStatusCli(['--format=yaml'], c.deps);
    expect(code).toBe(2);
    expect(c.err).toMatch(/invalid --format/);
  });

  it('routes `kb reindex status` through runReindexCli without needing --with-context', async () => {
    const code = await cli.runReindexCli(['status']);
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

describe('kb reindex status — reporting', () => {
  it('reports the empty case when no sidecars exist', async () => {
    const c = capture();
    const code = await cli.runReindexStatusCli([], c.deps);
    expect(code).toBe(0);
    expect(c.out).toMatch(/No contextual-preface sidecars found/);
    expect(c.out).toMatch(/Reindex run: not running/);
  });

  it('reports per-file completion and resume guidance after a partial run', async () => {
    await writeSidecar('alpha', 'done.md', [{ preface: 'ctx 0' }, { preface: 'ctx 1' }]);
    await writeSidecar('alpha', 'partial.md', [
      { preface: 'ctx 0' },
      { preface: null, error_code: 'llm_unreachable' },
    ]);
    const c = capture();
    const code = await cli.runReindexStatusCli([], c.deps);
    expect(code).toBe(0);
    expect(c.out).toMatch(/1 complete, 1 incomplete/);
    expect(c.out).toMatch(/partial\.md/);
    expect(c.out).toMatch(/errors: llm_unreachable/);
    expect(c.out).toMatch(/To resume, re-run `kb reindex --with-context`/);
  });

  it('emits a parseable JSON snapshot with --format=json', async () => {
    await writeSidecar('alpha', 'a.md', [{ preface: 'ctx' }]);
    const c = capture();
    const code = await cli.runReindexStatusCli(['--format=json'], c.deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(c.out) as { schema_version: string; kbs: unknown[] };
    expect(parsed.schema_version).toBe('reindex-progress.v1');
    expect(parsed.kbs).toHaveLength(1);
  });

  it('materializes the durable ledger to .reindex.progress.json', async () => {
    await writeSidecar('alpha', 'a.md', [{ preface: 'ctx' }]);
    const c = capture();
    await cli.runReindexStatusCli([], c.deps);
    const progress = (await import('./reindex-progress.js')) as ProgressModule;
    const raw = await fsp.readFile(progress.reindexProgressFilePath(), 'utf-8');
    expect(JSON.parse(raw).schema_version).toBe('reindex-progress.v1');
    expect(c.out).toMatch(/Ledger written to/);
  });

  it('filters the report to the requested KB', async () => {
    await writeSidecar('alpha', 'a.md', [{ preface: 'ctx' }]);
    await writeSidecar('beta', 'b.md', [{ preface: 'ctx' }]);
    const c = capture();
    await cli.runReindexStatusCli(['--kb=beta'], c.deps);
    expect(c.out).toMatch(/\bbeta\b/);
    expect(c.out).not.toMatch(/\balpha\b/);
  });
});

// ---------------------------------------------------------------------------
// formatReindexProgressMarkdown
// ---------------------------------------------------------------------------

describe('formatReindexProgressMarkdown', () => {
  const baseTotals = {
    knowledge_bases: 0,
    files_indexed: 0,
    files_with_sidecar: 0,
    files_complete: 0,
    files_incomplete: 0,
    files_pending: 0,
    chunks_resolved: 0,
    chunks_failed: 0,
  };

  it('shows a clean-state message when nothing is incomplete or pending', () => {
    const text = cli.formatReindexProgressMarkdown(
      {
        schema_version: 'reindex-progress.v1',
        computed_at: '2026-05-19T00:00:00.000Z',
        run_active: false,
        run: null,
        kbs: [
          {
            knowledge_base: 'alpha',
            files_indexed: 1,
            files_with_sidecar: 1,
            files_complete: 1,
            files_incomplete: 0,
            files_pending: 0,
            chunks_resolved: 3,
            chunks_failed: 0,
            files: [
              {
                source: '/kbs/alpha/a.md',
                status: 'complete',
                chunks_total: 3,
                chunks_resolved: 3,
                chunks_failed: 0,
                error_codes: [],
              },
            ],
          },
        ],
        totals: { ...baseTotals, knowledge_bases: 1, files_indexed: 1, files_with_sidecar: 1, files_complete: 1, chunks_resolved: 3 },
      },
      null,
    );
    expect(text).toMatch(/Every sidecar-covered file has a complete set/);
    expect(text).not.toMatch(/Ledger written to/);
  });

  it('reports an in-progress run with its PID and scope', () => {
    const text = cli.formatReindexProgressMarkdown(
      {
        schema_version: 'reindex-progress.v1',
        computed_at: '2026-05-19T00:00:00.000Z',
        run_active: true,
        run: { pid: 4321, started_at: '2026-05-19T11:00:00.000Z', kbs_in_scope: ['alpha'] },
        kbs: [],
        totals: baseTotals,
      },
      '/faiss/.reindex.progress.json',
    );
    expect(text).toMatch(/IN PROGRESS — PID 4321/);
    expect(text).toMatch(/scope: alpha/);
    expect(text).toMatch(/Ledger written to \/faiss\/\.reindex\.progress\.json/);
  });
});
