// Issue #406 — `kb reindex --kb` is a guard/estimator hint, not a scoped
// forced backfill. These tests pin the help text so it cannot drift back
// to the earlier wording that implied `--kb` limits which vectors are
// rebuilt.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { REINDEX_HELP } from './cli-reindex.js';

describe('REINDEX_HELP — --kb scope accuracy (issue #406)', () => {
  it('does not claim --kb limits or scopes the rebuild', () => {
    // The pre-#406 wording was "Limit reindex to this KB" / "Reindex
    // only this KB" — both overstate what --kb does.
    expect(REINDEX_HELP).not.toMatch(/Limit reindex to this KB/i);
    expect(REINDEX_HELP).not.toMatch(/Reindex only this KB/i);
  });

  it('describes --kb as a guard/estimator hint, not a scoped rebuild', () => {
    expect(REINDEX_HELP).toMatch(/--kb/);
    expect(REINDEX_HELP).toMatch(/guard\/estimator hint/i);
    expect(REINDEX_HELP).toMatch(/NOT a scoped\s+rebuild/i);
  });

  it('states cold backfills are global and warm follow-up runs are incremental', () => {
    expect(REINDEX_HELP).toMatch(/cold backfills.*global/is);
    expect(REINDEX_HELP).toMatch(/full active FAISS\s+index/i);
    expect(REINDEX_HELP).toMatch(/warm follow-up runs.*incremental/is);
  });
});

// Issue #645 — disk-space preflight guard. The CLI must document and honor
// exit code 5 (preflight refused before any write).
describe('REINDEX_HELP — disk-space preflight exit code (issue #645)', () => {
  it('documents exit code 5 for the disk-space preflight', () => {
    expect(REINDEX_HELP).toMatch(/^\s*5\s+disk-space preflight/m);
    expect(REINDEX_HELP).toMatch(/KB_MIN_FREE_DISK_BYTES/);
  });
});

describe('runReindexCli — disk-space preflight (issue #645)', () => {
  const savedEnv = {
    FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
    KB_MIN_FREE_DISK_BYTES: process.env.KB_MIN_FREE_DISK_BYTES,
    KB_CONTEXTUAL_RETRIEVAL: process.env.KB_CONTEXTUAL_RETRIEVAL,
  };
  let dir: string;
  let stderr: string;
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-reindex-preflight-'));
    stderr = '';
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stderr.write = originalStderrWrite;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.resetModules();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('returns exit code 5 and writes a "need ~X, have Y" message when space is short', async () => {
    // Point the index at a real (existing) dir so statfs succeeds, and set
    // an impossible margin so the preflight always refuses. No write occurs.
    process.env.FAISS_INDEX_PATH = dir;
    process.env.KB_MIN_FREE_DISK_BYTES = String(Number.MAX_SAFE_INTEGER);
    process.env.KB_CONTEXTUAL_RETRIEVAL = 'on';
    jest.resetModules();
    const { runReindexCli } = await import('./cli-reindex.js');

    const code = await runReindexCli(['--with-context']);
    expect(code).toBe(5);
    expect(stderr).toMatch(/kb reindex: Insufficient disk space/);
    expect(stderr).toMatch(/need ~/);
    expect(stderr).toMatch(/have .* free/);
  });
});
