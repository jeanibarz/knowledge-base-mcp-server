import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  REFRESH_PREFLIGHT_BYTE_THRESHOLD,
  REFRESH_PREFLIGHT_FILE_THRESHOLD,
  buildAgeBudgetFooter,
  buildEmptyResultGuidance,
  buildRefreshPreflightEstimate,
  formatRefreshPreflightEstimate,
  maybeWriteRefreshPreflight,
} from './cli-search-staleness.js';
import { writeFreshnessManifest } from './freshness-manifest.js';

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
        scan: {
          scope: 'scoped',
          source: 'filesystem',
          filesScanned: 2,
          globalFiles: 3,
          scopedFiles: 2,
          kbsScanned: 2,
        },
      });

      await expect(computeStaleness(modelId)).resolves.toMatchObject({
        modifiedFiles: 2,
        newFiles: 2,
        scan: {
          scope: 'global',
          source: 'filesystem',
          filesScanned: 3,
          globalFiles: 3,
          kbsScanned: 2,
        },
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('uses a valid freshness manifest without walking the KB tree', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-search-manifest-'));
    try {
      const kbRoot = path.join(tempDir, 'kbs');
      const faissDir = path.join(tempDir, '.faiss');
      const modelId = 'ollama__manifest-stale-test';
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

      const alphaModified = path.join(kbRoot, 'alpha', 'modified.md');
      const betaNew = path.join(kbRoot, 'beta', 'new.md');
      await fsp.mkdir(path.dirname(alphaModified), { recursive: true });
      await fsp.mkdir(path.dirname(betaNew), { recursive: true });
      await fsp.writeFile(alphaModified, '# Alpha modified\n', 'utf-8');
      await fsp.writeFile(betaNew, '# Beta new\n', 'utf-8');

      const indexTime = new Date('2026-05-03T15:30:00.000Z');
      const afterIndex = new Date('2026-05-03T16:00:00.000Z');
      await fsp.utimes(indexBinaryPath, indexTime, indexTime);
      await fsp.utimes(alphaModified, afterIndex, afterIndex);
      await fsp.utimes(betaNew, indexTime, indexTime);

      await writeFreshnessManifest({
        modelId,
        modelDir: path.join(faissDir, 'models', modelId),
        kbRootDir: kbRoot,
        indexMtimeMs: indexTime.getTime(),
      });
      await fsp.rm(kbRoot, { recursive: true, force: true });

      jest.resetModules();
      const { computeStaleness } = await import('./cli-search.js');
      await expect(computeStaleness(modelId, 'alpha')).resolves.toMatchObject({
        modifiedFiles: 1,
        newFiles: 1,
        scope: { kb: 'alpha', modifiedFiles: 1, newFiles: 1 },
        global: { modifiedFiles: 1, newFiles: 2 },
        scan: {
          scope: 'scoped',
          source: 'manifest',
          filesScanned: 1,
          globalFiles: 2,
          scopedFiles: 1,
          kbsScanned: 1,
        },
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('refresh preflight estimate (issue #318)', () => {
  it('does not print below the documented stale-delta thresholds', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-refresh-preflight-small-'));
    try {
      const kbRoot = path.join(tempDir, 'kbs');
      const alpha = path.join(kbRoot, 'alpha');
      await fsp.mkdir(path.join(alpha, '.index'), { recursive: true });
      const doc = path.join(alpha, 'small.md');
      await fsp.writeFile(doc, 'small\n', 'utf-8');
      await fsp.writeFile(path.join(alpha, '.index', 'small.md'), 'old-hash', 'utf-8');
      const indexMtimeMs = Date.parse('2026-05-12T10:00:00.000Z');
      await fsp.utimes(doc, new Date(indexMtimeMs + 60_000), new Date(indexMtimeMs + 60_000));

      const estimate = await buildRefreshPreflightEstimate({
        kbRootDir: kbRoot,
        indexMtimeMs,
        scopedKb: undefined,
        activeModel: {
          modelId: 'ollama__nomic-embed-text-latest',
          provider: 'ollama',
          modelName: 'nomic-embed-text:latest',
        },
      });
      const writes: string[] = [];

      expect(estimate).toMatchObject({
        totalModifiedFiles: 1,
        totalNewFiles: 0,
      });
      expect(maybeWriteRefreshPreflight(estimate, { write: (text) => writes.push(text) })).toBe(false);
      expect(writes).toEqual([]);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('prints a large stale-delta estimate with by-KB counts, bytes, model, provider class, and scoped suggestions', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-refresh-preflight-large-'));
    try {
      const kbRoot = path.join(tempDir, 'kbs');
      const alpha = path.join(kbRoot, 'alpha');
      const beta = path.join(kbRoot, 'beta');
      await fsp.mkdir(path.join(alpha, '.index'), { recursive: true });
      await fsp.mkdir(beta, { recursive: true });

      const alphaModified = path.join(alpha, 'modified.md');
      const alphaLarge = path.join(alpha, 'new.md');
      const betaNew = path.join(beta, 'new.md');
      await fsp.writeFile(alphaModified, 'x'.repeat(64), 'utf-8');
      await fsp.writeFile(alphaLarge, 'p'.repeat(REFRESH_PREFLIGHT_BYTE_THRESHOLD + 1), 'utf-8');
      await fsp.writeFile(betaNew, 'b'.repeat(32), 'utf-8');
      await fsp.writeFile(path.join(alpha, '.index', 'modified.md'), 'old-hash', 'utf-8');
      const indexMtimeMs = Date.parse('2026-05-12T10:00:00.000Z');
      await fsp.utimes(alphaModified, new Date(indexMtimeMs + 60_000), new Date(indexMtimeMs + 60_000));

      const estimate = await buildRefreshPreflightEstimate({
        kbRootDir: kbRoot,
        indexMtimeMs,
        activeModel: {
          modelId: 'openai__text-embedding-3-small',
          provider: 'openai',
          modelName: 'text-embedding-3-small',
        },
      });
      const text = formatRefreshPreflightEstimate(estimate);

      expect(estimate.exceedsThreshold).toBe(true);
      expect(text).toContain(`thresholds: ${REFRESH_PREFLIGHT_FILE_THRESHOLD} files or 100 MiB`);
      expect(text).toContain('Active model: openai__text-embedding-3-small');
      expect(text).toContain('provider=openai');
      expect(text).toContain('provider_class=paid');
      expect(text).toContain('Estimated chunks: unknown until extraction');
      expect(text).toContain('- alpha: 1 modified, 1 new');
      expect(text).toContain('- beta: 0 modified, 1 new');
      expect(text).toContain('Top stale KBs:');
      expect(text).toContain('kb search "<query>" --refresh --kb=alpha');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('scopes estimates to --kb and does not suggest narrowing to another KB', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-refresh-preflight-scoped-'));
    try {
      const kbRoot = path.join(tempDir, 'kbs');
      const alpha = path.join(kbRoot, 'alpha');
      const beta = path.join(kbRoot, 'beta');
      await fsp.mkdir(alpha, { recursive: true });
      await fsp.mkdir(beta, { recursive: true });
      for (let i = 0; i < REFRESH_PREFLIGHT_FILE_THRESHOLD + 1; i += 1) {
        await fsp.writeFile(path.join(alpha, `alpha-${i}.md`), 'alpha\n', 'utf-8');
        await fsp.writeFile(path.join(beta, `beta-${i}.md`), 'beta\n', 'utf-8');
      }

      const estimate = await buildRefreshPreflightEstimate({
        kbRootDir: kbRoot,
        indexMtimeMs: null,
        scopedKb: 'alpha',
        activeModel: {
          modelId: 'ollama__nomic-embed-text-latest',
          provider: 'ollama',
          modelName: 'nomic-embed-text:latest',
        },
      });
      const text = formatRefreshPreflightEstimate(estimate);

      expect(estimate.totalNewFiles).toBe(REFRESH_PREFLIGHT_FILE_THRESHOLD + 1);
      expect(estimate.kbs).toHaveLength(1);
      expect(estimate.kbs[0].kb).toBe('alpha');
      expect(text).toContain('Scope: --kb=alpha');
      expect(text).toContain('provider_class=local');
      expect(text).toContain('Already scoped to `--kb=alpha`');
      expect(text).not.toContain('--kb=beta');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('writes preflight text to stderr even for JSON output mode', async () => {
    const estimate = {
      activeModel: {
        modelId: 'ollama__nomic-embed-text-latest',
        provider: 'ollama',
        modelName: 'nomic-embed-text:latest',
        providerClass: 'local' as const,
      },
      scopedKb: undefined,
      thresholdFiles: REFRESH_PREFLIGHT_FILE_THRESHOLD,
      thresholdBytes: REFRESH_PREFLIGHT_BYTE_THRESHOLD,
      exceedsThreshold: true,
      totalModifiedFiles: 0,
      totalNewFiles: REFRESH_PREFLIGHT_FILE_THRESHOLD + 1,
      totalStaleFiles: REFRESH_PREFLIGHT_FILE_THRESHOLD + 1,
      estimatedBytes: 1,
      estimatedChunks: null,
      stalePdfFiles: 0,
      kbs: [{
        kb: 'alpha',
        modifiedFiles: 0,
        newFiles: REFRESH_PREFLIGHT_FILE_THRESHOLD + 1,
        staleFiles: REFRESH_PREFLIGHT_FILE_THRESHOLD + 1,
        estimatedBytes: 1,
        stalePdfFiles: 0,
      }],
      topKbs: [{
        kb: 'alpha',
        modifiedFiles: 0,
        newFiles: REFRESH_PREFLIGHT_FILE_THRESHOLD + 1,
        staleFiles: REFRESH_PREFLIGHT_FILE_THRESHOLD + 1,
        estimatedBytes: 1,
        stalePdfFiles: 0,
      }],
    };
    const stderr: string[] = [];
    const stdout: string[] = [];

    expect(maybeWriteRefreshPreflight(estimate, {
      format: 'json',
      write: (text) => stderr.push(text),
    })).toBe(true);
    stdout.push(JSON.stringify({ results: [] }));

    expect(stderr.join('')).toContain('kb search refresh preflight');
    expect(JSON.parse(stdout.join(''))).toEqual({ results: [] });
  });
});

describe('buildEmptyResultGuidance (issue #335)', () => {
  const MTIME = '2026-05-13T15:30:00.000Z';

  it('returns null markdown and null JSON when freshness was skipped (--no-freshness)', () => {
    const result = buildEmptyResultGuidance({
      query: 'rollback procedure',
      scopedKb: undefined,
      refreshed: false,
      staleness: null,
    });
    expect(result.markdown).toBeNull();
    expect(result.json).toBeNull();
  });

  it('returns null markdown when global scope is fresh (no inline guidance to add)', () => {
    const result = buildEmptyResultGuidance({
      query: 'rollback procedure',
      scopedKb: undefined,
      refreshed: false,
      staleness: {
        indexMtime: MTIME,
        scoped: { modifiedFiles: 0, newFiles: 0 },
        global: null,
      },
    });
    expect(result.markdown).toBeNull();
    expect(result.json).toMatchObject({
      refresh_command: 'kb search "rollback procedure" --refresh',
      scope: 'global',
      index_mtime: MTIME,
      index_built: true,
      refreshed: false,
      scoped_stale: false,
      global_stale: false,
    });
    expect(result.json).not.toHaveProperty('scope_kb');
  });

  it('emits an inline tip when the unscoped global index is stale', () => {
    const result = buildEmptyResultGuidance({
      query: 'rollback procedure',
      scopedKb: undefined,
      refreshed: false,
      staleness: {
        indexMtime: MTIME,
        scoped: { modifiedFiles: 3, newFiles: 1 },
        global: null,
      },
    });
    expect(result.markdown).toBe(
      `> **Tip:** No results found, and the index is stale ` +
        `(3 modified, 1 new file(s) since ${MTIME}). ` +
        'Try `kb search "rollback procedure" --refresh` to update the index and re-run.',
    );
    expect(result.json).toMatchObject({
      refresh_command: 'kb search "rollback procedure" --refresh',
      scope: 'global',
      scoped_stale: true,
      scoped_modified_files: 3,
      scoped_new_files: 1,
      global_stale: true,
      global_modified_files: 3,
      global_new_files: 1,
    });
  });

  it('emits a scoped tip with the --kb=<name> refresh command when the scoped KB is stale', () => {
    const result = buildEmptyResultGuidance({
      query: 'auth flow',
      scopedKb: 'work',
      refreshed: false,
      staleness: {
        indexMtime: MTIME,
        scoped: { modifiedFiles: 2, newFiles: 5 },
        global: { modifiedFiles: 4, newFiles: 7 },
      },
    });
    expect(result.markdown).toBe(
      `> **Tip:** No results found, and the "work" KB scope is stale ` +
        `(2 modified, 5 new file(s) since ${MTIME}). ` +
        'Try `kb search "auth flow" --kb=work --refresh` to update the index and re-run.',
    );
    expect(result.json).toMatchObject({
      refresh_command: 'kb search "auth flow" --kb=work --refresh',
      scope: 'scoped',
      scope_kb: 'work',
      scoped_stale: true,
      scoped_modified_files: 2,
      scoped_new_files: 5,
      global_stale: true,
      global_modified_files: 4,
      global_new_files: 7,
    });
  });

  it('points to the global index when the scoped KB is fresh but global drift exists', () => {
    const result = buildEmptyResultGuidance({
      query: 'auth flow',
      scopedKb: 'work',
      refreshed: false,
      staleness: {
        indexMtime: MTIME,
        scoped: { modifiedFiles: 0, newFiles: 0 },
        global: { modifiedFiles: 4, newFiles: 7 },
      },
    });
    expect(result.markdown).not.toBeNull();
    expect(result.markdown).toContain('"work" KB scope is up-to-date');
    expect(result.markdown).toContain('drop `--kb=work`');
    expect(result.markdown).toContain('`kb search "auth flow" --refresh`');
    expect(result.json).toMatchObject({
      scope: 'scoped',
      scope_kb: 'work',
      scoped_stale: false,
      global_stale: true,
    });
  });

  it('returns null markdown when the scoped KB is fresh and global is fresh', () => {
    const result = buildEmptyResultGuidance({
      query: 'auth flow',
      scopedKb: 'work',
      refreshed: false,
      staleness: {
        indexMtime: MTIME,
        scoped: { modifiedFiles: 0, newFiles: 0 },
        global: { modifiedFiles: 0, newFiles: 0 },
      },
    });
    expect(result.markdown).toBeNull();
    expect(result.json).toMatchObject({
      scope: 'scoped',
      scope_kb: 'work',
      scoped_stale: false,
      global_stale: false,
    });
  });

  it('returns null markdown when the run already refreshed the index', () => {
    const result = buildEmptyResultGuidance({
      query: 'auth flow',
      scopedKb: 'work',
      refreshed: true,
      staleness: {
        indexMtime: MTIME,
        scoped: { modifiedFiles: 0, newFiles: 0 },
        global: { modifiedFiles: 0, newFiles: 0 },
      },
    });
    expect(result.markdown).toBeNull();
    expect(result.json).toMatchObject({ refreshed: true });
  });

  it('suggests creating the index when it has never been built', () => {
    const result = buildEmptyResultGuidance({
      query: 'rollback procedure',
      scopedKb: undefined,
      refreshed: false,
      staleness: {
        indexMtime: null,
        scoped: { modifiedFiles: 0, newFiles: 0 },
        global: null,
      },
    });
    expect(result.markdown).toBe(
      '> **Tip:** No results found, and the index has not been built yet. ' +
        'Run `kb search "rollback procedure" --refresh` to create it, then re-run the query.',
    );
    expect(result.json).toMatchObject({
      index_built: false,
      index_mtime: null,
    });
  });

  it('escapes embedded quotes in the refresh command so the suggestion stays copy-pasteable', () => {
    const result = buildEmptyResultGuidance({
      query: 'error "oops" $HOME',
      scopedKb: undefined,
      refreshed: false,
      staleness: {
        indexMtime: MTIME,
        scoped: { modifiedFiles: 1, newFiles: 0 },
        global: null,
      },
    });
    expect(result.json?.refresh_command).toBe(
      'kb search "error \\"oops\\" \\$HOME" --refresh',
    );
    expect(result.markdown).toContain('kb search "error \\"oops\\" \\$HOME" --refresh');
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
