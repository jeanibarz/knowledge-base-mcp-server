// Property tests for `parseFrontmatter` (issue #219).
//
// Invariants covered:
//   * Body preservation on missing/invalid frontmatter: when the input does
//     NOT start with a `---\n` fence, `parseFrontmatter(s).body === s`.
//   * Never-throws contract: any UTF-8 string returns a `ParsedFrontmatter`
//     shape without throwing.
//   * Empty-string short-circuit returns `{ tags: [], body: '', frontmatter: {} }`.
//   * `frontmatter` is always a plain object (`Record<string, unknown>`),
//     `tags` is always `string[]`.

import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';
import { parseFrontmatter } from '../frontmatter.js';

const NUM_RUNS = process.env.KB_PROPERTY_DEEP === '1' ? 1000 : 50;

describe('parseFrontmatter — property tests (issue #219)', () => {
  it('body === content when input does not begin with --- fence', () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 0, maxLength: 4096 })
          .filter((s: string) => !/^---\r?\n/.test(s)),
        (content) => {
          const result = parseFrontmatter(content);
          expect(result.body).toBe(content);
          expect(result.tags).toEqual([]);
          expect(result.frontmatter).toEqual({});
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('never throws on arbitrary input; always returns the expected shape', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 4096 }), (content) => {
        const result = parseFrontmatter(content);
        expect(Array.isArray(result.tags)).toBe(true);
        for (const t of result.tags) expect(typeof t).toBe('string');
        expect(typeof result.body).toBe('string');
        expect(result.frontmatter).toEqual(expect.any(Object));
        expect(Array.isArray(result.frontmatter)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('round-trip body preservation: serialize → parse → identical body', () => {
    // Build a well-formed frontmatter block from random keys + string scalars
    // and assert that the body that follows is preserved verbatim.
    const keyArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,8}$/);
    // Restrict to plain alphanumeric+space scalars; YAML special chars
    // (`-`, `:`, `[`, `#`, etc.) would change the parse shape and make the
    // round-trip assertion over-restrictive — those edge cases are covered by
    // the never-throws property above.
    const valArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ]{0,30}[A-Za-z0-9]$/);
    const fmArb = fc
      .uniqueArray(fc.tuple(keyArb, valArb), {
        minLength: 0,
        maxLength: 5,
        selector: ([k]) => k,
      });
    const bodyArb = fc
      .string({ minLength: 0, maxLength: 200 })
      // Avoid bodies that themselves begin with a `---\n` line; the parser
      // does not see further fences past the first close, so this is fine
      // for `body`, but exclude it to keep the property statement simple.
      .filter((s: string) => !s.startsWith('---'));
    fc.assert(
      fc.property(fmArb, bodyArb, (pairs, body) => {
        const yamlLines = pairs.map(([k, v]) => `${k}: ${v}`).join('\n');
        const content = pairs.length === 0
          ? `---\n---\n${body}`
          : `---\n${yamlLines}\n---\n${body}`;
        const result = parseFrontmatter(content);
        expect(result.body).toBe(body);
        // String-valued keys should round-trip into `frontmatter` for keys
        // that exist; FAILSAFE coerces scalars to strings.
        for (const [k, v] of pairs) {
          expect(result.frontmatter[k]).toBe(v);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('empty input returns the empty short-circuit', () => {
    const r = parseFrontmatter('');
    expect(r).toEqual({ tags: [], body: '', frontmatter: {} });
  });
});
