import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_FS_CONCURRENCY,
  mapBounded,
  normalizeConcurrency,
  resolveFsConcurrency,
} from './bounded-concurrency.js';

describe('mapBounded', () => {
  it('preserves input order while bounding active work', async () => {
    let active = 0;
    let maxActive = 0;

    const out = await mapBounded([30, 10, 20, 0], 2, async (delayMs, index) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      active -= 1;
      return `item-${index}`;
    });

    expect(out).toEqual(['item-0', 'item-1', 'item-2', 'item-3']);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(1);
  });

  it('runs every item and aggregates failures in input order', async () => {
    const seen: number[] = [];

    await expect(
      mapBounded([0, 1, 2, 3], 2, async (item) => {
        seen.push(item);
        if (item % 2 === 1) {
          throw new Error(`failed-${item}`);
        }
        return item;
      }),
    ).rejects.toMatchObject({
      name: 'BoundedConcurrencyError',
      failures: [
        { index: 1, item: 1, error: expect.objectContaining({ message: 'failed-1' }) },
        { index: 3, item: 3, error: expect.objectContaining({ message: 'failed-3' }) },
      ],
      errors: [
        expect.objectContaining({ message: 'failed-1' }),
        expect.objectContaining({ message: 'failed-3' }),
      ],
    });

    expect(seen.sort()).toEqual([0, 1, 2, 3]);
  });

  it('uses at least one worker for fractional or zero concurrency', async () => {
    expect(normalizeConcurrency(0)).toBe(1);
    expect(normalizeConcurrency(1.9)).toBe(1);
    expect(normalizeConcurrency(2.1)).toBe(2);
    expect(() => normalizeConcurrency(Number.NaN)).toThrow(RangeError);
  });

  it('resolves the filesystem concurrency from KB_FS_CONCURRENCY with a default of 8', () => {
    expect(resolveFsConcurrency({} as NodeJS.ProcessEnv)).toBe(DEFAULT_FS_CONCURRENCY);
    expect(resolveFsConcurrency({ KB_FS_CONCURRENCY: '4' } as NodeJS.ProcessEnv)).toBe(4);
    expect(resolveFsConcurrency({ KB_FS_CONCURRENCY: '0' } as NodeJS.ProcessEnv)).toBe(DEFAULT_FS_CONCURRENCY);
    expect(resolveFsConcurrency({ KB_FS_CONCURRENCY: 'not-a-number' } as NodeJS.ProcessEnv)).toBe(DEFAULT_FS_CONCURRENCY);
  });
});
