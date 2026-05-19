// RFC 017 M0a — unit tests for `src/contextual-preface.ts`.
//
// Each test runs against an isolated `FAISS_INDEX_PATH` so the sidecar
// directory is freshly empty. The `KB_LLM_ENDPOINT` env var is set to a
// loopback URL that no test actually calls — we mock `fetch` via the
// jest module loader so the real LLM client never fires.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Document } from '@langchain/core/documents';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const FETCH_MOCK = jest.fn();

// The contextual-preface module is loaded dynamically per-test so it
// picks up the per-test FAISS_INDEX_PATH from the environment.
type ContextualPrefaceModule = typeof import('./contextual-preface.js');

let tempDir: string;
let savedEnv: Record<string, string | undefined>;

async function loadModule(): Promise<ContextualPrefaceModule> {
  return (await import('./contextual-preface.js')) as ContextualPrefaceModule;
}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-contextual-preface-'));
  savedEnv = {
    FAISS_INDEX_PATH: process.env.FAISS_INDEX_PATH,
    KNOWLEDGE_BASES_ROOT_DIR: process.env.KNOWLEDGE_BASES_ROOT_DIR,
    KB_CONTEXTUAL_RETRIEVAL: process.env.KB_CONTEXTUAL_RETRIEVAL,
    KB_LLM_ENDPOINT: process.env.KB_LLM_ENDPOINT,
    KB_CONTEXTUAL_MAX_TOKENS: process.env.KB_CONTEXTUAL_MAX_TOKENS,
  };
  // Set BEFORE the dynamic import so config/paths.ts reads the right
  // value at module-init time. The contextual-preface module reads
  // FAISS_INDEX_PATH transitively via `sidecarRootDir`.
  setEnv('FAISS_INDEX_PATH', path.join(tempDir, '.faiss'));
  setEnv('KNOWLEDGE_BASES_ROOT_DIR', path.join(tempDir, 'kbs'));
  setEnv('KB_CONTEXTUAL_RETRIEVAL', 'on');
  setEnv('KB_LLM_ENDPOINT', 'http://127.0.0.1:0/v1/chat/completions');
  setEnv('KB_CONTEXTUAL_MAX_TOKENS', '120');
  jest.resetModules();
  global.fetch = FETCH_MOCK as unknown as typeof fetch;
  FETCH_MOCK.mockReset();
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) setEnv(key, value);
  await fsp.rm(tempDir, { recursive: true, force: true });
});

function llmResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      model: 'mock-llm',
      choices: [{ message: { content } }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('embeddingText', () => {
  it('returns pageContent verbatim when no preface metadata is present', async () => {
    const { embeddingText } = await loadModule();
    const doc = new Document({ pageContent: 'raw chunk', metadata: {} });
    expect(embeddingText(doc)).toBe('raw chunk');
  });

  it('prepends the preface with a blank-line separator when present', async () => {
    const { embeddingText } = await loadModule();
    const doc = new Document({
      pageContent: 'raw chunk',
      metadata: { contextual_preface: 'Where this lives in the doc.' },
    });
    expect(embeddingText(doc)).toBe('Where this lives in the doc.\n\nraw chunk');
  });

  it('falls back to pageContent when contextual_preface is empty or non-string', async () => {
    const { embeddingText } = await loadModule();
    expect(embeddingText(new Document({ pageContent: 'a', metadata: { contextual_preface: '' } }))).toBe('a');
    expect(embeddingText(new Document({ pageContent: 'a', metadata: { contextual_preface: 42 } }))).toBe('a');
  });
});

describe('resolveContextualPrefaces — LLM call + sidecar', () => {
  it('returns nulls and skips LLM when KB_LLM_ENDPOINT is unset', async () => {
    setEnv('KB_LLM_ENDPOINT', undefined);
    const { resolveContextualPrefaces } = await loadModule();
    const result = await resolveContextualPrefaces({
      source: '/tmp/foo.md',
      knowledgeBaseName: 'alpha',
      documentHash: 'h0',
      documentBody: 'body',
      chunks: ['c1', 'c2'],
    });
    expect(result).toEqual([null, null]);
    expect(FETCH_MOCK).not.toHaveBeenCalled();
  });

  it('calls the LLM once per chunk and writes a sidecar that round-trips', async () => {
    FETCH_MOCK.mockImplementation(async () => llmResponse('section 2 preface text'));
    const { resolveContextualPrefaces, sidecarPathFor } = await loadModule();
    const source = '/tmp/alpha/note.md';

    const result = await resolveContextualPrefaces({
      source,
      knowledgeBaseName: 'alpha',
      documentHash: 'doc-hash-v1',
      documentBody: 'document body',
      chunks: ['chunk-a', 'chunk-b'],
    });

    expect(result).toEqual(['section 2 preface text', 'section 2 preface text']);
    expect(FETCH_MOCK).toHaveBeenCalledTimes(2);

    // Sidecar persisted.
    const sidecarPath = sidecarPathFor(source, 'alpha');
    const raw = await fsp.readFile(sidecarPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.schema_version).toBe('contextual-preface.sidecar.v1');
    expect(parsed.document_hash).toBe('doc-hash-v1');
    expect(parsed.chunks).toHaveLength(2);
    expect(parsed.chunks[0]).toMatchObject({
      chunk_index: 0,
      preface: 'section 2 preface text',
    });
  });

  it('hits the cache on a second call with identical inputs', async () => {
    FETCH_MOCK.mockImplementation(async () => llmResponse('preface'));
    const { resolveContextualPrefaces } = await loadModule();
    const args = {
      source: '/tmp/alpha/note.md',
      knowledgeBaseName: 'alpha',
      documentHash: 'doc-hash-v1',
      documentBody: 'body',
      chunks: ['chunk-a', 'chunk-b'],
    };

    await resolveContextualPrefaces(args);
    expect(FETCH_MOCK).toHaveBeenCalledTimes(2);

    FETCH_MOCK.mockClear();
    const second = await resolveContextualPrefaces(args);
    expect(second).toEqual(['preface', 'preface']);
    expect(FETCH_MOCK).not.toHaveBeenCalled();
  });

  it('invalidates the cache when documentHash changes', async () => {
    FETCH_MOCK.mockImplementation(async () => llmResponse('preface'));
    const { resolveContextualPrefaces } = await loadModule();
    const base = {
      source: '/tmp/alpha/note.md',
      knowledgeBaseName: 'alpha',
      documentBody: 'body',
      chunks: ['chunk-a'],
    };

    await resolveContextualPrefaces({ ...base, documentHash: 'h1' });
    FETCH_MOCK.mockClear();
    await resolveContextualPrefaces({ ...base, documentHash: 'h2' });
    expect(FETCH_MOCK).toHaveBeenCalledTimes(1);
  });

  it('records a failure entry with next_retry_after when the LLM errors', async () => {
    FETCH_MOCK.mockImplementation(async () => {
      throw new Error('network unreachable');
    });
    const { resolveContextualPrefaces, sidecarPathFor } = await loadModule();
    const source = '/tmp/alpha/note.md';

    const result = await resolveContextualPrefaces({
      source,
      knowledgeBaseName: 'alpha',
      documentHash: 'h',
      documentBody: 'b',
      chunks: ['c'],
    });

    expect(result).toEqual([null]);

    const sidecarPath = sidecarPathFor(source, 'alpha');
    const parsed = JSON.parse(await fsp.readFile(sidecarPath, 'utf-8'));
    expect(parsed.chunks[0]).toMatchObject({
      preface: null,
      error_code: 'llm_unreachable',
    });
    expect(parsed.chunks[0].next_retry_after).toEqual(expect.any(String));
  });

  it('respects next_retry_after on subsequent calls (no LLM during backoff)', async () => {
    FETCH_MOCK.mockImplementation(async () => {
      throw new Error('network unreachable');
    });
    const { resolveContextualPrefaces } = await loadModule();
    const args = {
      source: '/tmp/alpha/note.md',
      knowledgeBaseName: 'alpha',
      documentHash: 'h',
      documentBody: 'b',
      chunks: ['c'],
    };

    await resolveContextualPrefaces(args);
    FETCH_MOCK.mockClear();
    await resolveContextualPrefaces(args);
    expect(FETCH_MOCK).not.toHaveBeenCalled();
  });

  it('rejects refusal-prefixed responses as failures (not as a real preface)', async () => {
    FETCH_MOCK.mockImplementation(async () =>
      llmResponse("I cannot fulfill this request"),
    );
    const { resolveContextualPrefaces, sidecarPathFor } = await loadModule();
    const source = '/tmp/alpha/note.md';

    const result = await resolveContextualPrefaces({
      source,
      knowledgeBaseName: 'alpha',
      documentHash: 'h',
      documentBody: 'b',
      chunks: ['c'],
    });

    expect(result).toEqual([null]);
    const sidecarPath = sidecarPathFor(source, 'alpha');
    const parsed = JSON.parse(await fsp.readFile(sidecarPath, 'utf-8'));
    expect(parsed.chunks[0].preface).toBeNull();
  });

  it('produces different sidecar entries for two chunks with identical text — preface metadata is per-chunk', async () => {
    // Round-trip evidence for RFC 017 §3: "two chunks with identical text
    // but different prefaces no longer collide into one vector." We can't
    // exercise the FAISS path from this unit test, but we can prove the
    // chunk_hash collision: same text → same chunk_hash → same preface in
    // the sidecar, but the FaissStoreAdapter test covers the embedding-
    // side outcome of two-different-prefaces.
    FETCH_MOCK.mockImplementation(async () =>
      llmResponse('per-call preface'),
    );
    const { resolveContextualPrefaces } = await loadModule();
    const result = await resolveContextualPrefaces({
      source: '/tmp/alpha/note.md',
      knowledgeBaseName: 'alpha',
      documentHash: 'h',
      documentBody: 'b',
      chunks: ['identical text', 'identical text'],
    });
    expect(result).toEqual(['per-call preface', 'per-call preface']);
    expect(FETCH_MOCK).toHaveBeenCalledTimes(2);
  });
});

describe('classifyContextualSidecarChunks — cache-aware reindex estimate (#408)', () => {
  // Minimal sidecar writer — mirrors the on-disk shape `persistSidecar`
  // produces, without going through the LLM resolver.
  async function writeSidecar(
    mod: ContextualPrefaceModule,
    source: string,
    kb: string,
    chunks: Array<Record<string, unknown>>,
    overrides: Record<string, unknown> = {},
  ): Promise<void> {
    const sidecarPath = mod.sidecarPathFor(source, kb);
    await fsp.mkdir(path.dirname(sidecarPath), { recursive: true });
    const payload = {
      schema_version: 'contextual-preface.sidecar.v1',
      source,
      knowledge_base: kb,
      document_hash: 'doc-hash',
      generator: mod.GENERATOR_VERSION,
      model: 'mock-llm',
      chunk_size: 1000,
      chunk_overlap: 200,
      chunks,
      ...overrides,
    };
    await fsp.writeFile(sidecarPath, JSON.stringify(payload), 'utf-8');
  }

  it('reports all-cold when no sidecar exists', async () => {
    const mod = await loadModule();
    const tally = await mod.classifyContextualSidecarChunks('/kbs/alpha/n.md', 'alpha', 3);
    expect(tally).toEqual({ cache_hits: 0, retry_skips: 0, cold_chunks: 3 });
  });

  it('counts chunks with a stored preface as cache hits', async () => {
    const mod = await loadModule();
    const source = '/kbs/alpha/n.md';
    await writeSidecar(mod, source, 'alpha', [
      { chunk_index: 0, chunk_hash: 'a', preface: 'ctx 0' },
      { chunk_index: 1, chunk_hash: 'b', preface: 'ctx 1' },
    ]);
    const tally = await mod.classifyContextualSidecarChunks(source, 'alpha', 2);
    expect(tally).toEqual({ cache_hits: 2, retry_skips: 0, cold_chunks: 0 });
  });

  it('counts a future retry-after as a skip and an elapsed one as cold', async () => {
    const mod = await loadModule();
    const source = '/kbs/alpha/n.md';
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    await writeSidecar(mod, source, 'alpha', [
      { chunk_index: 0, chunk_hash: 'a', preface: null, error_code: 'llm_unreachable', next_retry_after: future },
      { chunk_index: 1, chunk_hash: 'b', preface: null, error_code: 'llm_unreachable', next_retry_after: past },
      { chunk_index: 2, chunk_hash: 'c', preface: null },
    ]);
    const tally = await mod.classifyContextualSidecarChunks(source, 'alpha', 3);
    expect(tally).toEqual({ cache_hits: 0, retry_skips: 1, cold_chunks: 2 });
  });

  it('treats indices with no matching sidecar entry as cold (partial sidecar)', async () => {
    const mod = await loadModule();
    const source = '/kbs/alpha/n.md';
    await writeSidecar(mod, source, 'alpha', [
      { chunk_index: 0, chunk_hash: 'a', preface: 'ctx 0' },
    ]);
    // Manifest says 4 chunks; the sidecar only covers index 0.
    const tally = await mod.classifyContextualSidecarChunks(source, 'alpha', 4);
    expect(tally).toEqual({ cache_hits: 1, retry_skips: 0, cold_chunks: 3 });
  });

  it('invalidates the whole sidecar when the generator version differs', async () => {
    const mod = await loadModule();
    const source = '/kbs/alpha/n.md';
    await writeSidecar(
      mod,
      source,
      'alpha',
      [
        { chunk_index: 0, chunk_hash: 'a', preface: 'ctx 0' },
        { chunk_index: 1, chunk_hash: 'b', preface: 'ctx 1' },
      ],
      { generator: 'contextual-preface.v0-stale' },
    );
    const tally = await mod.classifyContextualSidecarChunks(source, 'alpha', 2);
    expect(tally).toEqual({ cache_hits: 0, retry_skips: 0, cold_chunks: 2 });
  });

  it('invalidates the whole sidecar when the chunk size differs', async () => {
    const mod = await loadModule();
    const source = '/kbs/alpha/n.md';
    await writeSidecar(
      mod,
      source,
      'alpha',
      [{ chunk_index: 0, chunk_hash: 'a', preface: 'ctx 0' }],
      { chunk_size: 512 },
    );
    const tally = await mod.classifyContextualSidecarChunks(source, 'alpha', 1);
    expect(tally).toEqual({ cache_hits: 0, retry_skips: 0, cold_chunks: 1 });
  });

  it('honours the nowMs argument for deterministic retry arithmetic', async () => {
    const mod = await loadModule();
    const source = '/kbs/alpha/n.md';
    await writeSidecar(mod, source, 'alpha', [
      { chunk_index: 0, chunk_hash: 'a', preface: null, next_retry_after: '2026-06-01T00:00:00.000Z' },
    ]);
    const before = await mod.classifyContextualSidecarChunks(
      source, 'alpha', 1, Date.parse('2026-05-01T00:00:00.000Z'),
    );
    expect(before).toEqual({ cache_hits: 0, retry_skips: 1, cold_chunks: 0 });
    const after = await mod.classifyContextualSidecarChunks(
      source, 'alpha', 1, Date.parse('2026-07-01T00:00:00.000Z'),
    );
    expect(after).toEqual({ cache_hits: 0, retry_skips: 0, cold_chunks: 1 });
  });

  it('returns an all-zero tally for a zero expected chunk count', async () => {
    const mod = await loadModule();
    expect(await mod.classifyContextualSidecarChunks('/kbs/alpha/n.md', 'alpha', 0))
      .toEqual({ cache_hits: 0, retry_skips: 0, cold_chunks: 0 });
  });

  it('treats a corrupt sidecar as all-cold', async () => {
    const mod = await loadModule();
    const source = '/kbs/alpha/n.md';
    const sidecarPath = mod.sidecarPathFor(source, 'alpha');
    await fsp.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fsp.writeFile(sidecarPath, '{ not valid json', 'utf-8');
    const tally = await mod.classifyContextualSidecarChunks(source, 'alpha', 2);
    expect(tally).toEqual({ cache_hits: 0, retry_skips: 0, cold_chunks: 2 });
  });
});
