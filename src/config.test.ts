import { parseReindexTriggerPollMs, resolveChunkSize } from './config.js';

describe('resolveChunkSize (#107 follow-up — KB_CHUNK_SIZE / KB_CHUNK_OVERLAP env vars)', () => {
  const savedSize = process.env.KB_CHUNK_SIZE;
  const savedOverlap = process.env.KB_CHUNK_OVERLAP;

  afterEach(() => {
    if (savedSize === undefined) delete process.env.KB_CHUNK_SIZE; else process.env.KB_CHUNK_SIZE = savedSize;
    if (savedOverlap === undefined) delete process.env.KB_CHUNK_OVERLAP; else process.env.KB_CHUNK_OVERLAP = savedOverlap;
  });

  it('returns historical defaults (1000 / 200) when no env vars are set', () => {
    delete process.env.KB_CHUNK_SIZE;
    delete process.env.KB_CHUNK_OVERLAP;
    expect(resolveChunkSize()).toEqual({ chunkSize: 1000, chunkOverlap: 200 });
  });

  it('honors KB_CHUNK_SIZE; overlap scales as floor(chunkSize/5)', () => {
    process.env.KB_CHUNK_SIZE = '358';
    delete process.env.KB_CHUNK_OVERLAP;
    expect(resolveChunkSize()).toEqual({ chunkSize: 358, chunkOverlap: 71 });
  });

  it('honors an independent KB_CHUNK_OVERLAP', () => {
    process.env.KB_CHUNK_SIZE = '500';
    process.env.KB_CHUNK_OVERLAP = '50';
    expect(resolveChunkSize()).toEqual({ chunkSize: 500, chunkOverlap: 50 });
  });

  it('falls back to default 200 overlap when KB_CHUNK_SIZE is the default 1000 and overlap unset', () => {
    process.env.KB_CHUNK_SIZE = '1000';
    delete process.env.KB_CHUNK_OVERLAP;
    expect(resolveChunkSize()).toEqual({ chunkSize: 1000, chunkOverlap: 200 });
  });

  it('treats invalid / non-positive values as unset (preserves defaults)', () => {
    process.env.KB_CHUNK_SIZE = 'not-a-number';
    process.env.KB_CHUNK_OVERLAP = '-1';
    expect(resolveChunkSize()).toEqual({ chunkSize: 1000, chunkOverlap: 200 });
  });

  it('accepts zero overlap explicitly', () => {
    process.env.KB_CHUNK_SIZE = '500';
    process.env.KB_CHUNK_OVERLAP = '0';
    expect(resolveChunkSize()).toEqual({ chunkSize: 500, chunkOverlap: 0 });
  });
});

describe('parseReindexTriggerPollMs (RFC 011 §5.5)', () => {
  it('returns the default (5000) for undefined or empty input', () => {
    expect(parseReindexTriggerPollMs(undefined)).toBe(5000);
    expect(parseReindexTriggerPollMs('')).toBe(5000);
    expect(parseReindexTriggerPollMs('   ')).toBe(5000);
  });

  it('preserves 0 as the disabled-sentinel (does not clamp up to MIN)', () => {
    // Operators who set `REINDEX_TRIGGER_POLL_MS=0` expect the watcher
    // off. Rounding up to 1000 would silently re-enable it.
    expect(parseReindexTriggerPollMs('0')).toBe(0);
  });

  it('clamps small positive values up to MIN (1000)', () => {
    expect(parseReindexTriggerPollMs('1')).toBe(1000);
    expect(parseReindexTriggerPollMs('500')).toBe(1000);
    expect(parseReindexTriggerPollMs('999')).toBe(1000);
    // Fractional inputs round and then clamp.
    expect(parseReindexTriggerPollMs('1.5')).toBe(1000);
  });

  it('clamps large values down to MAX (60000)', () => {
    expect(parseReindexTriggerPollMs('60001')).toBe(60000);
    expect(parseReindexTriggerPollMs('999999')).toBe(60000);
  });

  it('accepts scientific notation', () => {
    // Number('1e3') === 1000 — accepted exactly, no clamp triggered.
    expect(parseReindexTriggerPollMs('1e3')).toBe(1000);
    expect(parseReindexTriggerPollMs('6e4')).toBe(60000);
  });

  it('falls back to the default on non-numeric and negative input', () => {
    expect(parseReindexTriggerPollMs('abc')).toBe(5000);
    expect(parseReindexTriggerPollMs('-5')).toBe(5000);
    expect(parseReindexTriggerPollMs('-0.1')).toBe(5000);
    // NaN / Infinity
    expect(parseReindexTriggerPollMs('NaN')).toBe(5000);
    expect(parseReindexTriggerPollMs('Infinity')).toBe(5000);
  });

  it('rounds fractional in-range values to an integer', () => {
    expect(parseReindexTriggerPollMs('1500.7')).toBe(1501);
    expect(parseReindexTriggerPollMs('59999.4')).toBe(59999);
  });
});
