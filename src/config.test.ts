import { parseReindexTriggerPollMs } from './config.js';

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
