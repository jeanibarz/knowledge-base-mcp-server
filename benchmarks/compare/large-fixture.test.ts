import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { generateKnowledgeBaseFixture } from '../fixtures/generator.js';
import {
  ensureLargeCorpusCache,
  getDefaultLargeCorpusSpec,
  largeCorpusGoldenLabels,
  largeCorpusQueryLines,
  materializeLargeCorpusFixture,
  validateLargeCorpusCache,
} from '../fixtures/large-corpus.js';

describe('large corpus fixture', () => {
  let tmpdir: string;
  let originalProfile: string | undefined;
  let originalCacheDir: string | undefined;

  beforeEach(async () => {
    tmpdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-large-fixture-test-'));
    originalProfile = process.env.BENCH_FIXTURE_PROFILE;
    originalCacheDir = process.env.BENCH_LARGE_CORPUS_CACHE_DIR;
  });

  afterEach(async () => {
    if (originalProfile === undefined) delete process.env.BENCH_FIXTURE_PROFILE;
    else process.env.BENCH_FIXTURE_PROFILE = originalProfile;
    if (originalCacheDir === undefined) delete process.env.BENCH_LARGE_CORPUS_CACHE_DIR;
    else process.env.BENCH_LARGE_CORPUS_CACHE_DIR = originalCacheDir;
    await fsp.rm(tmpdir, { recursive: true, force: true });
  });

  it('creates a deterministic cache with query judgments for every required case', async () => {
    const cacheRoot = path.join(tmpdir, 'cache');
    const spec = getDefaultLargeCorpusSpec({ documentCount: 16, targetChunksPerFile: 3 });

    const first = await ensureLargeCorpusCache({ cacheRoot, spec });
    const second = await ensureLargeCorpusCache({ cacheRoot, spec });

    expect(second.cacheKey).toBe(first.cacheKey);
    expect(second.manifest.content_sha256).toBe(first.manifest.content_sha256);
    expect(first.manifest.files).toHaveLength(16);

    const kinds = new Set(first.queries.map((query) => query.kind));
    expect(kinds).toEqual(new Set([
      'exact-token',
      'multi-hop',
      'near-duplicate',
      'paraphrase',
      'single-hop',
    ]));

    const queryLines = await largeCorpusQueryLines(first);
    expect(queryLines).toHaveLength(first.queries.length);
    expect(queryLines.every((line) => line.length > 0)).toBe(true);

    const golden = await largeCorpusGoldenLabels(first);
    expect(new Set(Object.keys(golden))).toEqual(new Set(queryLines));
    expect(Object.values(golden).every((labels) => labels.some((label) => label.relevance > 0))).toBe(true);
  });

  it('rejects a cache when an integrity-checked file is modified', async () => {
    const cacheRoot = path.join(tmpdir, 'cache');
    const spec = getDefaultLargeCorpusSpec({ documentCount: 8, targetChunksPerFile: 2 });
    const cache = await ensureLargeCorpusCache({ cacheRoot, spec });
    const firstFile = cache.manifest.files[0];
    expect(firstFile).toBeDefined();

    await fsp.appendFile(path.join(cache.cachePath, firstFile!.path), '\ncorrupting the cache\n', 'utf-8');

    await expect(validateLargeCorpusCache(cache.cachePath, spec))
      .rejects
      .toThrow('sha256 mismatch');
  });

  it('materializes cached documents and labels using KB-relative sources', async () => {
    const cacheRoot = path.join(tmpdir, 'cache');
    const rootDir = path.join(tmpdir, 'knowledge-bases');
    const spec = getDefaultLargeCorpusSpec({ documentCount: 10, targetChunksPerFile: 2 });

    const fixture = await materializeLargeCorpusFixture({
      cacheRoot,
      knowledgeBaseName: 'large-kb',
      rootDir,
      spec,
    });

    expect(fixture.files).toBe(10);
    expect(fixture.chunkCount).toBeGreaterThan(10);
    expect(fixture.query.toLowerCase()).toContain('retrieval');

    const materialized = await fsp.readdir(path.join(rootDir, 'large-kb'));
    expect(materialized.filter((name) => name.endsWith('.md'))).toHaveLength(10);
    expect(fixture.goldenLabels[fixture.query]?.[0]?.source).toMatch(/^large-kb\/paper-/);
  });

  it('routes generateKnowledgeBaseFixture through the large profile when requested', async () => {
    const cacheRoot = path.join(tmpdir, 'cache');
    const rootDir = path.join(tmpdir, 'knowledge-bases');
    process.env.BENCH_FIXTURE_PROFILE = 'large';
    process.env.BENCH_LARGE_CORPUS_CACHE_DIR = cacheRoot;

    const fixture = await generateKnowledgeBaseFixture({
      files: 9,
      knowledgeBaseName: 'default',
      rootDir,
      seed: 7,
      targetChunksPerFile: 2,
    });

    expect(fixture.files).toBe(9);
    expect(fixture.chunkCount).toBeGreaterThan(9);
    expect(fixture.query.toLowerCase()).toContain('retrieval');
    await expect(fsp.stat(path.join(rootDir, 'default', 'paper-0001-hybrid-retrieval.md')))
      .resolves
      .toBeDefined();
  });
});
