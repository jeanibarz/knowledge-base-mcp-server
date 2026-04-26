// Issue #107 — auto-clamp the bench fixture's chunk size so it fits the
// smallest-context embedding model in a `bench:compare` run.
//
// The shared corpus must produce identical chunks for both legs (otherwise
// Jaccard / Spearman across models becomes a chunking-policy comparison rather
// than an embedding-quality comparison). So we clamp chunk size to the *min*
// of the two models' contexts, not per-model.
//
// Math: chunk_chars = floor(min_ctx * 0.7 * chars_per_token)
//   - 0.7 = safety margin (BPE drift, prompts, special tokens)
//   - chars_per_token = 2: this is conservative on purpose. English prose
//     averages ~4 chars/token for embedding BPE, but the bench's synthetic
//     fixture tokens (`token-0042` style) and identifier-heavy real-world
//     corpora tokenize closer to 2 chars/token. Using 2 here keeps the
//     fixture safe across both; operators with prose-only KBs who hit the
//     resulting chunk size as a constraint can override via
//     BENCH_FIXTURE_CHUNK_CHARS=N.
//
// Result is also capped at DEFAULT_CHUNK_CHARS so the auto-clamp can only
// shrink chunks vs. the pre-#107 default; an operator who wants larger chunks
// can override via BENCH_FIXTURE_CHUNK_CHARS.

type EmbeddingProvider = 'huggingface' | 'ollama' | 'openai' | 'stub';

export const DEFAULT_CHUNK_CHARS = 1000;
export const DEFAULT_FALLBACK_CTX = 512;

const SAFETY_MARGIN = 0.7;
const CHARS_PER_TOKEN = 2;

// Lookup table for non-Ollama providers. Ollama models are probed live via
// /api/show; HF + OpenAI ctx values come from this table. Unknown models fall
// back to DEFAULT_FALLBACK_CTX (512) — small enough that the default 1000-char
// chunks would still bust some models, so the clamp kicks in.
export const COMMON_MODEL_CTX: Record<string, number> = {
  // OpenAI
  'text-embedding-3-small': 8192,
  'text-embedding-3-large': 8192,
  'text-embedding-ada-002': 8192,
  // HuggingFace (sentence-transformers + BAAI)
  'BAAI/bge-small-en-v1.5': 512,
  'BAAI/bge-m3': 8192,
  'sentence-transformers/all-MiniLM-L6-v2': 512,
  'sentence-transformers/all-mpnet-base-v2': 514,
};

/**
 * Compute a chunk_chars value that fits inside the smaller of two model
 * contexts, with a 30% safety margin. Caps at DEFAULT_CHUNK_CHARS so the clamp
 * never *increases* chunk size vs. the pre-#107 default — operators who want
 * larger chunks override BENCH_FIXTURE_CHUNK_CHARS directly.
 *
 * Defensive: 0 / negative / non-finite inputs return DEFAULT_CHUNK_CHARS (the
 * probe failed; better to keep the existing default than emit chunkSize=0).
 */
export function safeChunkChars(ctxA: number, ctxB: number): number {
  if (!isFiniteCtx(ctxA) || !isFiniteCtx(ctxB)) {
    return DEFAULT_CHUNK_CHARS;
  }
  const minCtx = Math.min(ctxA, ctxB);
  const computed = Math.floor(minCtx * SAFETY_MARGIN * CHARS_PER_TOKEN);
  if (computed <= 0) return DEFAULT_CHUNK_CHARS;
  return Math.min(computed, DEFAULT_CHUNK_CHARS);
}

function isFiniteCtx(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/**
 * Resolve a model's context length. For Ollama, probes /api/show; for
 * HF/OpenAI, looks up COMMON_MODEL_CTX. On any failure (probe error, unknown
 * model, malformed response), warns to stderr and returns DEFAULT_FALLBACK_CTX
 * — never throws, never blocks the orchestrator.
 */
export async function resolveModelCtx(
  provider: EmbeddingProvider,
  modelName: string,
  ollamaBaseUrl?: string,
): Promise<number> {
  if (provider === 'ollama') {
    return await probeOllamaCtx(modelName, ollamaBaseUrl ?? defaultOllamaBaseUrl());
  }
  if (provider === 'huggingface' || provider === 'openai') {
    const hit = COMMON_MODEL_CTX[modelName];
    if (typeof hit === 'number' && hit > 0) return hit;
    process.stderr.write(
      `[bench:compare] num_ctx unknown for ${provider}:${modelName}; falling back to ${DEFAULT_FALLBACK_CTX}. ` +
      `Set BENCH_FIXTURE_CHUNK_CHARS=N to override.\n`,
    );
    return DEFAULT_FALLBACK_CTX;
  }
  // 'stub' or any other provider — no probe, no warning (stub bench runs
  // happen in CI smoke tests with synthetic embeddings; ctx is irrelevant).
  return DEFAULT_FALLBACK_CTX;
}

function defaultOllamaBaseUrl(): string {
  return process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
}

/**
 * POST /api/show against a local Ollama daemon and extract num_ctx.
 *
 * Ollama exposes two context-related values per model and they can disagree:
 *   - `parameters` (text blob, e.g. "num_ctx                        256") —
 *     the *runtime* context window the daemon enforces at embed time.
 *   - `model_info.<arch>.context_length` (number, e.g. 512) — the architecture's
 *     trained max, which can be larger than the modelfile's runtime cap.
 *
 * The runtime `num_ctx` is what `/api/embed` actually checks, so we read that
 * first. If `parameters` is missing or doesn't carry `num_ctx`, fall back to
 * `model_info.<arch>.context_length` (still better than nothing). If both are
 * absent, the caller's fallback (DEFAULT_FALLBACK_CTX) kicks in.
 *
 * Concretely: pre-fix, all-minilm reported 512 via model_info despite a
 * runtime cap of 256, and the chunk-size clamp produced chunks that still
 * busted the embed path. Reading parameters first fixes that. (#107 follow-up.)
 */
export async function probeOllamaCtx(modelName: string, baseUrl: string): Promise<number> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/show`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelName }),
    });
    if (!response.ok) {
      warnOllamaProbeFail(modelName, `HTTP ${response.status}`);
      return DEFAULT_FALLBACK_CTX;
    }
    const body = await response.json() as {
      model_info?: Record<string, unknown>;
      parameters?: string;
    };
    const runtime = parseRuntimeNumCtx(body.parameters);
    if (runtime !== null) return runtime;
    const arch = extractContextLength(body.model_info);
    if (arch !== null) return arch;
    warnOllamaProbeFail(modelName, 'no num_ctx in parameters or context_length in model_info');
    return DEFAULT_FALLBACK_CTX;
  } catch (err) {
    warnOllamaProbeFail(modelName, err instanceof Error ? err.message : String(err));
    return DEFAULT_FALLBACK_CTX;
  }
}

/**
 * Parse Ollama's `parameters` text blob for `num_ctx`. Each line is a
 * whitespace-separated key/value: `num_ctx                        256`.
 * Returns null if the field is missing or unparseable.
 */
export function parseRuntimeNumCtx(parameters: string | undefined): number | null {
  if (!parameters) return null;
  // ^\s* anchors at line start; the value is the first whitespace-separated
  // token after `num_ctx`. /m so ^ matches each line.
  const match = parameters.match(/^\s*num_ctx\s+(\d+)/m);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function extractContextLength(modelInfo: Record<string, unknown> | undefined): number | null {
  if (!modelInfo) return null;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith('.context_length') && typeof value === 'number' && value > 0) {
      return value;
    }
  }
  return null;
}

function warnOllamaProbeFail(modelName: string, reason: string): void {
  process.stderr.write(
    `[bench:compare] Ollama /api/show probe failed for ${modelName}: ${reason}; ` +
    `falling back to ${DEFAULT_FALLBACK_CTX}. ` +
    `Set BENCH_FIXTURE_CHUNK_CHARS=N to override.\n`,
  );
}
