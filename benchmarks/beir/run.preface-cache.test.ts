import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { parseArgs, persistPrefaceCache, seedPrefaceCache } from './run.js';

async function makeTempDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('BEIR runner contextual-preface cache', () => {
  it('parses --preface-cache-dir to an absolute path', () => {
    const args = parseArgs(['--preface-cache-dir=relative/cache']);
    expect(args.prefaceCacheDir).toBe(path.resolve('relative/cache'));
  });

  it('leaves prefaceCacheDir undefined when the flag is absent', () => {
    expect(parseArgs([]).prefaceCacheDir).toBeUndefined();
  });

  it('seed is a no-op when the cache dir does not exist yet', async () => {
    const faiss = await makeTempDir('kb-preface-faiss-');
    try {
      await seedPrefaceCache(path.join(faiss, 'no-such-cache'), faiss);
      await expect(fsp.access(path.join(faiss, '.contextual-prefaces'))).rejects.toThrow();
    } finally {
      await fsp.rm(faiss, { recursive: true, force: true });
    }
  });

  it('persist is a no-op when the run produced no sidecars', async () => {
    const faiss = await makeTempDir('kb-preface-faiss-');
    const cache = path.join(faiss, 'cache-target');
    try {
      await persistPrefaceCache(faiss, cache);
      await expect(fsp.access(cache)).rejects.toThrow();
    } finally {
      await fsp.rm(faiss, { recursive: true, force: true });
    }
  });

  it('round-trips sidecars: seed into the workspace, persist back merged', async () => {
    const cache = await makeTempDir('kb-preface-cache-');
    const faiss = await makeTempDir('kb-preface-faiss-');
    try {
      const kbDir = path.join(cache, 'kb-tiny');
      await fsp.mkdir(kbDir, { recursive: true });
      await fsp.writeFile(path.join(kbDir, 'doc-a.json'), '{"from":"cache"}', 'utf-8');

      await seedPrefaceCache(cache, faiss);
      const seeded = path.join(faiss, '.contextual-prefaces', 'kb-tiny', 'doc-a.json');
      await expect(fsp.readFile(seeded, 'utf-8')).resolves.toBe('{"from":"cache"}');

      // The run adds one sidecar; persisting must merge it into the cache
      // without dropping the entry that was already there.
      await fsp.writeFile(
        path.join(faiss, '.contextual-prefaces', 'kb-tiny', 'doc-b.json'),
        '{"from":"run"}',
        'utf-8',
      );
      await persistPrefaceCache(faiss, cache);
      await expect(fsp.readFile(path.join(kbDir, 'doc-a.json'), 'utf-8')).resolves.toBe('{"from":"cache"}');
      await expect(fsp.readFile(path.join(kbDir, 'doc-b.json'), 'utf-8')).resolves.toBe('{"from":"run"}');
    } finally {
      await fsp.rm(cache, { recursive: true, force: true });
      await fsp.rm(faiss, { recursive: true, force: true });
    }
  });
});
