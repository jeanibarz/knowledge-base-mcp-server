// Property tests for outbound secret redaction (issue #896).
//
// `redactSecrets` decides what leaves the process on every remote LLM call.
// Example-based unit tests pin regex floors and capture groups; this suite
// asserts behavioural invariants over a positive/negative corpus and random
// benign padding, following the `__property-tests__` + fuzz precedent (#751):
//
//   1. Positive corpus — shaped secrets are replaced; the secret needle is gone.
//   2. Negative corpus — git SHAs, credential-less URLs, short tokens, prose
//      are unchanged.
//   3. Benign purity — restricted-vocabulary prose is never redacted.
//   4. Wrapping monotonicity — a redacted payload stays redacted when padded
//      with benign text.
//   5. Determinism and text-idempotence.
//   6. maybeRedact(text, false) is identity.
//   7. summary.total equals the sum of by_type counts.

import { describe, expect, it } from '@jest/globals';
import * as fc from 'fast-check';
import {
  REDACTION_PLACEHOLDER,
  maybeRedact,
  redactSecrets,
} from '../redaction.js';
import {
  REDACTION_NEGATIVE_CORPUS,
  REDACTION_POSITIVE_CORPUS,
  type RedactionNegativeEntry,
  type RedactionPositiveEntry,
} from '../test-support/redaction-corpus.js';

const NUM_RUNS = process.env.KB_PROPERTY_DEEP === '1' ? 1000 : 100;

const benignWordArb = fc.constantFrom(
  'the', 'quick', 'brown', 'deploy', 'restart', 'worker', 'after', 'migration',
  'notes', 'summary', 'update', 'config', 'value', 'index', 'search', 'result',
  'cache', 'model', 'embedding', 'chunk', 'document', 'vector',
);
const benignTextArb = fc
  .array(benignWordArb, { minLength: 0, maxLength: 12 })
  .map((words) => words.join(' '));

const positiveArb: fc.Arbitrary<RedactionPositiveEntry> = fc.constantFrom(
  ...REDACTION_POSITIVE_CORPUS,
);
const negativeArb: fc.Arbitrary<RedactionNegativeEntry> = fc.constantFrom(
  ...REDACTION_NEGATIVE_CORPUS,
);

function typeTotal(byType: Record<string, number>): number {
  return Object.values(byType).reduce((sum, count) => sum + count, 0);
}

describe('redaction — positive corpus (issue #896)', () => {
  it('replaces every shaped secret and drops the secret needle', () => {
    fc.assert(
      fc.property(positiveArb, (entry) => {
        const result = redactSecrets(entry.payload);
        expect(result.text).toContain(REDACTION_PLACEHOLDER);
        expect(result.text).toContain(entry.expectedSnippet);
        expect(result.text).not.toContain(entry.secretNeedle);
        expect(result.summary.by_type[entry.expectedType] ?? 0).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('redaction — negative corpus (issue #896)', () => {
  it('leaves git SHAs, URLs, short tokens, and prose unchanged', () => {
    fc.assert(
      fc.property(negativeArb, (entry) => {
        const result = redactSecrets(entry.payload);
        expect(result.text).toBe(entry.payload);
        expect(result.summary.total).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('redaction — benign purity (issue #896)', () => {
  it('never redacts text built from an innocuous vocabulary', () => {
    fc.assert(
      fc.property(benignTextArb, (text) => {
        const result = redactSecrets(text);
        expect(result.text).toBe(text);
        expect(result.summary.total).toBe(0);
        expect(result.summary.by_type).toEqual({});
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('redaction — wrapping monotonicity (issue #896)', () => {
  it('still redacts a payload padded with benign text', () => {
    fc.assert(
      fc.property(positiveArb, benignTextArb, benignTextArb, (entry, pre, post) => {
        // Newline padding preserves `^`/`m` header and dotenv anchors; a same-line
        // prefix would legitimately hide `Cookie:` / `OPENAI_API_KEY=` line matches.
        const padded = `${pre}\n${entry.payload}\n${post}`;
        const result = redactSecrets(padded);
        expect(result.text).toContain(REDACTION_PLACEHOLDER);
        expect(result.text).not.toContain(entry.secretNeedle);
        expect(result.summary.by_type[entry.expectedType] ?? 0).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('redaction — determinism, idempotence, identity (issue #896)', () => {
  it('is a pure function of its input', () => {
    fc.assert(
      fc.property(positiveArb, negativeArb, benignTextArb, (pos, neg, benign) => {
        const input = `${benign}\n${pos.payload}\n${neg.payload}`;
        expect(redactSecrets(input)).toEqual(redactSecrets(input));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is text-idempotent', () => {
    fc.assert(
      fc.property(positiveArb, negativeArb, (pos, neg) => {
        const once = redactSecrets(`${pos.payload}\n${neg.payload}`);
        const twice = redactSecrets(once.text);
        expect(twice.text).toBe(once.text);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('maybeRedact(text, false) is identity', () => {
    fc.assert(
      fc.property(positiveArb, (entry) => {
        const result = maybeRedact(entry.payload, false);
        expect(result.text).toBe(entry.payload);
        expect(result.summary.enabled).toBe(false);
        expect(result.summary.total).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('summary.total equals the sum of by_type counts', () => {
    fc.assert(
      fc.property(positiveArb, negativeArb, benignTextArb, (pos, neg, benign) => {
        const result = redactSecrets(`${benign}\n${pos.payload}\n${neg.payload}`);
        expect(result.summary.total).toBe(typeTotal(result.summary.by_type));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
