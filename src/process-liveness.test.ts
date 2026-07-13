import { describe, expect, it } from '@jest/globals';
import { isPidAlive } from './process-liveness.js';

describe('isPidAlive', () => {
  it('recognizes the current process as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('rejects invalid and definitely absent process ids', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(4_294_967_295)).toBe(false);
  });
});
