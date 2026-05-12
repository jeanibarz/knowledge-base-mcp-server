import { afterEach, describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  computeFreshnessManifestFilterHash,
  freshnessManifestPath,
  readFreshnessManifest,
  writeFreshnessManifest,
} from './freshness-manifest.js';

const TEMP_DIRS: string[] = [];

afterEach(async () => {
  await Promise.all(TEMP_DIRS.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe('freshness manifest', () => {
  it('persists per-KB stale counts beside the model index', async () => {
    const tempDir = await mkTempDir();
    const kbRoot = path.join(tempDir, 'kbs');
    const modelDir = path.join(tempDir, '.faiss', 'models', 'huggingface__test');
    const indexMtimeMs = Date.parse('2026-05-03T15:30:00.000Z');
    const beforeIndex = new Date('2026-05-03T15:00:00.000Z');
    const afterIndex = new Date('2026-05-03T16:00:00.000Z');

    const alphaFresh = path.join(kbRoot, 'alpha', 'fresh.md');
    const alphaModified = path.join(kbRoot, 'alpha', 'modified.md');
    const betaNew = path.join(kbRoot, 'beta', 'new.md');
    await fsp.mkdir(path.dirname(alphaFresh), { recursive: true });
    await fsp.mkdir(path.dirname(betaNew), { recursive: true });
    await fsp.writeFile(alphaFresh, '# fresh\n', 'utf-8');
    await fsp.writeFile(alphaModified, '# modified\n', 'utf-8');
    await fsp.writeFile(betaNew, '# beta\n', 'utf-8');
    await fsp.utimes(alphaFresh, beforeIndex, beforeIndex);
    await fsp.utimes(alphaModified, afterIndex, afterIndex);
    await fsp.utimes(betaNew, beforeIndex, beforeIndex);
    await fsp.mkdir(path.join(kbRoot, 'alpha', '.index'), { recursive: true });
    await fsp.writeFile(path.join(kbRoot, 'alpha', '.index', 'fresh.md'), 'hash', 'utf-8');

    const manifest = await writeFreshnessManifest({
      modelId: 'huggingface__test',
      modelDir,
      kbRootDir: kbRoot,
      indexMtimeMs,
      now: new Date('2026-05-03T16:30:00.000Z'),
    });

    expect(manifest.kbs.alpha).toEqual({
      file_count: 2,
      sidecar_count: 1,
      modified_files: 1,
      new_files: 1,
      last_scan_at: '2026-05-03T16:30:00.000Z',
    });
    expect(manifest.kbs.beta).toMatchObject({
      file_count: 1,
      sidecar_count: 0,
      modified_files: 0,
      new_files: 1,
    });
    await expect(fsp.stat(freshnessManifestPath(modelDir))).resolves.toMatchObject({
      isFile: expect.any(Function),
    });
  });

  it('invalidates when ingest-filter config changes', async () => {
    const tempDir = await mkTempDir();
    const kbRoot = path.join(tempDir, 'kbs');
    const modelDir = path.join(tempDir, '.faiss', 'models', 'huggingface__test');
    const docPath = path.join(kbRoot, 'alpha', 'doc.md');
    await fsp.mkdir(path.dirname(docPath), { recursive: true });
    await fsp.writeFile(docPath, '# doc\n', 'utf-8');

    await writeFreshnessManifest({
      modelId: 'huggingface__test',
      modelDir,
      kbRootDir: kbRoot,
      indexMtimeMs: 1000,
      filterConfig: { extraExtensions: [], excludePaths: [] },
    });

    await expect(readFreshnessManifest({
      modelId: 'huggingface__test',
      modelDir,
      kbRootDir: kbRoot,
      indexMtimeMs: 1000,
      filterConfig: { extraExtensions: ['.adoc'], excludePaths: [] },
    })).resolves.toBeNull();
  });

  it('invalidates when the requested model or index mtime changes', async () => {
    const tempDir = await mkTempDir();
    const kbRoot = path.join(tempDir, 'kbs');
    const modelDir = path.join(tempDir, '.faiss', 'models', 'huggingface__test');
    const docPath = path.join(kbRoot, 'alpha', 'doc.md');
    await fsp.mkdir(path.dirname(docPath), { recursive: true });
    await fsp.writeFile(docPath, '# doc\n', 'utf-8');

    await writeFreshnessManifest({
      modelId: 'huggingface__test',
      modelDir,
      kbRootDir: kbRoot,
      indexMtimeMs: 1000,
    });

    await expect(readFreshnessManifest({
      modelId: 'huggingface__other',
      modelDir,
      kbRootDir: kbRoot,
      indexMtimeMs: 1000,
    })).resolves.toBeNull();
    await expect(readFreshnessManifest({
      modelId: 'huggingface__test',
      modelDir,
      kbRootDir: kbRoot,
      indexMtimeMs: 2000,
    })).resolves.toBeNull();
  });

  it('hashes filter config deterministically', () => {
    expect(computeFreshnessManifestFilterHash({
      extraExtensions: ['.adoc'],
      excludePaths: ['drafts/**'],
    })).toBe(computeFreshnessManifestFilterHash({
      extraExtensions: ['.adoc'],
      excludePaths: ['drafts/**'],
    }));
    expect(computeFreshnessManifestFilterHash({
      extraExtensions: ['.mdx'],
      excludePaths: ['drafts/**'],
    })).not.toBe(computeFreshnessManifestFilterHash({
      extraExtensions: ['.adoc'],
      excludePaths: ['drafts/**'],
    }));
  });
});

async function mkTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-freshness-manifest-'));
  TEMP_DIRS.push(dir);
  return dir;
}
