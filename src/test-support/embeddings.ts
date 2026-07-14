import type { EmbeddingsInterface } from '@langchain/core/embeddings';

export type MockEmbeddingsOverrides = Partial<EmbeddingsInterface>;

/**
 * Shared test double for LangChain embeddings.
 *
 * Keep the returned object constrained to the production interface so a
 * contract change fails in this one helper instead of at runtime in a suite.
 * Individual suites can override either method when they need call tracking,
 * fault injection, or input-dependent vectors.
 */
export function createMockEmbeddings(overrides: MockEmbeddingsOverrides = {}): EmbeddingsInterface {
  const embeddings = {
    embedDocuments: overrides.embedDocuments ?? (async (texts: string[]): Promise<number[][]> =>
      texts.map(() => [1, 0, 0])),
    embedQuery: overrides.embedQuery ?? (async (_text: string): Promise<number[]> => [1, 0, 0]),
  } satisfies EmbeddingsInterface;

  return embeddings;
}
