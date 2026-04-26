import { COMMON_MODEL_CTX, DEFAULT_CHUNK_CHARS, DEFAULT_FALLBACK_CTX, safeChunkChars } from './model-ctx.js';

describe('safeChunkChars', () => {
  it('both ctx >= 8192: returns DEFAULT_CHUNK_CHARS (no clamp needed)', () => {
    // min(8192,8192)*0.7*3 = 17203, capped at default 1000
    expect(safeChunkChars(8192, 8192)).toBe(DEFAULT_CHUNK_CHARS);
  });

  it('one short, one long ctx: clamps to fit the smaller (256, 8192) → 537', () => {
    // floor(256 * 0.7 * 3) = floor(537.6) = 537
    expect(safeChunkChars(256, 8192)).toBe(537);
    expect(safeChunkChars(8192, 256)).toBe(537);
  });

  it('both ctx = 512: floor(512*0.7*3)=1075 caps at DEFAULT_CHUNK_CHARS', () => {
    // Per design: the clamp never increases chunk size beyond the pre-#107
    // default. Operators who want larger chunks set BENCH_FIXTURE_CHUNK_CHARS.
    expect(safeChunkChars(512, 512)).toBe(DEFAULT_CHUNK_CHARS);
  });

  it('zero or negative input: returns DEFAULT_CHUNK_CHARS (defensive)', () => {
    expect(safeChunkChars(0, 8192)).toBe(DEFAULT_CHUNK_CHARS);
    expect(safeChunkChars(8192, 0)).toBe(DEFAULT_CHUNK_CHARS);
    expect(safeChunkChars(-1, 8192)).toBe(DEFAULT_CHUNK_CHARS);
    expect(safeChunkChars(NaN, 8192)).toBe(DEFAULT_CHUNK_CHARS);
    expect(safeChunkChars(Infinity, 8192)).toBe(DEFAULT_CHUNK_CHARS);
  });

  it('256 vs 256: floor(256*0.7*3)=537 (no cap; below default)', () => {
    expect(safeChunkChars(256, 256)).toBe(537);
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
