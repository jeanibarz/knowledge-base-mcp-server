import { describe, expect, it } from '@jest/globals';
import {
  BEIR_REGISTRY,
  assertRegistryInvariants,
  ciSubsetDatasets,
  downloadableDatasets,
  fullMatrixDatasets,
  getRegistryEntry,
  tunedDatasets,
  unseenGeneralityDatasets,
  domainOf,
} from './registry.js';
import { CI_SUBSET } from './baseline.js';

describe('BEIR dataset registry', () => {
  it('covers the RFC §2 full public BEIR set', () => {
    const names = new Set(fullMatrixDatasets());
    for (const expected of [
      'trec-covid', 'nfcorpus', 'nq', 'hotpotqa', 'fiqa', 'arguana', 'webis-touche2020',
      'quora', 'dbpedia-entity', 'scidocs', 'fever', 'climate-fever', 'scifact', 'cqadupstack',
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it('mirrors baseline.ts CI_SUBSET as the tuned/CI datasets', () => {
    expect(ciSubsetDatasets().sort()).toEqual([...CI_SUBSET].sort());
    // The tuned ("seen") side of Δ_g is exactly the CI subset.
    expect(tunedDatasets().sort()).toEqual([...CI_SUBSET].sort());
  });

  it('reserves a non-empty unseen-generality set disjoint from the tuned set', () => {
    const tuned = new Set(tunedDatasets());
    const unseen = unseenGeneralityDatasets();
    expect(unseen.length).toBeGreaterThan(0);
    for (const name of unseen) expect(tuned.has(name)).toBe(false);
  });

  it('treats CQADupStack as a registry entry without a single-zip URL', () => {
    const entry = getRegistryEntry('cqadupstack');
    expect(entry).toBeDefined();
    expect(entry?.url).toBeNull();
    // downloadableDatasets() excludes it (no auto-download).
    expect(downloadableDatasets()).not.toContain('cqadupstack');
    expect(downloadableDatasets().length).toBe(BEIR_REGISTRY.length - 1);
  });

  it('carries a contamination note for every dataset', () => {
    for (const entry of BEIR_REGISTRY) {
      expect(entry.contamination.note.length).toBeGreaterThan(0);
      expect(['expert', 'crowdsourced', 'automatic', 'mixed']).toContain(entry.contamination.qrels);
    }
    // Wikipedia-derived sets are flagged as pretraining-leakage risks.
    expect(getRegistryEntry('nq')?.contamination.knownInPretraining).toBe(true);
    expect(getRegistryEntry('scifact')?.contamination.knownInPretraining).toBe(false);
  });

  it('resolves domains, defaulting unknown datasets to "unknown"', () => {
    expect(domainOf('fiqa')).toBe('finance');
    expect(domainOf('not-a-dataset')).toBe('unknown');
  });

  it('passes the disjoint/non-empty Δ_g invariants', () => {
    expect(() => assertRegistryInvariants()).not.toThrow();
  });

  it('rejects an overlapping tuned/unseen partition', () => {
    expect(() => assertRegistryInvariants([
      { ...BEIR_REGISTRY[0], generalityRole: 'tuned' },
      { ...BEIR_REGISTRY[0], name: 'dup', generalityRole: 'unseen-generality' },
      { ...BEIR_REGISTRY[3], name: 'overlap', generalityRole: 'tuned' },
      { ...BEIR_REGISTRY[3], name: 'overlap', generalityRole: 'unseen-generality' },
    ])).toThrow(/duplicate|overlap/);
  });
});
