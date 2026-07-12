import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  AnswerCache,
  ANSWER_CACHE_SCHEMA_VERSION,
  answerCacheDir,
  computeAnswerCacheKey,
  defaultAnswerCache,
  fingerprintPackedSnippets,
  normalizeAnswerCacheQuery,
  sha256Hex,
  type AnswerCacheKeyInput,
} from './ask-answer-cache.js';

function baseKeyInput(): AnswerCacheKeyInput {
  return {
    query: 'What changed in the deploy?',
    embeddingModel: 'ollama__nomic-embed-text-latest',
    llmProfile: 'env',
    llmEndpoint: 'http://127.0.0.1:8080/v1/chat/completions',
    temperature: 0.2,
    systemPrompt: 'system',
    context: [
      { chunk_id: 'ops/deploys.md#L10-L18', content_sha256: sha256Hex('snippet-a') },
    ],
  };
}

describe('answer cache key (#656)', () => {
  it('is deterministic for identical inputs', () => {
    expect(computeAnswerCacheKey(baseKeyInput())).toBe(computeAnswerCacheKey(baseKeyInput()));
  });

  it('normalizes whitespace and unicode in the query', () => {
    const a = computeAnswerCacheKey({ ...baseKeyInput(), query: '  What   changed in the deploy? ' });
    const b = computeAnswerCacheKey(baseKeyInput());
    expect(a).toBe(b);
    expect(normalizeAnswerCacheQuery('  a\t b  ')).toBe('a b');
  });

  it.each([
    ['query', { query: 'something else' }],
    ['embedding model', { embeddingModel: 'other-model' }],
    ['llm profile', { llmProfile: 'other' }],
    ['llm endpoint', { llmEndpoint: 'http://127.0.0.1:9000/v1/chat/completions' }],
    ['temperature', { temperature: 0.7 }],
    ['system prompt', { systemPrompt: 'different' }],
    ['task context', { taskContext: 'now with task context' }],
  ])('changes when the %s changes', (_label, override) => {
    expect(computeAnswerCacheKey({ ...baseKeyInput(), ...override }))
      .not.toBe(computeAnswerCacheKey(baseKeyInput()));
  });

  it('changes when the retrieved-context fingerprint changes', () => {
    const changed = computeAnswerCacheKey({
      ...baseKeyInput(),
      context: [{ chunk_id: 'ops/deploys.md#L10-L18', content_sha256: sha256Hex('snippet-b') }],
    });
    expect(changed).not.toBe(computeAnswerCacheKey(baseKeyInput()));
  });

  it('fingerprints packed snippets by chunk id and content hash', () => {
    expect(fingerprintPackedSnippets([
      { chunkId: 'c1', text: 'hello' },
      { chunkId: null, text: 'world' },
    ])).toEqual([
      { chunk_id: 'c1', content_sha256: sha256Hex('hello') },
      { chunk_id: null, content_sha256: sha256Hex('world') },
    ]);
  });
});

describe('AnswerCache storage (#656)', () => {
  let dir: string;
  const itPosixNonRoot =
    process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)
      ? it.skip
      : it;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-answer-cache-'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('round-trips an answer when enabled', async () => {
    const cache = new AnswerCache({ enabled: true, indexPath: dir });
    const key = computeAnswerCacheKey(baseKeyInput());
    expect(await cache.get(key)).toBeNull();
    expect((await cache.stats()).corruptions).toBe(0);
    await cache.set(key, { answer: 'cached answer', model: 'qwen3' });
    expect(await cache.get(key)).toEqual({ answer: 'cached answer', model: 'qwen3' });
    const stats = await cache.stats();
    expect(stats.writes).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.disk_size_bytes).toBeGreaterThan(0);
  });

  it('stores entries under the cache root as 64-hex .json files', async () => {
    const cache = new AnswerCache({ enabled: true, indexPath: dir });
    const key = computeAnswerCacheKey(baseKeyInput());
    await cache.set(key, { answer: 'a', model: null });
    const entries = await fsp.readdir(answerCacheDir(dir));
    expect(entries).toContain(`${key}.json`);
    const stored = JSON.parse(await fsp.readFile(path.join(answerCacheDir(dir), `${key}.json`), 'utf-8'));
    expect(stored.schema_version).toBe(ANSWER_CACHE_SCHEMA_VERSION);
    expect(stored.key).toBe(key);
  });

  it('is a no-op when disabled', async () => {
    const cache = new AnswerCache({ enabled: false, indexPath: dir });
    const key = computeAnswerCacheKey(baseKeyInput());
    await cache.set(key, { answer: 'a', model: null });
    expect(await cache.get(key)).toBeNull();
    expect(await fsp.readdir(answerCacheDir(dir)).catch(() => [])).toEqual([]);
  });

  it('drops and misses on a corrupt entry', async () => {
    const cache = new AnswerCache({ enabled: true, indexPath: dir });
    const key = computeAnswerCacheKey(baseKeyInput());
    await fsp.mkdir(answerCacheDir(dir), { recursive: true });
    const file = path.join(answerCacheDir(dir), `${key}.json`);
    await fsp.writeFile(file, '{not valid json', 'utf-8');
    expect(await cache.get(key)).toBeNull();
    await expect(fsp.access(file)).rejects.toBeDefined();
    expect((await cache.stats()).corruptions).toBe(1);
  });

  itPosixNonRoot('TS-CACHE-830: treats transient disk read errors as misses without evicting the entry', async () => {
    const cache = new AnswerCache({ enabled: true, indexPath: dir });
    const key = computeAnswerCacheKey(baseKeyInput());
    await cache.set(key, { answer: 'cached answer', model: 'qwen3' });
    const file = path.join(answerCacheDir(dir), `${key}.json`);
    const original = await fsp.readFile(file);
    await fsp.chmod(file, 0o000);
    try {
      expect(await cache.get(key)).toBeNull();
      expect((await cache.stats()).corruptions).toBe(0);
    } finally {
      if (await fsp.access(file).then(() => true).catch(() => false)) {
        await fsp.chmod(file, 0o600);
      }
    }
    expect(await fsp.readFile(file)).toEqual(original);
  });

  it('evicts oldest entries when over the disk cap', async () => {
    const keyOld = computeAnswerCacheKey({ ...baseKeyInput(), query: 'old' });
    const keyNew = computeAnswerCacheKey({ ...baseKeyInput(), query: 'new' });

    // Size the cap to exactly one entry so the second write evicts the first.
    const probe = new AnswerCache({ enabled: true, indexPath: dir });
    await probe.set(keyOld, { answer: 'old answer', model: null });
    const oldEntry = path.join(answerCacheDir(dir), `${keyOld}.json`);
    const entrySize = (await fsp.stat(oldEntry)).size;
    const oldTimestamp = new Date(Date.now() - 60_000);
    await fsp.utimes(oldEntry, oldTimestamp, oldTimestamp);

    const cache = new AnswerCache({ enabled: true, indexPath: dir, diskMaxBytes: entrySize });
    await cache.set(keyNew, { answer: 'new answer', model: null });

    expect(await cache.get(keyOld)).toBeNull();
    expect(await cache.get(keyNew)).toEqual({ answer: 'new answer', model: null });
  });

  it('defaults to disabled (opt-in)', () => {
    expect(defaultAnswerCache.enabled).toBe(false);
  });
});
