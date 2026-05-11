import { afterEach, describe, expect, it, jest } from '@jest/globals';

const originalEnv = {
  EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
  KB_FAKE_DIM: process.env.KB_FAKE_DIM,
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
