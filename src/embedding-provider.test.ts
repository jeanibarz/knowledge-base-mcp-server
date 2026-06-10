import { afterEach, describe, expect, it, jest } from '@jest/globals';

const originalEnv = {
  EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
  KB_FAKE_DIM: process.env.KB_FAKE_DIM,
  KB_EMBEDDING_TASK_PREFIXES: process.env.KB_EMBEDDING_TASK_PREFIXES,
  HUGGINGFACE_API_KEY: process.env.HUGGINGFACE_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function loadFresh(env: Record<string, string | undefined>): Promise<typeof import('./embedding-provider.js')> {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  jest.resetModules();
  return import('./embedding-provider.js');
}

describe('FakeEmbeddings (issue #204 — deterministic offline provider)', () => {
  it('returns the configured dimension (default 256)', async () => {
    const { FakeEmbeddings } = await loadFresh({ KB_FAKE_DIM: undefined });
    const embedder = new FakeEmbeddings();
    expect(embedder.dim).toBe(256);
    const vector = await embedder.embedQuery('hello');
    expect(vector).toHaveLength(256);
  });

  it('produces byte-identical vectors across calls for the same input', async () => {
    const { FakeEmbeddings } = await loadFresh({});
    const embedder = new FakeEmbeddings({ dim: 128 });
    const a = await embedder.embedQuery('the quick brown fox');
    const b = await embedder.embedQuery('the quick brown fox');
    expect(a).toEqual(b);
  });

  it('produces byte-identical vectors across fresh constructions (cross-process determinism)', async () => {
    const { FakeEmbeddings: A } = await loadFresh({});
    const va = await new A({ dim: 64 }).embedQuery('reproducible across machines');
    const { FakeEmbeddings: B } = await loadFresh({});
    const vb = await new B({ dim: 64 }).embedQuery('reproducible across machines');
    expect(va).toEqual(vb);
  });

  it('L2-normalizes the output for non-empty input', async () => {
    const { FakeEmbeddings } = await loadFresh({});
    const embedder = new FakeEmbeddings({ dim: 256 });
    const vector = await embedder.embedQuery('alpha beta gamma alpha');
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    // Rounded to 6 decimals so the magnitude is within ~1e-3 of unity.
    expect(norm).toBeGreaterThan(0.999);
    expect(norm).toBeLessThan(1.001);
  });

  it('returns the zero vector for empty or punctuation-only input (no NaN from divide-by-zero)', async () => {
    const { FakeEmbeddings } = await loadFresh({});
    const embedder = new FakeEmbeddings({ dim: 32 });
    const empty = await embedder.embedQuery('');
    const punct = await embedder.embedQuery('!!! ??? ...');
    expect(empty).toHaveLength(32);
    expect(empty.every((v) => v === 0)).toBe(true);
    expect(punct.every((v) => v === 0)).toBe(true);
    expect(empty.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('produces distinct vectors for distinct token bags', async () => {
    const { FakeEmbeddings } = await loadFresh({});
    const embedder = new FakeEmbeddings({ dim: 256 });
    const v1 = await embedder.embedQuery('apple banana cherry');
    const v2 = await embedder.embedQuery('zebra yak xenon');
    expect(v1).not.toEqual(v2);
  });

  it('embedDocuments preserves order and per-text determinism', async () => {
    const { FakeEmbeddings } = await loadFresh({});
    const embedder = new FakeEmbeddings({ dim: 64 });
    const docs = ['alpha beta', 'gamma delta', 'alpha beta'];
    const out = await embedder.embedDocuments(docs);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(out[2]); // same text → same vector
    expect(out[0]).not.toEqual(out[1]);
    expect(out[0]).toEqual(await embedder.embedQuery('alpha beta'));
  });

  it('is case- and punctuation-folded (tokenizer treats "Foo, bar." == "foo bar")', async () => {
    const { FakeEmbeddings } = await loadFresh({});
    const embedder = new FakeEmbeddings({ dim: 64 });
    const a = await embedder.embedQuery('Foo, bar.');
    const b = await embedder.embedQuery('foo bar');
    expect(a).toEqual(b);
  });

  it('honors KB_FAKE_DIM env var at module load', async () => {
    const { FakeEmbeddings } = await loadFresh({ KB_FAKE_DIM: '512' });
    const embedder = new FakeEmbeddings();
    expect(embedder.dim).toBe(512);
    const vector = await embedder.embedQuery('dim from env');
    expect(vector).toHaveLength(512);
  });
});

describe('createEmbeddingsClient — fake arm (issue #204)', () => {
  it('returns a FakeEmbeddings instance when provider="fake"', async () => {
    const { createEmbeddingsClient, FakeEmbeddings } = await loadFresh({
      KB_FAKE_DIM: '64',
      // No API keys set — must not be required for the fake arm.
      HUGGINGFACE_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    });
    const client = await createEmbeddingsClient({ provider: 'fake', modelName: 'bag-256d' });
    expect(client).toBeInstanceOf(FakeEmbeddings);
    const v = await client.embedQuery('round-trip');
    expect(v).toHaveLength(64);
  });

  it('does not require any embedding API key', async () => {
    const { createEmbeddingsClient } = await loadFresh({
      HUGGINGFACE_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    });
    // Must not throw a PROVIDER_AUTH error.
    await expect(
      createEmbeddingsClient({ provider: 'fake', modelName: 'anything' }),
    ).resolves.toBeDefined();
  });
});

describe('embedding task prefixes (issue #567 — nomic-embed-text family)', () => {
  it('maps the nomic-embed-text family to search_query/search_document prefixes', async () => {
    const { embeddingTaskPrefixesFor } = await loadFresh({ KB_EMBEDDING_TASK_PREFIXES: undefined });
    const expected = { query: 'search_query: ', document: 'search_document: ' };
    expect(embeddingTaskPrefixesFor('ollama', 'nomic-embed-text')).toEqual(expected);
    expect(embeddingTaskPrefixesFor('ollama', 'nomic-embed-text:latest')).toEqual(expected);
    expect(embeddingTaskPrefixesFor('ollama', 'nomic-embed-text:v1.5')).toEqual(expected);
    expect(embeddingTaskPrefixesFor('ollama', 'nomic-embed-text-v2-moe')).toEqual(expected);
    expect(embeddingTaskPrefixesFor('huggingface', 'nomic-ai/nomic-embed-text-v1.5')).toEqual(expected);
  });

  it('returns null for models outside the nomic-embed-text family', async () => {
    const { embeddingTaskPrefixesFor } = await loadFresh({ KB_EMBEDDING_TASK_PREFIXES: undefined });
    expect(embeddingTaskPrefixesFor('ollama', 'dengcao/Qwen3-Embedding-0.6B:Q8_0')).toBeNull();
    expect(embeddingTaskPrefixesFor('ollama', 'mxbai-embed-large')).toBeNull();
    expect(embeddingTaskPrefixesFor('huggingface', 'BAAI/bge-small-en-v1.5')).toBeNull();
    expect(embeddingTaskPrefixesFor('openai', 'text-embedding-3-small')).toBeNull();
    // Guard against a substring match inside an unrelated org/model path.
    expect(embeddingTaskPrefixesFor('ollama', 'my-nomic-embed-text-clone')).toBeNull();
  });

  it('never prefixes the fake provider', async () => {
    const { embeddingTaskPrefixesFor } = await loadFresh({ KB_EMBEDDING_TASK_PREFIXES: undefined });
    expect(embeddingTaskPrefixesFor('fake', 'nomic-embed-text')).toBeNull();
  });

  it('honors the KB_EMBEDDING_TASK_PREFIXES kill switch', async () => {
    for (const off of ['0', 'false', 'off', 'no']) {
      const { embeddingTaskPrefixesFor } = await loadFresh({ KB_EMBEDDING_TASK_PREFIXES: off });
      expect(embeddingTaskPrefixesFor('ollama', 'nomic-embed-text')).toBeNull();
    }
    const { embeddingTaskPrefixesFor } = await loadFresh({ KB_EMBEDDING_TASK_PREFIXES: 'on' });
    expect(embeddingTaskPrefixesFor('ollama', 'nomic-embed-text')).not.toBeNull();
  });

  it('TaskPrefixedEmbeddings prepends the document prefix per text and preserves order', async () => {
    const { TaskPrefixedEmbeddings } = await loadFresh({});
    const seen: string[][] = [];
    const inner = {
      async embedDocuments(texts: string[]): Promise<number[][]> {
        seen.push(texts);
        return texts.map((_, index) => [index]);
      },
      async embedQuery(): Promise<number[]> {
        throw new Error('embedQuery must not be used for documents');
      },
    };
    const wrapped = new TaskPrefixedEmbeddings(inner, {
      query: 'search_query: ',
      document: 'search_document: ',
    });
    const vectors = await wrapped.embedDocuments(['alpha', 'beta']);
    expect(seen).toEqual([['search_document: alpha', 'search_document: beta']]);
    expect(vectors).toEqual([[0], [1]]);
  });

  it('TaskPrefixedEmbeddings prepends the query prefix on embedQuery', async () => {
    const { TaskPrefixedEmbeddings } = await loadFresh({});
    const seen: string[] = [];
    const inner = {
      async embedDocuments(): Promise<number[][]> {
        throw new Error('embedDocuments must not be used for queries');
      },
      async embedQuery(text: string): Promise<number[]> {
        seen.push(text);
        return [42];
      },
    };
    const wrapped = new TaskPrefixedEmbeddings(inner, {
      query: 'search_query: ',
      document: 'search_document: ',
    });
    await expect(wrapped.embedQuery('what is faiss?')).resolves.toEqual([42]);
    expect(seen).toEqual(['search_query: what is faiss?']);
  });

  it('createEmbeddingsClient wraps the ollama nomic arm in TaskPrefixedEmbeddings', async () => {
    const { createEmbeddingsClient, TaskPrefixedEmbeddings } = await loadFresh({
      KB_EMBEDDING_TASK_PREFIXES: undefined,
    });
    // Construction only — OllamaEmbeddings does not touch the network here.
    const client = await createEmbeddingsClient({ provider: 'ollama', modelName: 'nomic-embed-text' });
    expect(client).toBeInstanceOf(TaskPrefixedEmbeddings);
  });

  it('createEmbeddingsClient leaves other ollama models unwrapped', async () => {
    const { createEmbeddingsClient, TaskPrefixedEmbeddings } = await loadFresh({
      KB_EMBEDDING_TASK_PREFIXES: undefined,
    });
    const client = await createEmbeddingsClient({
      provider: 'ollama',
      modelName: 'dengcao/Qwen3-Embedding-0.6B:Q8_0',
    });
    expect(client).not.toBeInstanceOf(TaskPrefixedEmbeddings);
  });

  it('createEmbeddingsClient leaves nomic unwrapped when the kill switch is off', async () => {
    const { createEmbeddingsClient, TaskPrefixedEmbeddings } = await loadFresh({
      KB_EMBEDDING_TASK_PREFIXES: 'off',
    });
    const client = await createEmbeddingsClient({ provider: 'ollama', modelName: 'nomic-embed-text' });
    expect(client).not.toBeInstanceOf(TaskPrefixedEmbeddings);
  });

  it('telemetry records calls made through the prefix wrapper (issue #210 interaction)', async () => {
    const { createEmbeddingsClient, TaskPrefixedEmbeddings } = await loadFresh({
      KB_EMBEDDING_TASK_PREFIXES: undefined,
    });
    const { ProviderCallMetrics } = await import('./metrics.js');
    const metrics = new ProviderCallMetrics({ now: () => 0 });
    const client = await createEmbeddingsClient({
      provider: 'ollama',
      modelName: 'nomic-embed-text',
      modelId: 'ollama__nomic-embed-text',
      metrics,
    });
    expect(client).toBeInstanceOf(TaskPrefixedEmbeddings);
    // Stub the inner provider so no network is involved; the instrumented
    // surface is the wrapper, so the counter must still tick.
    const wrapper = client as InstanceType<typeof TaskPrefixedEmbeddings> & {
      embedQuery(text: string): Promise<number[]>;
    };
    const inner = (wrapper as unknown as { inner: { embedQuery(text: string): Promise<number[]> } }).inner;
    inner.embedQuery = async () => [1];
    await wrapper.embedQuery('hello');
    expect(metrics.snapshot()['ollama__nomic-embed-text'].count).toBe(1);
  });
});

describe('createEmbeddingsClient — provider call telemetry (issue #210)', () => {
  it('does not record telemetry when modelId is omitted', async () => {
    const { createEmbeddingsClient } = await loadFresh({ KB_FAKE_DIM: '32' });
    const { ProviderCallMetrics } = await import('./metrics.js');
    const metrics = new ProviderCallMetrics({ now: () => 0 });
    const client = await createEmbeddingsClient({
      provider: 'fake',
      modelName: 'untracked',
      metrics,
    });
    await client.embedQuery('hi');
    expect(metrics.snapshot()).toEqual({});
  });

  it('records every embedQuery and embedDocuments call under the supplied modelId', async () => {
    const { createEmbeddingsClient } = await loadFresh({ KB_FAKE_DIM: '16' });
    const { ProviderCallMetrics } = await import('./metrics.js');
    const metrics = new ProviderCallMetrics({ now: () => 0 });
    const client = await createEmbeddingsClient({
      provider: 'fake',
      modelName: 'tracked',
      modelId: 'fake__tracked',
      metrics,
    });
    await client.embedQuery('one');
    await client.embedQuery('two');
    await client.embedDocuments(['a', 'b', 'c']);
    const snap = metrics.snapshot();
    expect(snap['fake__tracked'].count).toBe(3);
    expect(snap['fake__tracked'].errors).toBe(0);
    expect(snap['fake__tracked'].tokens_in).toBeNull();
  });
});
