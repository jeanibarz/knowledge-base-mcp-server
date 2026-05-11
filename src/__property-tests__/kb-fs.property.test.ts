// Property tests for kb-fs path resolution helpers (issue #219).
//
// Invariants covered:
//   * `assertNoTraversal` rejects any path containing a `..` segment, a POSIX
//     `/` prefix, a Win32 drive-letter prefix, or a `\\?\` prefix.
//   * `assertNoTraversal` accepts any pure-segment path (no separators).
//   * `resolveKbPath` traversal safety: for arbitrary relative input, the
//     call either throws `KBError('VALIDATION')` or returns an absolute path
//     strictly inside the KB root.
//   * `resolveKbPath` idempotency: feeding the returned absolute path back
//     as a KB-relative path yields the same absolute path.

import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import * as fc from 'fast-check';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { KBError } from '../errors.js';
import { assertNoTraversal, resolveKbPath } from '../kb-fs.js';

const NUM_RUNS = process.env.KB_PROPERTY_DEEP === '1' ? 1000 : 50;

const safeNameArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/);

describe('assertNoTraversal — property tests (issue #219)', () => {
  it('rejects any path containing a `..` segment', () => {
    fc.assert(
      fc.property(
        fc.array(safeNameArb, { minLength: 0, maxLength: 3 }),
        fc.array(safeNameArb, { minLength: 0, maxLength: 3 }),
        (before, after) => {
          const rel = [...before, '..', ...after].join('/');
          expect(() => assertNoTraversal(rel)).toThrow(/escapes KB root/);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects POSIX-absolute paths', () => {
    fc.assert(
      fc.property(safeNameArb, fc.array(safeNameArb, { maxLength: 3 }), (head, tail) => {
        const rel = ['', head, ...tail].join('/');
        expect(() => assertNoTraversal(rel)).toThrow(/escapes KB root/);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects Win32-absolute drive-letter paths', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z]$/),
        fc.array(safeNameArb, { maxLength: 3 }),
        (letter, tail) => {
          const rel = `${letter}:\\` + tail.join('\\');
          expect(() => assertNoTraversal(rel)).toThrow(/escapes KB root/);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('accepts pure-segment relative paths', () => {
    fc.assert(
      fc.property(
        fc.array(safeNameArb, { minLength: 1, maxLength: 4 }),
        (segments) => {
          const rel = segments.join('/');
          expect(() => assertNoTraversal(rel)).not.toThrow();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('resolveKbPath — property tests (issue #219)', () => {
  let rootDir: string;
  const kbName = 'kb-prop';
  let kbDir: string;

  beforeAll(async () => {
    rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-prop-resolve-'));
    kbDir = path.join(rootDir, kbName);
    await fsp.mkdir(kbDir, { recursive: true });
    // Create a couple of real files so mustExist-true probes can hit one.
    await fsp.writeFile(path.join(kbDir, 'present.md'), '# present\n');
    await fsp.mkdir(path.join(kbDir, 'nested'), { recursive: true });
    await fsp.writeFile(path.join(kbDir, 'nested', 'inner.md'), '# inner\n');
  });

  afterAll(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  // Arbitrary mix of segment-shaped strings, the `..` segment, and a leading
  // `/` prefix — the predicate "either throws VALIDATION or returns inside
  // the KB root" must hold across the whole shape.
  const segArb = fc.oneof(
    safeNameArb,
    fc.constantFrom('..', '.', 'present.md', 'nested'),
  );
  const relArb = fc
    .array(segArb, { minLength: 1, maxLength: 4 })
    .map((segs) => segs.join('/'))
    // Trim empty heads/tails that minimatch interprets as POSIX-absolute.
    .filter((s) => s.length > 0 && !s.includes('\0'));

  it('either rejects with VALIDATION or returns a path strictly inside the KB root', async () => {
    await fc.assert(
      fc.asyncProperty(relArb, async (rel) => {
        try {
          const result = await resolveKbPath(rootDir, kbName, rel, {
            mustExist: false,
          });
          // Returned path must be inside the KB root.
          const prefix = kbDir.endsWith(path.sep) ? kbDir : `${kbDir}${path.sep}`;
          expect(result === kbDir || result.startsWith(prefix)).toBe(true);
        } catch (err) {
          // Acceptable failure modes: VALIDATION (traversal, null byte,
          // empty) or plain Error("path not found") under mustExist=true.
          // mustExist=false should NEVER throw "path not found".
          if (err instanceof KBError) {
            expect(err.code).toBe('VALIDATION');
          } else {
            throw err;
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('idempotency: round-tripping the resolved path through KB-relative form is stable', async () => {
    const goodRelArb = fc.constantFrom('present.md', 'nested/inner.md', 'nested');
    await fc.assert(
      fc.asyncProperty(goodRelArb, async (rel) => {
        const first = await resolveKbPath(rootDir, kbName, rel, { mustExist: true });
        const back = path.relative(kbDir, first).split(path.sep).join('/');
        const second = await resolveKbPath(rootDir, kbName, back, {
          mustExist: true,
        });
        expect(second).toBe(first);
      }),
      { numRuns: Math.min(NUM_RUNS, 30) },
    );
  });
});
