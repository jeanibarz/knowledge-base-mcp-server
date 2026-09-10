// Property tests for the ingest secret scanner (issue #896).
//
// `detectSecretsInText` owns the secret-category taxonomy used to quarantine
// files before embedding. Example-based unit tests pin entropy floors and
// pattern alternatives; this suite asserts behavioural invariants over a
// positive/negative corpus, following the `__property-tests__` + fuzz
// precedent (#751):
//
//   1. Positive corpus — true secrets raise the expected category.
//   2. Negative corpus — git SHAs, URLs, low-entropy repeats, short tokens,
//      and mid-entropy mixed blobs stay clean.
//   3. Benign purity — restricted-vocabulary prose is never flagged.
//   4. Wrapping monotonicity — a flagged payload stays flagged when padded
//      with benign text (whitespace-separated so `\b` anchors survive).
//   5. Determinism and category-dedup under repetition.
//   6. Findings never echo the matched payload.
//   7. A disabled scan never throws.

import { describe, expect, it } from '@jest/globals';
import * as fc from 'fast-check';
import {
  IngestSecretDetectedError,
  assertNoIngestSecrets,
  detectSecretsInText,
  type SecretFindingCategory,
} from '../secret-scanner.js';
import {
  SECRET_SCANNER_NEGATIVE_CORPUS,
  SECRET_SCANNER_POSITIVE_CORPUS,
  type SecretScannerNegativeEntry,
  type SecretScannerPositiveEntry,
} from '../test-support/secret-scanner-corpus.js';

const NUM_RUNS = process.env.KB_PROPERTY_DEEP === '1' ? 1000 : 100;

const benignWordArb = fc.constantFrom(
  'the', 'quick', 'brown', 'deploy', 'restart', 'worker', 'after', 'migration',
  'notes', 'summary', 'update', 'config', 'value', 'index', 'search', 'result',
  'cache', 'model', 'embedding', 'chunk', 'document', 'vector',
);
const benignTextArb = fc
  .array(benignWordArb, { minLength: 0, maxLength: 12 })
  .map((words) => words.join(' '));

const positiveArb: fc.Arbitrary<SecretScannerPositiveEntry> = fc.constantFrom(
  ...SECRET_SCANNER_POSITIVE_CORPUS,
);
const negativeArb: fc.Arbitrary<SecretScannerNegativeEntry> = fc.constantFrom(
  ...SECRET_SCANNER_NEGATIVE_CORPUS,
);

function categories(text: string): SecretFindingCategory[] {
  return detectSecretsInText(text).map((finding) => finding.category);
}

describe('secret-scanner — positive corpus (issue #896)', () => {
  it('raises the expected category for every true secret', () => {
    fc.assert(
      fc.property(positiveArb, (entry) => {
        expect(categories(entry.payload)).toContain(entry.expectedCategory);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('secret-scanner — negative corpus (issue #896)', () => {
  it('does not flag git SHAs, URLs, low-entropy blobs, or prose', () => {
    fc.assert(
      fc.property(negativeArb, (entry) => {
        expect(detectSecretsInText(entry.payload)).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('secret-scanner — benign purity (issue #896)', () => {
  it('never flags text built from an innocuous vocabulary', () => {
    fc.assert(
      fc.property(benignTextArb, (text) => {
        expect(detectSecretsInText(text)).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('secret-scanner — wrapping monotonicity (issue #896)', () => {
  it('keeps the expected category when a payload is padded with benign text', () => {
    fc.assert(
      fc.property(positiveArb, benignTextArb, benignTextArb, (entry, pre, post) => {
        const padded = `${pre} ${entry.payload} ${post}`;
        expect(new Set(categories(padded)).has(entry.expectedCategory)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('secret-scanner — determinism, dedup, payload hygiene (issue #896)', () => {
  it('is a pure function of its input', () => {
    fc.assert(
      fc.property(positiveArb, negativeArb, (pos, neg) => {
        const input = `${pos.payload}\n${neg.payload}`;
        expect(detectSecretsInText(input)).toEqual(detectSecretsInText(input));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('emits each (category, location, chunkIndex) at most once', () => {
    fc.assert(
      fc.property(positiveArb, fc.integer({ min: 1, max: 4 }), (entry, times) => {
        const findings = detectSecretsInText(entry.payload.repeat(times));
        const keys = findings.map(
          (finding) => `${finding.category}:${finding.location}:${finding.chunkIndex ?? 'none'}`,
        );
        expect(keys.length).toBe(new Set(keys).size);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never echoes the matched payload on the finding or the thrown error', () => {
    fc.assert(
      fc.property(positiveArb, (entry) => {
        for (const finding of detectSecretsInText(entry.payload)) {
          expect(JSON.stringify(finding)).not.toContain(entry.payload);
        }
        try {
          assertNoIngestSecrets([entry.payload], {
            relativePath: 'alpha/secret.md',
            knowledgeBaseName: 'alpha',
            scanOptions: { enabled: true, bypassKnowledgeBases: [] },
          });
          throw new Error('expected scanner to throw');
        } catch (error) {
          expect(error).toBeInstanceOf(IngestSecretDetectedError);
          expect((error as Error).message).not.toContain(entry.payload);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('does not throw when the scan is disabled', () => {
    fc.assert(
      fc.property(positiveArb, (entry) => {
        expect(() => assertNoIngestSecrets([entry.payload], {
          relativePath: 'alpha/secret.md',
          knowledgeBaseName: 'alpha',
          scanOptions: { enabled: false, bypassKnowledgeBases: [] },
        })).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
