import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { buildAgeBudgetFooter } from './cli-search-staleness.js';

const ORIGINAL_ENV = {
  KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
  FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
};

afterEach(async () => {
  if (ORIGINAL_ENV.KNOWLEDGE_BASES_ROOT_DIR === undefined) {
    delete process.env.KNOWLEDGE_BASES_ROOT_DIR;
  } else {
    process.env.KNOWLEDGE_BASES_ROOT_DIR = ORIGINAL_ENV.KNOWLEDGE_BASES_ROOT_DIR;
  }
  if (ORIGINAL_ENV.FAISS_INDEX_PATH === undefined) {
    delete process.env.FAISS_INDEX_PATH;
  } else {
    process.env.FAISS_INDEX_PATH = ORIGINAL_ENV.FAISS_INDEX_PATH;
  }
  jest.resetModules();
});

describe('computeStaleness', () => {
  it('counts scoped stale files separately from other KBs and preserves global counts', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-search-stale-'));
    try {
      const kbRoot = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const modelId = 'ollama__scoped-stale-test';
      process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
      process.env.FAISS_INDEX_PATH = faissDir;

      const indexBinaryPath = path.join(
        faissDir,
        'models',
        modelId,
        'faiss.index',
        'faiss.index',
      );
      await fsp.mkdir(path.dirname(indexBinaryPath), { recursive: true });
      await fsp.writeFile(indexBinaryPath, 'index', 'utf-8');

      const alphaFresh = path.join(kbRoot, 'alpha', 'fresh.md');
      const alphaModified = path.join(kbRoot, 'alpha', 'modified.md');
      const betaModified = path.join(kbRoot, 'beta', 'modified.md');
      await fsp.mkdir(path.dirname(alphaFresh), { recursive: true });
      await fsp.mkdir(path.dirname(betaModified), { recursive: true });
      await fsp.writeFile(alphaFresh, '# Alpha fresh\n', 'utf-8');
      await fsp.writeFile(alphaModified, '# Alpha modified\n', 'utf-8');
      await fsp.writeFile(betaModified, '# Beta modified\n', 'utf-8');

      await fsp.mkdir(path.join(kbRoot, 'alpha', '.index'), { recursive: true });
      await fsp.writeFile(path.join(kbRoot, 'alpha', '.index', 'fresh.hash'), 'hash', 'utf-8');

      const beforeIndex = new Date('2026-05-03T15:00:00.000Z');
      const indexTime = new Date('2026-05-03T15:30:00.000Z');
      const afterIndex = new Date('2026-05-03T16:00:00.000Z');
      await fsp.utimes(indexBinaryPath, indexTime, indexTime);
      await fsp.utimes(alphaFresh, beforeIndex, beforeIndex);
      await fsp.utimes(alphaModified, afterIndex, afterIndex);
      await fsp.utimes(betaModified, afterIndex, afterIndex);

      jest.resetModules();
      const { computeStaleness } = await import('./cli-search.js');

      await expect(computeStaleness(modelId, 'alpha')).resolves.toMatchObject({
        modifiedFiles: 1,
        newFiles: 1,
        scope: { kb: 'alpha', modifiedFiles: 1, newFiles: 1 },
        global: { modifiedFiles: 2, newFiles: 2 },
      });

      await expect(computeStaleness(modelId)).resolves.toMatchObject({
        modifiedFiles: 2,
        newFiles: 2,
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('buildAgeBudgetFooter (issue #218)', () => {
  const nowMs = Date.parse('2026-05-11T12:00:00.000Z');

  it('returns line=null when no age budget is configured', () => {
    const result = buildAgeBudgetFooter({
      kb: 'work',
      lastIndexAtMs: nowMs - 100 * 3_600_000,
      nowMs,
      env: {},
    });
    expect(result.line).toBeNull();
    expect(result.status.breach).toBe(false);
    expect(result.configError).toBeNull();
  });

  it('returns line=null when the KB is within budget', () => {
    const result = buildAgeBudgetFooter({
      kb: 'work',
      lastIndexAtMs: nowMs - 12 * 3_600_000,
      nowMs,
      env: { KB_AGE_BUDGET_HOURS_WORK: '24' },
    });
    expect(result.line).toBeNull();
    expect(result.status.breach).toBe(false);
  });

  it('returns the spec-exact footer line on breach (47h vs 24h)', () => {
    const result = buildAgeBudgetFooter({
      kb: 'work',
      lastIndexAtMs: nowMs - 47 * 3_600_000,
      nowMs,
      env: { KB_AGE_BUDGET_HOURS_WORK: '24' },
    });
    expect(result.status.breach).toBe(true);
    expect(result.line).toBe(
      '> _Served from index aged 47h, budget 24h. Run `kb search --refresh` to update._',
    );
  });

  it('uses the global KB_AGE_BUDGET_HOURS fallback when no per-KB override is set', () => {
    const result = buildAgeBudgetFooter({
      kb: 'work',
      lastIndexAtMs: nowMs - 100 * 3_600_000,
      nowMs,
      env: { KB_AGE_BUDGET_HOURS: '24' },
    });
    expect(result.status.breach).toBe(true);
    expect(result.line).toContain('aged 100h, budget 24h');
  });

  it('returns line=null when the KB has never been indexed (lastIndexAtMs=null)', () => {
    const result = buildAgeBudgetFooter({
      kb: 'work',
      lastIndexAtMs: null,
      nowMs,
      env: { KB_AGE_BUDGET_HOURS_WORK: '24' },
    });
    expect(result.line).toBeNull();
    expect(result.status.currentAgeHours).toBeNull();
    expect(result.status.breach).toBe(false);
  });

  it('surfaces a config-error footer when the per-KB env value is malformed', () => {
    const result = buildAgeBudgetFooter({
      kb: 'work',
      lastIndexAtMs: nowMs - 50 * 3_600_000,
      nowMs,
      env: { KB_AGE_BUDGET_HOURS_WORK: '0' },
    });
    expect(result.configError).not.toBeNull();
    expect(result.configError?.envVar).toBe('KB_AGE_BUDGET_HOURS_WORK');
    expect(result.line).toContain('Age-budget config error');
    expect(result.line).toContain('KB_AGE_BUDGET_HOURS_WORK="0"');
    expect(result.status.configuredHours).toBeNull();
    expect(result.status.breach).toBe(false);
  });

  it('uses the normalised env-suffix for KB names with dashes', () => {
    const result = buildAgeBudgetFooter({
      kb: 'rfcs-archived',
      lastIndexAtMs: nowMs - 100 * 3_600_000,
      nowMs,
      env: { KB_AGE_BUDGET_HOURS_RFCS_ARCHIVED: '24' },
    });
    expect(result.status.breach).toBe(true);
    expect(result.line).toContain('aged 100h, budget 24h');
  });
});
