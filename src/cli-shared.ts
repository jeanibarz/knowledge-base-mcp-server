import { FaissIndexManager } from './FaissIndexManager.js';
import { parseModelId, readStoredModelName } from './active-model.js';
import type { EmbeddingProvider } from './model-id.js';
import { logger } from './logger.js';

/**
 * RFC 013: load a FaissIndexManager for the given model_id. Resolves the
 * (provider, modelName) pair from the model's `model_name.txt` so the
 * manager can instantiate the right embeddings client. The 0.2.x model-
 * mismatch check is obsolete under multi-model: each model has its own
 * dir, and the active resolver fails-fast on missing/malformed state.
 */
export async function loadManagerForModel(modelId: string): Promise<FaissIndexManager> {
  const { provider } = parseModelId(modelId);
  const modelName = await readStoredModelName(modelId);
  if (modelName === null) {
    throw new Error(`model_name.txt missing for "${modelId}" — corrupt model directory`);
  }
  return new FaissIndexManager({
    provider: provider as EmbeddingProvider,
    modelName,
  });
}

export async function loadWithJsonRetry(manager: FaissIndexManager): Promise<void> {
  // Pre-RFC-014 defensive belt for the LEGACY `faiss.index/` load path only.
  // The versioned `index -> index.vN/` layout pre-resolves the symlink before
  // any file open, so torn JSON is structurally impossible there.
  const isJsonParseError = (err: unknown): boolean =>
    err instanceof SyntaxError ||
    /JSON|unexpected|parse/i.test((err as Error)?.message ?? '');

  try {
    await manager.initialize({ readOnly: true });
    return;
  } catch (err) {
    if (!isJsonParseError(err)) throw err;
    logger.warn('kb search: JSON parse error on FAISS load (likely concurrent writer); retrying in 100ms');
  }
  await new Promise((r) => setTimeout(r, 100));
  try {
    await manager.initialize({ readOnly: true });
  } catch (err) {
    if (isJsonParseError(err)) {
      throw new Error(
        `Index appears to be mid-write (concurrent writer is updating it). ` +
        `Please retry in a moment. Underlying error: ${(err as Error).message}`,
      );
    }
    throw err;
  }
}
