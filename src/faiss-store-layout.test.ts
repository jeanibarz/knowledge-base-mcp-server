import {
  EMBEDDING_CANARY_ID,
  EMBEDDING_CANARY_TEXT_SHA256,
  cosineSimilarity,
  createEmbeddingCanaryFingerprint,
} from './faiss-store-layout.js';

describe('embedding canary fingerprint', () => {
  it('captures the fixed document canary vector with a stable identity', async () => {
    const embeddings = {
      embedDocuments: jest.fn(async (texts: string[]) => texts.map(() => [0.6, 0.8])),
    };

    const fingerprint = await createEmbeddingCanaryFingerprint(
      embeddings,
      new Date('2026-06-13T00:00:00.000Z'),
    );

    expect(embeddings.embedDocuments).toHaveBeenCalledWith([
      expect.stringContaining('kb embedding canary v1'),
    ]);
    expect(fingerprint).toEqual({
      canary_id: EMBEDDING_CANARY_ID,
      text_sha256: EMBEDDING_CANARY_TEXT_SHA256,
      embedding_role: 'document',
      captured_at: '2026-06-13T00:00:00.000Z',
      dimensions: 2,
      vector: [0.6, 0.8],
    });
  });

  it('rejects missing and non-finite canary vectors', async () => {
    await expect(
      createEmbeddingCanaryFingerprint({
        embedDocuments: async () => [],
      }),
    ).rejects.toThrow(/no vector/);

    await expect(
      createEmbeddingCanaryFingerprint({
        embedDocuments: async () => [[1, Number.NaN]],
      }),
    ).rejects.toThrow(/non-finite/);
  });
});

describe('cosineSimilarity', () => {
  it('returns cosine similarity for equal-length finite vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns null for incompatible vectors', () => {
    expect(cosineSimilarity([], [])).toBeNull();
    expect(cosineSimilarity([1], [1, 2])).toBeNull();
    expect(cosineSimilarity([0, 0], [1, 2])).toBeNull();
    expect(cosineSimilarity([1, Infinity], [1, 2])).toBeNull();
  });
});
