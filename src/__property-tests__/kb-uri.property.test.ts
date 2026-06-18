// Property tests for the `kb://` resource URI parser/builder (issue #693).
//
// The `kb://` scheme is a client-facing contract owned by `mcp-resources.ts`:
// `buildResourceUri` percent-encodes each path segment, and
// `parseKnowledgeBaseResourceUri` decodes per-segment while rejecting
// traversal, encoded separators, and invalid KB names. None of the existing
// `src/__property-tests__/` suites cover URI round-tripping, so this adds:
//
//   * Round-trip: `parse(build(kbName, relPath))` returns the original
//     components across adversarial valid inputs (Unicode, spaces, `%`, `#`,
//     `?`, `:`, `+`, deep paths).
//   * Encoding safety: reserved/structural characters are percent-encoded so
//     they survive a build→parse cycle instead of truncating the URI.
//   * Rejection: non-`kb://` schemes, empty authority, invalid KB names,
//     `..` traversal, and encoded path separators (`%2f`/`%5c`) all throw the
//     documented errors — no silent acceptance.
//   * MIME mapping: extension → MIME type is total and case-insensitive.
//
// The round-trip invariant is `decodeURIComponent(encodeURIComponent(x)) === x`
// for every segment, which holds for any string. The only valid-path
// constraints are therefore structural: a segment may not be empty, may not be
// the `..` traversal token, and may not contain `/` or `\` (which encode to
// `%2F`/`%5C` and are rejected as encoded separators). The generators below
// stay inside that envelope for the positive tests and step outside it for the
// rejection tests.

import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import {
  buildResourceUri,
  parseKnowledgeBaseResourceUri,
  mimeTypeForResource,
} from '../mcp-resources.js';

const NUM_RUNS = process.env.KB_PROPERTY_DEEP === '1' ? 1000 : 100;

// Valid KB-name grammar from `kb-paths.ts`: `^[a-z0-9][a-z0-9._-]*$`, 1-64.
// Capped at 21 chars here to keep generated URIs small.
const kbNameArb = fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,20}$/);

// Lowercase-alnum segment used where a URI needs a benign, definitely-valid
// path component around the part under test.
const safeSegArb = fc.stringMatching(/^[a-z0-9]{1,8}$/);

// Hand-picked adversarial-but-valid path segments: reserved URI characters,
// Unicode, and whitespace. Each round-trips because `buildResourceUri`
// percent-encodes it and `parseKnowledgeBaseResourceUri` decodes it back.
const adversarialSegArb = fc.constantFrom(
  'a b', // internal space
  ' leading', // leading space
  'trailing ', // trailing space
  'tab\tchar', // tab
  'café', // accented Latin
  '日本語', // CJK
  '🚀rocket', // emoji (multi-code-unit)
  '100%done', // literal percent
  '%41', // looks encoded, is literal text
  'bug#123', // fragment delimiter
  'q?x=1', // query delimiter + equals
  'a:b', // colon
  'a+b', // plus
  'a&b=c', // ampersand + equals
  'a;b,c', // sub-delims
  '.', // single dot — valid, not traversal
  '...', // triple dot — valid, not traversal
  '.hidden', // dotfile-style
);

// A path segment that survives a build→parse round-trip. Mixes full-Unicode
// generation with the curated adversarial set, then filters out the three
// structural exclusions. `unit: 'grapheme'` never emits lone surrogates, so
// `encodeURIComponent` cannot throw on it.
const roundTripSegArb = fc
  .oneof(
    fc.string({ unit: 'grapheme', minLength: 1, maxLength: 12 }),
    adversarialSegArb,
  )
  .filter((s) => s.length > 0 && s !== '..' && !s.includes('/') && !s.includes('\\'));

const roundTripPathArb = fc
  .array(roundTripSegArb, { minLength: 1, maxLength: 5 })
  .map((segments) => segments.join('/'));

describe('kb:// URI round-trip — property tests (issue #693)', () => {
  it('parse(build(kbName, relPath)) recovers the original components', () => {
    fc.assert(
      fc.property(kbNameArb, roundTripPathArb, (kbName, relativePath) => {
        const uri = buildResourceUri(kbName, relativePath);
        expect(uri.startsWith(`kb://${kbName}/`)).toBe(true);
        expect(parseKnowledgeBaseResourceUri(uri)).toEqual({ kbName, relativePath });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('percent-encodes reserved characters so they survive build→parse', () => {
    const reservedChar = fc.constantFrom(
      ' ', '#', '?', '&', '=', '+', '%', ':', '@', '"', "'", '<', '>', '|', '^',
    );
    fc.assert(
      fc.property(
        kbNameArb,
        fc.array(reservedChar, { minLength: 1, maxLength: 8 }),
        (kbName, chars) => {
          const segment = chars.join('');
          const uri = buildResourceUri(kbName, segment);
          // The encoded path must not contain raw `#`/`?`, which would
          // truncate the path when the URI is re-parsed.
          const encodedPath = uri.slice(`kb://${kbName}/`.length);
          expect(encodedPath.includes('#')).toBe(false);
          expect(encodedPath.includes('?')).toBe(false);
          expect(parseKnowledgeBaseResourceUri(uri).relativePath).toBe(segment);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('kb:// URI rejection — property tests (issue #693)', () => {
  it('rejects non-kb:// schemes', () => {
    const otherScheme = fc.constantFrom(
      'http', 'https', 'ftp', 'file', 'data', 'ws', 'wss', 'foo', 'kbx',
    );
    fc.assert(
      fc.property(otherScheme, kbNameArb, safeSegArb, (scheme, host, seg) => {
        expect(() => parseKnowledgeBaseResourceUri(`${scheme}://${host}/${seg}`)).toThrow(
          /kb:\/\/ scheme|unsupported resource URI scheme/,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects an empty KB authority', () => {
    fc.assert(
      fc.property(safeSegArb, (seg) => {
        expect(() => parseKnowledgeBaseResourceUri(`kb:///${seg}`)).toThrow(/authority/i);
      }),
      { numRuns: Math.min(NUM_RUNS, 50) },
    );
  });

  it('rejects invalid KB names', () => {
    // Uppercase-led hosts are valid opaque URL hosts but violate the
    // lowercase-only KB-name grammar, so `new URL` succeeds and the parser's
    // own `isValidKbName` guard rejects them.
    const invalidHost = fc.stringMatching(/^[A-Z][A-Za-z0-9._~-]{0,10}$/);
    fc.assert(
      fc.property(invalidHost, safeSegArb, (host, seg) => {
        expect(() => parseKnowledgeBaseResourceUri(`kb://${host}/${seg}`)).toThrow(
          /invalid KB name/,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects `..` path traversal', () => {
    fc.assert(
      fc.property(
        kbNameArb,
        fc.array(safeSegArb, { maxLength: 3 }),
        fc.array(safeSegArb, { maxLength: 3 }),
        (host, before, after) => {
          const rel = [...before, '..', ...after].join('/');
          expect(() => parseKnowledgeBaseResourceUri(`kb://${host}/${rel}`)).toThrow(
            /escapes KB root/,
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects encoded path separators (%2f, %5c)', () => {
    const encodedSep = fc.constantFrom('%2f', '%2F', '%5c', '%5C');
    fc.assert(
      fc.property(kbNameArb, safeSegArb, encodedSep, safeSegArb, (host, a, sep, b) => {
        expect(() => parseKnowledgeBaseResourceUri(`kb://${host}/${a}${sep}${b}`)).toThrow(
          /escapes KB root/,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects an empty resource path', () => {
    fc.assert(
      fc.property(kbNameArb, (host) => {
        expect(() => parseKnowledgeBaseResourceUri(`kb://${host}`)).toThrow(
          /non-empty resource path/,
        );
        expect(() => parseKnowledgeBaseResourceUri(`kb://${host}/`)).toThrow(
          /non-empty resource path/,
        );
      }),
      { numRuns: Math.min(NUM_RUNS, 50) },
    );
  });
});

describe('mimeTypeForResource — property tests (issue #693)', () => {
  const KNOWN: Record<string, string> = {
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.pdf': 'application/pdf',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.txt': 'text/plain',
  };
  const knownExt = fc.constantFrom(...Object.keys(KNOWN));
  // Base filename: starts with an alnum so the only extension is the suffix.
  const baseArb = fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,11}$/);

  it('maps known extensions to their MIME type', () => {
    fc.assert(
      fc.property(baseArb, knownExt, (base, ext) => {
        expect(mimeTypeForResource(`${base}${ext}`)).toBe(KNOWN[ext]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is case-insensitive on the extension', () => {
    fc.assert(
      fc.property(baseArb, knownExt, (base, ext) => {
        expect(mimeTypeForResource(`${base}${ext.toUpperCase()}`)).toBe(KNOWN[ext]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is total: every input maps to a known MIME type', () => {
    const allMimes = new Set(Object.values(KNOWN));
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 30 }), (filePath) => {
        const mime = mimeTypeForResource(filePath);
        expect(typeof mime).toBe('string');
        expect(allMimes.has(mime)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
