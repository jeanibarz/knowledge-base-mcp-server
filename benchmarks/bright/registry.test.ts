import { describe, expect, it } from '@jest/globals';
import {
  assertBrightRegistryInvariants,
  BRIGHT_REGISTRY,
  brightDomainOf,
  brightTaskNames,
  getBrightTask,
} from './registry.js';

describe('BRIGHT registry', () => {
  it('lists the 12 official BRIGHT tasks with unique names', () => {
    const names = brightTaskNames();
    expect(names).toHaveLength(12);
    expect(new Set(names).size).toBe(12);
    for (const expected of ['biology', 'stackoverflow', 'leetcode', 'aops', 'theoremqa_theorems']) {
      expect(names).toContain(expected);
    }
  });

  it('maps every task to a known domain bucket', () => {
    for (const entry of BRIGHT_REGISTRY) {
      expect(['stackexchange', 'coding', 'competition-math', 'theorem-based']).toContain(entry.domain);
      expect(brightDomainOf(entry.name)).toBe(entry.domain);
    }
    expect(brightDomainOf('not-a-task')).toBe('unknown');
  });

  it('passes its own invariant check and resolves entries by name', () => {
    expect(() => assertBrightRegistryInvariants()).not.toThrow();
    expect(getBrightTask('biology')?.title).toBe('Biology');
    expect(getBrightTask('missing')).toBeUndefined();
  });

  it('rejects a registry with a duplicate task', () => {
    const dup = [BRIGHT_REGISTRY[0], BRIGHT_REGISTRY[0]];
    expect(() => assertBrightRegistryInvariants(dup)).toThrow(/duplicate/);
  });
});
