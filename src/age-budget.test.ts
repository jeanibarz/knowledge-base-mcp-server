import { describe, expect, it } from '@jest/globals';
import {
  AgeBudgetConfigError,
  computeAgeBudgetStatus,
  formatAgeBudgetBreachRow,
  formatAgeHours,
  kbNameToEnvSuffix,
  resolveAgeBudgetHours,
} from './age-budget.js';

describe('kbNameToEnvSuffix', () => {
  it('upper-cases ASCII KB names', () => {
    expect(kbNameToEnvSuffix('work')).toBe('WORK');
    expect(kbNameToEnvSuffix('Work_KB')).toBe('WORK_KB');
  });

  it('replaces non-[A-Z0-9_] characters with underscores', () => {
    expect(kbNameToEnvSuffix('rfcs-archived')).toBe('RFCS_ARCHIVED');
    expect(kbNameToEnvSuffix('post.mortems')).toBe('POST_MORTEMS');
    expect(kbNameToEnvSuffix('alpha beta')).toBe('ALPHA_BETA');
  });

  it('NFC-normalises before upper-casing', () => {
    // "café" composed (NFC) and decomposed (NFD) should map to the same suffix.
    const composed = 'café';
    const decomposed = 'café';
    expect(kbNameToEnvSuffix(composed)).toBe(kbNameToEnvSuffix(decomposed));
  });
});

describe('resolveAgeBudgetHours', () => {
  it('returns null when neither per-KB nor global var is set', () => {
    expect(resolveAgeBudgetHours('work', {})).toBeNull();
  });

  it('prefers the per-KB var over the global fallback', () => {
    const env = {
      KB_AGE_BUDGET_HOURS: '12',
      KB_AGE_BUDGET_HOURS_WORK: '24',
    };
    expect(resolveAgeBudgetHours('work', env)).toBe(24);
  });

  it('falls back to the global var when the per-KB var is unset', () => {
    expect(resolveAgeBudgetHours('work', { KB_AGE_BUDGET_HOURS: '48' })).toBe(48);
  });

  it('falls back to the global var when the per-KB var is set to empty string', () => {
    const env = {
      KB_AGE_BUDGET_HOURS: '48',
      KB_AGE_BUDGET_HOURS_WORK: '   ',
    };
    expect(resolveAgeBudgetHours('work', env)).toBe(48);
  });

  it('honours suffix normalisation for KB names with dashes / spaces', () => {
    const env = { KB_AGE_BUDGET_HOURS_RFCS_ARCHIVED: '720' };
    expect(resolveAgeBudgetHours('rfcs-archived', env)).toBe(720);
  });

  it.each([
    ['0', /must be a positive integer/],
    ['-1', /must be a positive integer/],
    ['12.5', /must be a positive integer/],
    ['abc', /must be a positive integer/],
  ])('rejects malformed per-KB value %p', (raw, pattern) => {
    expect(() => resolveAgeBudgetHours('work', { KB_AGE_BUDGET_HOURS_WORK: raw }))
      .toThrow(pattern);
  });

  it('throws an AgeBudgetConfigError carrying envVar + raw value', () => {
    let caught: unknown;
    try {
      resolveAgeBudgetHours('work', { KB_AGE_BUDGET_HOURS_WORK: '0' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgeBudgetConfigError);
    const err = caught as AgeBudgetConfigError;
    expect(err.code).toBe('KB_AGE_BUDGET_INVALID');
    expect(err.envVar).toBe('KB_AGE_BUDGET_HOURS_WORK');
    expect(err.rawValue).toBe('0');
  });

  it('rejects malformed global value even when no per-KB override is set', () => {
    expect(() => resolveAgeBudgetHours('work', { KB_AGE_BUDGET_HOURS: '0' }))
      .toThrow(/KB_AGE_BUDGET_HOURS/);
  });
});

describe('computeAgeBudgetStatus', () => {
  const nowMs = Date.parse('2026-05-11T12:00:00.000Z');

  it('returns no-breach when no budget is configured', () => {
    const status = computeAgeBudgetStatus('work', nowMs - 100 * 3_600_000, nowMs, {});
    expect(status).toEqual({
      kb: 'work',
      configuredHours: null,
      currentAgeHours: 100,
      breach: false,
    });
  });

  it('marks breach when current age exceeds the budget', () => {
    const lastIndexAtMs = nowMs - 47 * 3_600_000;
    const status = computeAgeBudgetStatus('work', lastIndexAtMs, nowMs, {
      KB_AGE_BUDGET_HOURS_WORK: '24',
    });
    expect(status).toEqual({
      kb: 'work',
      configuredHours: 24,
      currentAgeHours: 47,
      breach: true,
    });
  });

  it('does not mark breach when current age equals the budget (strict >)', () => {
    const lastIndexAtMs = nowMs - 24 * 3_600_000;
    const status = computeAgeBudgetStatus('work', lastIndexAtMs, nowMs, {
      KB_AGE_BUDGET_HOURS_WORK: '24',
    });
    expect(status.breach).toBe(false);
  });

  it('does not mark breach when current age is below the budget', () => {
    const lastIndexAtMs = nowMs - 12 * 3_600_000;
    const status = computeAgeBudgetStatus('work', lastIndexAtMs, nowMs, {
      KB_AGE_BUDGET_HOURS_WORK: '72',
    });
    expect(status.breach).toBe(false);
    expect(status.currentAgeHours).toBe(12);
  });

  it('treats never-indexed KBs as not-in-breach (null currentAgeHours)', () => {
    const status = computeAgeBudgetStatus('work', null, nowMs, {
      KB_AGE_BUDGET_HOURS_WORK: '24',
    });
    expect(status).toEqual({
      kb: 'work',
      configuredHours: 24,
      currentAgeHours: null,
      breach: false,
    });
  });

  it('clamps a future-dated last-index timestamp to age=0 (no negative ages)', () => {
    const lastIndexAtMs = nowMs + 10 * 3_600_000;
    const status = computeAgeBudgetStatus('work', lastIndexAtMs, nowMs, {
      KB_AGE_BUDGET_HOURS_WORK: '24',
    });
    expect(status.currentAgeHours).toBe(0);
    expect(status.breach).toBe(false);
  });
});

describe('formatAgeHours', () => {
  it('floors fractional hours for display', () => {
    expect(formatAgeHours(47.9)).toBe(47);
    expect(formatAgeHours(0.5)).toBe(0);
  });

  it('returns null when input is null', () => {
    expect(formatAgeHours(null)).toBeNull();
  });
});

describe('formatAgeBudgetBreachRow', () => {
  it('formats the breach row using the issue-spec template', () => {
    const row = formatAgeBudgetBreachRow({
      kb: 'work',
      configuredHours: 24,
      currentAgeHours: 47.9,
      breach: true,
    });
    expect(row).toBe('AGE_BUDGET_BREACH: kb=work, age=47h, budget=24h');
  });

  it('returns null when not in breach', () => {
    expect(
      formatAgeBudgetBreachRow({
        kb: 'work',
        configuredHours: 24,
        currentAgeHours: 12,
        breach: false,
      }),
    ).toBeNull();
  });

  it('returns null when never indexed (currentAgeHours=null)', () => {
    expect(
      formatAgeBudgetBreachRow({
        kb: 'work',
        configuredHours: 24,
        currentAgeHours: null,
        breach: false,
      }),
    ).toBeNull();
  });
});
