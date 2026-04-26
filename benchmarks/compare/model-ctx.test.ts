import {
  COMMON_MODEL_CTX,
  DEFAULT_CHUNK_CHARS,
  DEFAULT_FALLBACK_CTX,
  parseRuntimeNumCtx,
  safeChunkChars,
} from './model-ctx.js';

describe('safeChunkChars', () => {
  it('both ctx >= 8192: returns DEFAULT_CHUNK_CHARS (no clamp needed)', () => {
    // min(8192,8192)*0.7*2 = 11468, capped at default 1000
    expect(safeChunkChars(8192, 8192)).toBe(DEFAULT_CHUNK_CHARS);
  });

  it('one short, one long ctx: clamps to fit the smaller (256, 8192) → 358', () => {
    // floor(256 * 0.7 * 2) = floor(358.4) = 358
    expect(safeChunkChars(256, 8192)).toBe(358);
    expect(safeChunkChars(8192, 256)).toBe(358);
  });

  it('both ctx = 512: floor(512*0.7*2)=716 (passes through; below default cap)', () => {
    // floor(512 * 0.7 * 2) = floor(716.8) = 716. Two 512-ctx models get a
    // smaller chunk size than the pre-#107 default — safer for short-context
    // pairings.
    expect(safeChunkChars(512, 512)).toBe(716);
  });

  it('zero or negative input: returns DEFAULT_CHUNK_CHARS (defensive)', () => {
    expect(safeChunkChars(0, 8192)).toBe(DEFAULT_CHUNK_CHARS);
    expect(safeChunkChars(8192, 0)).toBe(DEFAULT_CHUNK_CHARS);
    expect(safeChunkChars(-1, 8192)).toBe(DEFAULT_CHUNK_CHARS);
    expect(safeChunkChars(NaN, 8192)).toBe(DEFAULT_CHUNK_CHARS);
    expect(safeChunkChars(Infinity, 8192)).toBe(DEFAULT_CHUNK_CHARS);
  });

  it('256 vs 256: floor(256*0.7*2)=358 (no cap; below default)', () => {
    expect(safeChunkChars(256, 256)).toBe(358);
  });
});

describe('COMMON_MODEL_CTX', () => {
  it('covers OpenAI embedding models the issue lists', () => {
    expect(COMMON_MODEL_CTX['text-embedding-3-small']).toBe(8192);
    expect(COMMON_MODEL_CTX['text-embedding-3-large']).toBe(8192);
    expect(COMMON_MODEL_CTX['text-embedding-ada-002']).toBe(8192);
  });

  it('covers HuggingFace bge + sentence-transformers entries', () => {
    expect(COMMON_MODEL_CTX['BAAI/bge-small-en-v1.5']).toBe(512);
    expect(COMMON_MODEL_CTX['BAAI/bge-m3']).toBe(8192);
    expect(COMMON_MODEL_CTX['sentence-transformers/all-MiniLM-L6-v2']).toBe(512);
    expect(COMMON_MODEL_CTX['sentence-transformers/all-mpnet-base-v2']).toBe(514);
  });

  it('exposes a sane default fallback ctx', () => {
    expect(DEFAULT_FALLBACK_CTX).toBe(512);
  });
});

describe('parseRuntimeNumCtx', () => {
  it('parses the canonical Ollama parameters format (whitespace-padded)', () => {
    // Real /api/show output for all-minilm:latest (#107 follow-up).
    const params = 'num_ctx                        256\n';
    expect(parseRuntimeNumCtx(params)).toBe(256);
  });

  it('parses 8192 from a multi-line parameters blob', () => {
    // Real /api/show output for nomic-embed-text:latest.
    const params = [
      'num_ctx                        8192',
      'stop                           "<|endoftext|>"',
      '',
    ].join('\n');
    expect(parseRuntimeNumCtx(params)).toBe(8192);
  });

  it('returns null when num_ctx is absent', () => {
    expect(parseRuntimeNumCtx('temperature 0.8\nstop "X"\n')).toBeNull();
  });

  it('returns null on undefined / empty input', () => {
    expect(parseRuntimeNumCtx(undefined)).toBeNull();
    expect(parseRuntimeNumCtx('')).toBeNull();
  });

  it('returns null when num_ctx value is not a positive integer', () => {
    expect(parseRuntimeNumCtx('num_ctx 0\n')).toBeNull();
    expect(parseRuntimeNumCtx('num_ctx not-a-number\n')).toBeNull();
  });

  it('matches num_ctx anywhere in the multi-line blob, not just the first line', () => {
    const params = 'temperature 0.7\nnum_ctx 4096\nstop "."\n';
    expect(parseRuntimeNumCtx(params)).toBe(4096);
  });
});
