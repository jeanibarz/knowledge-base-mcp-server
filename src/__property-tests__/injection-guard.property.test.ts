// Property / metamorphic tests for the prompt-injection guard (issue #751).
//
// `src/injection-guard.ts` is a security-critical detector consumed across
// `ask-core`, `relevance-gate`, `relevance-judge`, `formatter`, and
// `task-context-guard`. Before this suite it had only example-based unit
// tests, so a silently-weakened rule (a dropped unicode-tag check, a narrowed
// regex) could pass CI. This suite asserts *behavioural invariants* rather
// than the detector's exact regexes/codepoints, following the repo's
// `__property-tests__` + fuzz precedent (#693):
//
//   1. Benign purity — restricted-vocabulary prose is never flagged (a
//      zero false-positive bound on definitely-benign text).
//   2. Wrapping monotonicity — a flagged payload stays flagged when embedded
//      in arbitrary benign text (adversary can't hide by padding).
//   3. Concatenation superset — `kinds(a + b) ⊇ kinds(a) ∪ kinds(b)`;
//      combining strings never *removes* a signal.
//   4. Obfuscation invariance — inserting any bidi / zero-width / unicode-tag
//      control character anywhere raises the matching signal kind.
//   5. Determinism, dedup, and repetition-invariance of the signal set.
//   6. The curated adversarial corpus is caught, standalone and wrapped.

import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import {
  detectInjectionSignals,
  type InjectionSignal,
  type InjectionSignalKind,
} from '../injection-guard.js';
import {
  INJECTION_GUARD_CORPUS,
  type InjectionCorpusEntry,
} from '../test-support/injection-guard-corpus.js';

const NUM_RUNS = process.env.KB_PROPERTY_DEEP === '1' ? 1000 : 100;

function kinds(content: string): InjectionSignalKind[] {
  return detectInjectionSignals(content).map((signal) => signal.kind);
}

function signalKey(signal: InjectionSignal): string {
  return `${signal.kind}:${signal.match ?? signal.codepoint ?? ''}`;
}

// Innocuous vocabulary: by construction none of these tokens (nor any ordering
// of them) can form a system-role marker, an instruction-override phrase, or a
// control character. Text built from them is guaranteed signal-free, which
// makes it a sound generator for the "benign padding" invariants below.
const benignWordArb = fc.constantFrom(
  'the', 'quick', 'brown', 'deploy', 'restart', 'worker', 'after', 'migration',
  'notes', 'summary', 'update', 'config', 'value', 'index', 'search', 'result',
  'cache', 'model', 'embedding', 'provider', 'chunk', 'document', 'vector',
);
const benignTextArb = fc
  .array(benignWordArb, { minLength: 0, maxLength: 12 })
  .map((words) => words.join(' '));

// Control characters the detector classifies, each tagged with the kind it
// must raise. Ranges mirror the Unicode blocks the guard scans, not its
// implementation — a fuzz over the whole range, not a copy of the constants.
const bidiCodepointArb = fc.oneof(
  fc.integer({ min: 0x202a, max: 0x202e }),
  fc.integer({ min: 0x2066, max: 0x2069 }),
);
const zeroWidthCodepointArb = fc.oneof(
  fc.integer({ min: 0x200b, max: 0x200d }),
  fc.constant(0xfeff),
);
const tagCodepointArb = fc.integer({ min: 0xe0020, max: 0xe007f });

const controlCharArb: fc.Arbitrary<{ char: string; kind: InjectionSignalKind }> = fc.oneof(
  bidiCodepointArb.map((cp) => ({ char: String.fromCodePoint(cp), kind: 'unicode_bidi' as const })),
  zeroWidthCodepointArb.map((cp) => ({ char: String.fromCodePoint(cp), kind: 'zero_width' as const })),
  tagCodepointArb.map((cp) => ({ char: String.fromCodePoint(cp), kind: 'unicode_tag' as const })),
);

const corpusEntryArb: fc.Arbitrary<InjectionCorpusEntry> = fc.constantFrom(
  ...INJECTION_GUARD_CORPUS,
);

// A fragment that may or may not carry a signal: benign prose, a corpus
// payload, or a lone control character. Used to fuzz the concatenation law.
const fragmentArb: fc.Arbitrary<string> = fc.oneof(
  benignTextArb,
  corpusEntryArb.map((entry) => entry.payload),
  controlCharArb.map(({ char }) => char),
  fc.string({ unit: 'grapheme', maxLength: 24 }),
);

function insertAt(haystack: string, needle: string, index: number): string {
  const at = ((index % (haystack.length + 1)) + haystack.length + 1) % (haystack.length + 1);
  return haystack.slice(0, at) + needle + haystack.slice(at);
}

describe('injection-guard — benign purity (issue #751)', () => {
  it('never flags text built from an innocuous vocabulary', () => {
    fc.assert(
      fc.property(benignTextArb, (text) => {
        expect(detectInjectionSignals(text)).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('injection-guard — wrapping monotonicity (issue #751)', () => {
  it('keeps every expected signal when a payload is padded with benign text', () => {
    fc.assert(
      fc.property(corpusEntryArb, benignTextArb, benignTextArb, (entry, pre, post) => {
        const padded = `${pre} ${entry.payload} ${post}`;
        const detected = new Set(kinds(padded));
        for (const kind of entry.expectedKinds) {
          expect(detected.has(kind)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('injection-guard — concatenation superset (issue #751)', () => {
  // Joining two documents with whitespace never *removes* a signal. The
  // separator matters: raw adjacency (`a + b`) can legitimately mask a
  // `\b`-anchored regex — e.g. `"x" + "ignore previous instructions"` becomes
  // `"xignore…"`, which no longer has a word boundary before `ignore`. A
  // whitespace separator preserves the boundary, so every signal in either
  // operand survives the join.
  it('kinds(a + "\\n" + b) is a superset of kinds(a) ∪ kinds(b)', () => {
    fc.assert(
      fc.property(fragmentArb, fragmentArb, (a, b) => {
        const combined = new Set(kinds(`${a}\n${b}`));
        for (const kind of [...kinds(a), ...kinds(b)]) {
          expect(combined.has(kind)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('injection-guard — obfuscation invariance (issue #751)', () => {
  it('raises the matching signal for any control char inserted anywhere', () => {
    fc.assert(
      fc.property(benignTextArb, controlCharArb, fc.integer(), (text, control, index) => {
        const smuggled = insertAt(text, control.char, index);
        expect(new Set(kinds(smuggled)).has(control.kind)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('injection-guard — determinism and dedup (issue #751)', () => {
  it('is a pure function of its input', () => {
    fc.assert(
      fc.property(fragmentArb, (content) => {
        expect(detectInjectionSignals(content)).toEqual(detectInjectionSignals(content));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('emits no duplicate (kind, match/codepoint) signals', () => {
    fc.assert(
      fc.property(fragmentArb, fragmentArb, (a, b) => {
        const signals = detectInjectionSignals(a + b);
        const keys = signals.map(signalKey);
        expect(keys.length).toBe(new Set(keys).size);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is invariant under payload repetition (dedup collapses copies)', () => {
    fc.assert(
      fc.property(corpusEntryArb, fc.integer({ min: 1, max: 4 }), (entry, times) => {
        const once = new Set(kinds(entry.payload));
        const repeated = new Set(kinds(entry.payload.repeat(times)));
        expect([...repeated].sort()).toEqual([...once].sort());
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('injection-guard — adversarial corpus (issue #751)', () => {
  it.each(INJECTION_GUARD_CORPUS.map((entry) => [entry.name, entry] as const))(
    'catches %s standalone',
    (_name, entry) => {
      const detected = new Set(kinds(entry.payload));
      expect(detected.size).toBeGreaterThan(0);
      for (const kind of entry.expectedKinds) {
        expect(detected.has(kind)).toBe(true);
      }
    },
  );
});
