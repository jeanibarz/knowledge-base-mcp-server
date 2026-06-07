import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { LexicalIndex } from './lexical-index.js';

const originalEnv = {
  KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
  FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function freshCache(faissDir: string): Promise<typeof import('./lexical-index-cache.js')> {
  process.env.KNOWLEDGE_BASES_ROOT_DIR = path.join(path.dirname(faissDir), 'kbs');
  process.env.FAISS_INDEX_PATH = faissDir;
  jest.resetModules();
  return import('./lexical-index-cache.js');
}

function fakeIndex(files = 1): LexicalIndex {
  return { numFiles: jest.fn(() => files) } as unknown as LexicalIndex;
}

async function writePersistedIndex(
  faissDir: string,
  kbName: string,
  body: string,
  mtime: Date,
): Promise<void> {
  const filePath = path.join(faissDir, 'lexical', kbName, 'index.json');
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, body, 'utf-8');
  await fsp.utimes(filePath, mtime, mtime);
}

describe('LexicalIndexCache', () => {
  it('reuses a parsed non-empty index while persisted metadata is unchanged', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lexical-cache-hit-'));
    const faissDir = path.join(tempDir, 'faiss');
    await writePersistedIndex(faissDir, 'alpha', '{"files":{"a":1}}', new Date('2026-01-01T00:00:00Z'));
    const { LexicalIndexCache } = await freshCache(faissDir);
    const index = fakeIndex(1);
    const loadIndex = jest.fn(async () => index);
    const cache = new LexicalIndexCache({ loadIndex });

    await expect(cache.load('alpha', '/kb/alpha')).resolves.toBe(index);
    await expect(cache.load('alpha', '/kb/alpha')).resolves.toBe(index);

    expect(loadIndex).toHaveBeenCalledTimes(1);
  });

  it('reloads when the persisted lexical index metadata changes', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lexical-cache-reload-'));
    const faissDir = path.join(tempDir, 'faiss');
    await writePersistedIndex(faissDir, 'alpha', '{"files":{"a":1}}', new Date('2026-01-01T00:00:00Z'));
    const { LexicalIndexCache } = await freshCache(faissDir);
    const first = fakeIndex(1);
    const second = fakeIndex(2);
    const loadIndex = jest.fn<() => Promise<LexicalIndex>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const cache = new LexicalIndexCache({ loadIndex });

    await expect(cache.load('alpha', '/kb/alpha')).resolves.toBe(first);
    await writePersistedIndex(
      faissDir,
      'alpha',
      '{"files":{"a":1,"b":2}}',
      new Date('2026-01-02T00:00:00Z'),
    );
    await expect(cache.load('alpha', '/kb/alpha')).resolves.toBe(second);

    expect(loadIndex).toHaveBeenCalledTimes(2);
  });

  it('does not cache missing persisted lexical index files', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lexical-cache-missing-'));
    const faissDir = path.join(tempDir, 'faiss');
    const { LexicalIndexCache } = await freshCache(faissDir);
    const loadIndex = jest.fn(async () => fakeIndex(0));
    const cache = new LexicalIndexCache({ loadIndex });

    await cache.load('alpha', '/kb/alpha');
    await cache.load('alpha', '/kb/alpha');

    expect(loadIndex).toHaveBeenCalledTimes(2);
  });

  it('does not cache empty parsed indexes even when an index file exists', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lexical-cache-empty-'));
    const faissDir = path.join(tempDir, 'faiss');
    await writePersistedIndex(faissDir, 'alpha', '{"files":{}}', new Date('2026-01-01T00:00:00Z'));
    const { LexicalIndexCache } = await freshCache(faissDir);
    const loadIndex = jest.fn(async () => fakeIndex(0));
    const cache = new LexicalIndexCache({ loadIndex });

    await cache.load('alpha', '/kb/alpha');
    await cache.load('alpha', '/kb/alpha');

    expect(loadIndex).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent loads for the same unchanged lexical index file', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lexical-cache-concurrent-'));
    const faissDir = path.join(tempDir, 'faiss');
    await writePersistedIndex(faissDir, 'alpha', '{"files":{"a":1}}', new Date('2026-01-01T00:00:00Z'));
    const { LexicalIndexCache } = await freshCache(faissDir);
    const index = fakeIndex(1);
    let releaseLoad!: () => void;
    let markLoadStarted!: () => void;
    const loadStarted = new Promise<void>((resolve) => {
      markLoadStarted = resolve;
    });
    const loadIndex = jest.fn(async () => {
      markLoadStarted();
      await new Promise<void>((release) => {
        releaseLoad = release;
      });
      return index;
    });
    const cache = new LexicalIndexCache({ loadIndex });

    const first = cache.load('alpha', '/kb/alpha');
    const second = cache.load('alpha', '/kb/alpha');
    await loadStarted;
    expect(loadIndex).toHaveBeenCalledTimes(1);
    releaseLoad();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(index);
    expect(b).toBe(index);
    expect(loadIndex).toHaveBeenCalledTimes(1);
  });
});
