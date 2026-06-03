import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  applyExtractionCachePrune,
  planExtractionCachePrune,
} from './extraction-cache.js';
import {
  parseCacheArgs,
  runCache,
} from './cli-cache.js';

describe('kb cache extracted-text', () => {
  async function withTempCache<T>(fn: (cacheDir: string) => Promise<T>): Promise<T> {
    const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cli-cache-'));
    try {
      return await fn(cacheDir);
    } finally {
      await fsp.rm(cacheDir, { recursive: true, force: true });
    }
  }

  async function writeEntry(cacheDir: string, keyChar: string, body: string, mtime: Date): Promise<string> {
    const filename = `${keyChar.repeat(64)}.txt`;
    const filePath = path.join(cacheDir, filename);
    await fsp.writeFile(filePath, body);
    await fsp.utimes(filePath, mtime, mtime);
    return filename;
  }

  function captureDeps() {
    let stdout = '';
    let stderr = '';
    return {
      deps: {
        planExtractionCachePrune,
        applyExtractionCachePrune,
        stdout: (text: string) => { stdout += text; },
        stderr: (text: string) => { stderr += text; },
      },
      read: () => ({ stdout, stderr }),
    };
  }

  it('parses dry-run size and age limits', () => {
    expect(parseCacheArgs([
      'extracted-text',
      '--max-age-days=30',
      '--max-size-mb=1.5',
      '--dry-run',
      '--format=json',
      '--cache-dir=/tmp/cache',
    ])).toMatchObject({
      surface: 'extracted-text',
      cacheDir: '/tmp/cache',
      maxAgeDays: 30,
      maxSizeMb: 1.5,
      maxSizeBytes: 1.5 * 1024 * 1024,
      dryRun: true,
      format: 'json',
    });
  });

  it('rejects apply mode without an explicit pruning limit', () => {
    expect(() => parseCacheArgs(['extracted-text', '--yes'])).toThrow(
      '--yes requires --max-age-days or --max-size-mb',
    );
  });

  it('prints a dry-run JSON plan without deleting entries', async () => {
    await withTempCache(async (cacheDir) => {
      const oldName = await writeEntry(cacheDir, 'a', 'old body', new Date('2026-01-01T00:00:00.000Z'));
      const { deps, read } = captureDeps();

      const code = await runCache([
        'extracted-text',
        `--cache-dir=${cacheDir}`,
        '--max-age-days=1',
        '--format=json',
      ], deps);

      expect(code).toBe(0);
      expect(read().stderr).toBe('');
      const payload = JSON.parse(read().stdout) as {
        dry_run: boolean;
        prunable_entries: Array<{ filename: string; reasons: string[] }>;
      };
      expect(payload.dry_run).toBe(true);
      expect(payload.prunable_entries).toEqual([
        expect.objectContaining({ filename: oldName, reasons: ['age'] }),
      ]);
      await expect(fsp.stat(path.join(cacheDir, oldName))).resolves.toBeDefined();
    });
  });

  it('applies deletion only when --yes is supplied', async () => {
    await withTempCache(async (cacheDir) => {
      const oldName = await writeEntry(cacheDir, 'a', 'old body', new Date('2026-01-01T00:00:00.000Z'));
      const freshName = await writeEntry(cacheDir, 'b', 'fresh body', new Date());
      const { deps, read } = captureDeps();

      const code = await runCache([
        'extracted-text',
        `--cache-dir=${cacheDir}`,
        '--max-age-days=1',
        '--yes',
        '--format=json',
      ], deps);

      expect(code).toBe(0);
      expect(read().stderr).toBe('');
      const payload = JSON.parse(read().stdout) as {
        dry_run: boolean;
        summary: { deleted_count: number; deleted_bytes: number; failed_count: number };
      };
      expect(payload.dry_run).toBe(false);
      expect(payload.summary).toEqual({ deleted_count: 1, deleted_bytes: Buffer.byteLength('old body'), failed_count: 0 });
      await expect(fsp.stat(path.join(cacheDir, oldName))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fsp.stat(path.join(cacheDir, freshName))).resolves.toBeDefined();
    });
  });
});
