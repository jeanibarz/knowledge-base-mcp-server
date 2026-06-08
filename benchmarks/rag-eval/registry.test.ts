import { describe, expect, it } from '@jest/globals';
import {
  assertRagRegistryInvariants,
  getRagDataset,
  RAG_EVAL_REGISTRY,
  ragDatasetNames,
} from './registry.js';

describe('rag-eval dataset registry', () => {
  it('contains the gold-bearing QA datasets named in RFC 020 §5', () => {
    expect(ragDatasetNames()).toEqual(expect.arrayContaining(['hotpotqa', 'nq', '2wikimultihop']));
  });

  it('records a contamination note for every dataset (§6)', () => {
    for (const entry of RAG_EVAL_REGISTRY) {
      expect(entry.contamination.note.trim().length).toBeGreaterThan(0);
      expect(typeof entry.contamination.knownInPretraining).toBe('boolean');
    }
  });

  it('looks datasets up by name and passes the invariant check', () => {
    expect(getRagDataset('hotpotqa')?.title).toBe('HotpotQA');
    expect(getRagDataset('nope')).toBeUndefined();
    expect(() => assertRagRegistryInvariants()).not.toThrow();
  });

  it('rejects a duplicate-name registry', () => {
    const dup = [RAG_EVAL_REGISTRY[0], RAG_EVAL_REGISTRY[0]];
    expect(() => assertRagRegistryInvariants(dup)).toThrow(/duplicate/);
  });
});
