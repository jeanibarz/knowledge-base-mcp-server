import { EMBEDDING_PROVIDER } from './provider.js';

// ---------------------------------------------------------------------------
// Indexing batch configuration (RFC 007 section6.2 / issue #236).
// ---------------------------------------------------------------------------

const DEFAULT_INDEXING_BATCH_SIZE = 64;
const DEFAULT_OLLAMA_INDEXING_BATCH_SIZE = 16;
const MAX_INDEXING_BATCH_SIZE = 512;

export function resolveIndexingBatchSize(
  provider: string = EMBEDDING_PROVIDER,
): number {
  const defaultForProvider = provider === 'ollama'
    ? DEFAULT_OLLAMA_INDEXING_BATCH_SIZE
    : DEFAULT_INDEXING_BATCH_SIZE;
  const raw = process.env.INDEXING_BATCH_SIZE;
  if (raw === undefined || raw.trim() === '') {
    return defaultForProvider;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultForProvider;
  }
  return Math.min(MAX_INDEXING_BATCH_SIZE, Math.max(1, Math.floor(parsed)));
}

export const INDEXING_BATCH_SIZE: number = resolveIndexingBatchSize();

// ---------------------------------------------------------------------------
// Chunking configuration (#107 follow-up).
// ---------------------------------------------------------------------------

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 200;

/**
 * Resolve the splitter chunk size and overlap from env vars, with the
 * historical defaults preserved when nothing is set. `KB_CHUNK_SIZE` lets
 * operators tune the splitter for short-context embedding models without
 * editing source - when `bench:compare` (#107) auto-clamps for a short-ctx
 * leg, it sets this so the production code path emits chunks small enough
 * to fit. `KB_CHUNK_OVERLAP` is honored independently when set; otherwise
 * it scales as `floor(chunkSize / 5)` so the previous 1000/200 ratio
 * (chunkSize=1000 -> overlap=200) holds at the default.
 */
export function resolveChunkSize(): { chunkSize: number; chunkOverlap: number } {
  const sizeRaw = process.env.KB_CHUNK_SIZE;
  const overlapRaw = process.env.KB_CHUNK_OVERLAP;
  const sizeParsed = sizeRaw ? Number(sizeRaw) : NaN;
  const chunkSize = Number.isFinite(sizeParsed) && sizeParsed > 0
    ? Math.floor(sizeParsed)
    : DEFAULT_CHUNK_SIZE;
  const overlapParsed = overlapRaw ? Number(overlapRaw) : NaN;
  const chunkOverlap = Number.isFinite(overlapParsed) && overlapParsed >= 0
    ? Math.floor(overlapParsed)
    : (chunkSize === DEFAULT_CHUNK_SIZE ? DEFAULT_CHUNK_OVERLAP : Math.floor(chunkSize / 5));
  return { chunkSize, chunkOverlap };
}
