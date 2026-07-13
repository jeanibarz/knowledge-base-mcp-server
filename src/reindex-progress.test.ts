// RFC 017 #407 — unit tests for src/reindex-progress.ts.
//
// Each test isolates FAISS_INDEX_PATH + KNOWLEDGE_BASES_ROOT_DIR under a
// fresh temp dir and re-imports the module so its config/paths snapshot
// picks up the per-test value. No embedding provider or LLM runs — the
// progress ledger is derived purely from on-disk sidecars + manifests.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

type ProgressModule = typeof import('./reindex-progress.js');

let tempDir: string;
let faissDir: string;
let kbsDir: string;
let savedEnv: Record<string, string | undefined>;
let progress: ProgressModule;

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

interface ChunkSpec {
  preface: string | null;
  error_code?: string;
}

/** Write a contextual-preface sidecar for `<kb>/<basename>`. */
async function writeSidecar(
  kb: string,
  basename: string,
  chunks: ChunkSpec[],
): Promise<void> {
  const source = path.join(kbsDir, kb, basename);
  await fsp.mkdir(path.dirname(source), { recursive: true });
  await fsp.writeFile(source, '# public source\n');
  const dir = path.join(faissDir, '.contextual-prefaces', kb);
  await fsp.mkdir(dir, { recursive: true });
  const flat = source.replace(/^\/+/, '').replace(/\//g, '__SEP__');
  const payload = {
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
      ...(c.error_code !== undefined
        ? { error_code: c.error_code, next_retry_after: '2099-01-01T00:00:00.000Z' }
        : {}),
    })),
  };
  await fsp.writeFile(path.join(dir, `${flat}.json`), JSON.stringify(payload, null, 2));
}

/** Write `count` chunk manifests under `<kb>/.index/` (the file denominator). */
async function writeManifests(kb: string, count: number): Promise<void> {
  const indexDir = path.join(kbsDir, kb, '.index');
  await fsp.mkdir(indexDir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    await fsp.writeFile(path.join(kbsDir, kb, `file-${i}`), '# public source\n');
    await fsp.writeFile(
      path.join(indexDir, `file-${i}.chunks.json`),
      JSON.stringify({ chunks: [{}] }),
    );
  }
}

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-reindex-progress-'));
  faissDir = path.join(tempDir, 'faiss');
  kbsDir = path.join(tempDir, 'kbs');
  savedEnv = {
    FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
    KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
  };
  setEnv('FAISS_INDEX_PATH', faissDir);
  setEnv('KNOWLEDGE_BASES_ROOT_DIR', kbsDir);
  jest.resetModules();
  progress = (await import('./reindex-progress.js')) as ProgressModule;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) setEnv(key, value);
  await fsp.rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// computeReindexProgress — sidecar rollup
// ---------------------------------------------------------------------------

describe('computeReindexProgress', () => {
  it('returns an empty report when no sidecars exist', async () => {
    const result = await progress.computeReindexProgress();
    expect(result.schema_version).toBe('reindex-progress.v1');
    expect(result.kbs).toEqual([]);
    expect(result.totals.knowledge_bases).toBe(0);
    expect(result.totals.chunks_resolved).toBe(0);
    expect(result.run_active).toBe(false);
    expect(result.run).toBeNull();
  });

  it('classifies a fully-resolved sidecar as complete', async () => {
    await writeSidecar('alpha', 'done.md', [
      { preface: 'ctx 0' },
      { preface: 'ctx 1' },
    ]);
    const result = await progress.computeReindexProgress();
    expect(result.kbs).toHaveLength(1);
    const kb = result.kbs[0];
    expect(kb.knowledge_base).toBe('alpha');
    expect(kb.files_complete).toBe(1);
    expect(kb.files_incomplete).toBe(0);
    expect(kb.files[0].status).toBe('complete');
    expect(kb.chunks_resolved).toBe(2);
    expect(kb.chunks_failed).toBe(0);
  });

  it('classifies a sidecar with a failed chunk as incomplete and surfaces error codes', async () => {
    await writeSidecar('alpha', 'partial.md', [
      { preface: 'ctx 0' },
      { preface: null, error_code: 'llm_unreachable' },
    ]);
    const result = await progress.computeReindexProgress();
    const file = result.kbs[0].files[0];
    expect(file.status).toBe('incomplete');
    expect(file.chunks_resolved).toBe(1);
    expect(file.chunks_failed).toBe(1);
    expect(file.error_codes).toEqual(['llm_unreachable']);
  });

  it('derives files_pending from chunk manifests minus sidecar-covered files', async () => {
    await writeSidecar('alpha', 'a.md', [{ preface: 'ctx' }]);
    await writeSidecar('alpha', 'b.md', [{ preface: 'ctx' }]);
    await writeManifests('alpha', 5);
    const kb = (await progress.computeReindexProgress()).kbs[0];
    expect(kb.files_indexed).toBe(5);
    expect(kb.files_with_sidecar).toBe(2);
    expect(kb.files_pending).toBe(3);
  });

  it('never reports negative files_pending when sidecars outnumber manifests', async () => {
    await writeSidecar('alpha', 'a.md', [{ preface: 'ctx' }]);
    await writeSidecar('alpha', 'b.md', [{ preface: 'ctx' }]);
    await writeManifests('alpha', 1);
    const kb = (await progress.computeReindexProgress()).kbs[0];
    expect(kb.files_pending).toBe(0);
  });

  it('does not count a protected source as pending contextual work', async () => {
    await writeSidecar('alpha', 'file-0', [{ preface: 'ctx' }]);
    await writeManifests('alpha', 2);
    const protectedSource = path.join(kbsDir, 'alpha', 'file-0');
    await fsp.writeFile(protectedSource, [
      '---',
      'kb_policy:',
      '  no_llm_context: true',
      '---',
      'private',
    ].join('\n'));

    const kb = (await progress.computeReindexProgress()).kbs[0];
    expect(kb.files_indexed).toBe(1);
    expect(kb.files_pending).toBe(1);
  });

  it('aggregates multiple KBs, sorted by name, into totals', async () => {
    await writeSidecar('zeta', 'z.md', [{ preface: 'ctx' }]);
    await writeSidecar('alpha', 'a.md', [
      { preface: 'ctx' },
      { preface: null, error_code: 'llm_malformed' },
    ]);
    const result = await progress.computeReindexProgress();
    expect(result.kbs.map((k) => k.knowledge_base)).toEqual(['alpha', 'zeta']);
    expect(result.totals.knowledge_bases).toBe(2);
    expect(result.totals.files_with_sidecar).toBe(2);
    expect(result.totals.files_complete).toBe(1);
    expect(result.totals.files_incomplete).toBe(1);
    expect(result.totals.chunks_resolved).toBe(2);
    expect(result.totals.chunks_failed).toBe(1);
  });

  it('restricts the report to the requested KBs', async () => {
    await writeSidecar('alpha', 'a.md', [{ preface: 'ctx' }]);
    await writeSidecar('beta', 'b.md', [{ preface: 'ctx' }]);
    const result = await progress.computeReindexProgress({ knowledgeBases: ['beta'] });
    expect(result.kbs.map((k) => k.knowledge_base)).toEqual(['beta']);
  });

  it('reports a requested KB with no sidecars as zero-count rather than omitting it', async () => {
    await writeSidecar('alpha', 'a.md', [{ preface: 'ctx' }]);
    const result = await progress.computeReindexProgress({ knowledgeBases: ['missing'] });
    expect(result.kbs).toHaveLength(1);
    expect(result.kbs[0]).toMatchObject({
      knowledge_base: 'missing',
      files_with_sidecar: 0,
      files_complete: 0,
    });
  });

  it('skips a corrupt sidecar instead of throwing', async () => {
    await writeSidecar('alpha', 'good.md', [{ preface: 'ctx' }]);
    const corruptDir = path.join(faissDir, '.contextual-prefaces', 'alpha');
    await fsp.writeFile(path.join(corruptDir, 'broken.json'), '{ not json');
    const result = await progress.computeReindexProgress();
    expect(result.kbs[0].files_with_sidecar).toBe(1);
    expect(result.kbs[0].files[0].source).toContain('good.md');
  });
});

// ---------------------------------------------------------------------------
// .reindex.run.json — run liveness
// ---------------------------------------------------------------------------

describe('computeReindexProgress — run state', () => {
  async function writeRunState(pid: number): Promise<void> {
    await fsp.mkdir(faissDir, { recursive: true });
    await fsp.writeFile(
      path.join(faissDir, '.reindex.run.json'),
      JSON.stringify({
        schema_version: 'reindex-run.v1',
        pid,
        started_at: '2026-05-19T11:00:00.000Z',
        kbs_in_scope: ['alpha'],
      }),
    );
  }

  it('reports run_active when .reindex.run.json names a live PID', async () => {
    await writeRunState(process.pid);
    const result = await progress.computeReindexProgress();
    expect(result.run_active).toBe(true);
    expect(result.run).toMatchObject({ pid: process.pid, kbs_in_scope: ['alpha'] });
  });

  it('reports run_active false after a dead-PID run file is zombie-cleaned', async () => {
    await writeRunState(4_294_967_295); // 2^32 - 1: far above any real PID
    const result = await progress.computeReindexProgress();
    expect(result.run_active).toBe(false);
    expect(result.run).toBeNull();
    await expect(
      fsp.access(path.join(faissDir, '.reindex.run.json')),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// writeReindexProgress / readReindexProgress
// ---------------------------------------------------------------------------

describe('writeReindexProgress / readReindexProgress', () => {
  it('round-trips a computed snapshot through the ledger file', async () => {
    await writeSidecar('alpha', 'a.md', [{ preface: 'ctx' }]);
    const computed = await progress.computeReindexProgress();
    await progress.writeReindexProgress(computed);

    const onDisk = await progress.readReindexProgress();
    expect(onDisk).toEqual(computed);
    // The ledger lives at the documented path and is plain JSON.
    const raw = await fsp.readFile(progress.reindexProgressFilePath(), 'utf-8');
    expect(JSON.parse(raw).schema_version).toBe('reindex-progress.v1');
  });

  it('returns null when no ledger has been written', async () => {
    expect(await progress.readReindexProgress()).toBeNull();
  });

  it('returns null for a corrupt ledger file', async () => {
    await fsp.mkdir(faissDir, { recursive: true });
    await fsp.writeFile(progress.reindexProgressFilePath(), '{ broken');
    expect(await progress.readReindexProgress()).toBeNull();
  });
});
