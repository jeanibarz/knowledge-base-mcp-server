import { describe, expect, it } from '@jest/globals';
import {
  BEIR_REGISTRY,
  COIR_REGISTRY,
  NANOBEIR_REGISTRY,
  assertRegistryInvariants,
  ciSubsetDatasets,
  coirDatasets,
  coirDatasetsByFamily,
  downloadableDatasets,
  fullMatrixDatasets,
  getCoirEntry,
  getNanoBeirEntry,
  getRegistryEntry,
  nanoBeirGateDatasets,
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

describe('NanoBEIR gate registry (issue #1051)', () => {
  it('is a separate registry that never leaks into the headline BEIR matrix', () => {
    // NanoBEIR gate datasets are a per-PR dense-regression signal, NOT part of
    // the RFC §2 full public BEIR set — they must stay out of fullMatrixDatasets()
    // (and therefore the matrix runner / Δ_g partition).
    const gateNames = nanoBeirGateDatasets();
    // Guard against a vacuous pass: both sides must be non-empty for the
    // disjointness assertion below to mean anything.
    expect(gateNames.length).toBeGreaterThan(0);
    expect(gateNames).toEqual(NANOBEIR_REGISTRY.map((e) => e.name));
    const matrix = fullMatrixDatasets();
    expect(matrix.length).toBeGreaterThan(0);
    const matrixSet = new Set(matrix);
    for (const name of gateNames) {
      expect(matrixSet.has(name)).toBe(false);
    }
  });

  it('carries NanoBEIR provenance and a contamination note for every gate dataset', () => {
    for (const entry of NANOBEIR_REGISTRY) {
      expect(entry.name.startsWith('nanobeir-')).toBe(true);
      expect(entry.source).toMatch(/Nano/);
      expect(entry.split.length).toBeGreaterThan(0);
      expect(entry.contamination.note.length).toBeGreaterThan(0);
      expect(['expert', 'crowdsourced', 'automatic', 'mixed']).toContain(entry.contamination.qrels);
    }
  });

  it('resolves gate entries by name', () => {
    const first = nanoBeirGateDatasets()[0];
    expect(getNanoBeirEntry(first)?.name).toBe(first);
    expect(getNanoBeirEntry('not-a-nanobeir-dataset')).toBeUndefined();
  });
});

describe('CoIR code-retrieval registry (#1052)', () => {
  it('stays out of the BEIR headline matrix and the Δ_g partition', () => {
    const names = coirDatasets();
    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual(COIR_REGISTRY.map((e) => e.name));
    const matrix = new Set(fullMatrixDatasets());
    for (const name of names) expect(matrix.has(name)).toBe(false);
    for (const name of [...tunedDatasets(), ...unseenGeneralityDatasets()]) {
      expect(names).not.toContain(name);
    }
  });

  it('has unique names and covers at least three task families', () => {
    const names = coirDatasets();
    expect(new Set(names).size).toBe(names.length);
    const families = new Set(COIR_REGISTRY.map((e) => e.family));
    expect(families.size).toBeGreaterThanOrEqual(3);
  });

  it('carries a contamination note and a pair shape for every dataset', () => {
    for (const entry of COIR_REGISTRY) {
      expect(entry.split.length).toBeGreaterThan(0);
      expect(entry.shape.length).toBeGreaterThan(0);
      expect(entry.contamination.note.length).toBeGreaterThan(0);
      expect(['expert', 'crowdsourced', 'automatic', 'mixed']).toContain(entry.contamination.qrels);
    }
  });

  it('groups datasets by family and resolves entries by name', () => {
    expect(coirDatasetsByFamily('text-to-code')).toEqual(['cosqa']);
    expect(coirDatasetsByFamily('code-to-code')).toEqual(['codetrans-dl', 'codetrans-contest']);
    expect(coirDatasetsByFamily('hybrid')).toEqual(['stackoverflow-qa']);
    expect(getCoirEntry('cosqa')?.family).toBe('text-to-code');
    expect(getCoirEntry('scifact')).toBeUndefined();
  });
});
