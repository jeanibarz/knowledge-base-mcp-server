import { EMBEDDING_PROVIDER } from './provider.js';

// ---------------------------------------------------------------------------
// Indexing batch configuration (RFC 007 section6.2 / issue #236).
// ---------------------------------------------------------------------------

export const DEFAULT_INDEXING_BATCH_SIZE = 64;
export const DEFAULT_OLLAMA_INDEXING_BATCH_SIZE = 16;
export const DEFAULT_INDEXING_CONCURRENCY = 1;
const MAX_INDEXING_BATCH_SIZE = 512;
const MAX_INDEXING_CONCURRENCY = 4;
export const KB_INDEX_TYPE_ENV = 'KB_INDEX_TYPE';
export const KB_INDEXING_CONCURRENCY_ENV = 'KB_INDEXING_CONCURRENCY';
export type FaissIndexType = 'flat' | 'sq8';
export const KB_FLAT_SEARCH_P95_ADVISORY_MS_ENV = 'KB_FLAT_SEARCH_P95_ADVISORY_MS';
export const DEFAULT_FLAT_SEARCH_P95_ADVISORY_MS = 50;

export function resolveIndexingBatchSize(
  provider: string = EMBEDDING_PROVIDER,
): number {
  const defaultForProvider = defaultIndexingBatchSize(provider);
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

export function resolveIndexingConcurrency(
  provider: string = EMBEDDING_PROVIDER,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): number {
  const raw = env[KB_INDEXING_CONCURRENCY_ENV];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_INDEXING_CONCURRENCY;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_INDEXING_CONCURRENCY;
  }

  const requested = Math.min(MAX_INDEXING_CONCURRENCY, Math.max(1, Math.floor(parsed)));
  if (provider !== 'ollama' || requested === 1) {
    return requested;
  }

  const ollamaParallelRaw = env.OLLAMA_NUM_PARALLEL;
  const ollamaParallel = ollamaParallelRaw === undefined ? NaN : Number(ollamaParallelRaw);
  if (!Number.isFinite(ollamaParallel) || ollamaParallel <= 1) {
    return DEFAULT_INDEXING_CONCURRENCY;
  }
  return Math.min(requested, Math.floor(ollamaParallel));
}

export function defaultIndexingBatchSize(provider: string): number {
  return provider === 'ollama'
    ? DEFAULT_OLLAMA_INDEXING_BATCH_SIZE
    : DEFAULT_INDEXING_BATCH_SIZE;
}

export function resolveFaissIndexType(
  raw: string | undefined = process.env[KB_INDEX_TYPE_ENV],
): FaissIndexType {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') return 'flat';
  if (normalized === 'flat' || normalized === 'sq8') return normalized;
  return 'flat';
}

export function resolveFlatSearchP95AdvisoryMs(
  raw: string | undefined = process.env[KB_FLAT_SEARCH_P95_ADVISORY_MS_ENV],
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_FLAT_SEARCH_P95_ADVISORY_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FLAT_SEARCH_P95_ADVISORY_MS;
  return Math.floor(parsed);
}

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
