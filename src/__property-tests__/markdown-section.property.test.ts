// Property tests for `markdown-section` heading helpers (issue #219).
//
// Status: `describe.skip` under the project's default jest config.
//
// `markdown-section.ts` imports `mdast-util-from-markdown`, which is pure ESM
// and is not transformed by the ts-jest pipeline this project uses. The same
// blocker is documented in `cli-remember.test.ts` ("ts-jest cannot transform"),
// where the cli-remember tests deliberately avoid loading `markdown-section`
// and exercise the parser end-to-end via the child-process tests in
// `cli.test.ts` instead.
//
// The property statements below are kept here so a future change that enables
// transforming third-party ESM (e.g. `transformIgnorePatterns` allowlist or a
// move to babel-jest) can flip `describe.skip` to `describe` and the
// invariants run unchanged. They mirror the issue #219 plan:
//
//   * `parseHeadingSpec` round-trip on `"#{n} <text>"`.
//   * `listHeadings` never returns headings inside fenced code blocks.
//   * `locateSection` finds a unique heading and produces an in-range
//     `splitLineIndex`.
//   * `appendSectionInDocument` preserves the frontmatter prefix
//     byte-identical.
//   * `spliceAppend` keeps the original heading and inserts the new content.

import { describe, it, expect } from '@jest/globals';
import * as fc from 'fast-check';

const NUM_RUNS = process.env.KB_PROPERTY_DEEP === '1' ? 1000 : 50;

const headingTextArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ]{0,28}[A-Za-z0-9]$/);
const headingLevelArb = fc.integer({ min: 1, max: 6 });

describe.skip('markdown-section — property tests (issue #219, gated by ESM transform)', () => {
  // Dynamic import keeps the file loadable under the default jest config; the
  // body only runs if `describe.skip` is flipped to `describe`.
  let mod: typeof import('../markdown-section.js');

  it('parseHeadingSpec round-trips `"#{n} <text>"` for n in 1..6', async () => {
    mod = mod ?? (await import('../markdown-section.js'));
    fc.assert(
      fc.property(headingLevelArb, headingTextArb, (level, text) => {
        const spec = `${'#'.repeat(level)} ${text}`;
        const parsed = mod.parseHeadingSpec(spec);
        expect(parsed.level).toBe(level);
        expect(parsed.text).toBe(text.trim());
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('listHeadings ignores headings inside fenced code blocks', async () => {
    mod = mod ?? (await import('../markdown-section.js'));
    fc.assert(
      fc.property(headingLevelArb, headingTextArb, (level, text) => {
        const codeFenced = '```\n' + `${'#'.repeat(level)} ${text}\n` + '```\n';
        expect(mod.listHeadings(codeFenced)).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('appendSectionInDocument preserves the frontmatter prefix byte-identical', async () => {
    mod = mod ?? (await import('../markdown-section.js'));
    const fmKeyArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,8}$/);
    const fmValArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ]{0,18}[A-Za-z0-9]$/);
    const fmPairArb = fc.uniqueArray(fc.tuple(fmKeyArb, fmValArb), {
      minLength: 1,
      maxLength: 4,
      selector: ([k]) => k,
    });
    fc.assert(
      fc.property(
        fmPairArb,
        headingLevelArb,
        headingTextArb,
        fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ]{0,38}[A-Za-z0-9]$/),
        (pairs, level, text, newContent) => {
          const fmBlock = pairs.map(([k, v]) => `${k}: ${v}`).join('\n');
          const heading = `${'#'.repeat(level)} ${text}`;
          const body = `${heading}\n\nexisting section body.\n`;
          const doc = `---\n${fmBlock}\n---\n${body}`;
          const result = mod.appendSectionInDocument(doc, { level, text }, newContent);
          const prefixLen = doc.length - body.length;
          expect(result.content.slice(0, prefixLen)).toBe(doc.slice(0, prefixLen));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('locateSection + spliceAppend keep heading and append new content', async () => {
    mod = mod ?? (await import('../markdown-section.js'));
    fc.assert(
      fc.property(
        headingLevelArb,
        headingTextArb,
        fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ]{0,38}[A-Za-z0-9]$/),
        (level, text, newContent) => {
          const heading = `${'#'.repeat(level)} ${text}`;
          const body = `${heading}\n\nexisting body.\n`;
          const located = mod.locateSection(body, { level, text });
          const spliced = mod.spliceAppend(body, located.splitLineIndex, newContent);
          expect(spliced.includes(heading)).toBe(true);
          expect(spliced.includes(newContent.trim())).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// Sentinel test so the file reports a passing case under the default config —
// without it, `describe.skip` would surface as "0 tests" and a future grep for
// `markdown-section.property` would miss it.
describe('markdown-section property tests — gating sentinel', () => {
  it('is skipped under the default jest config; see file-level comment', () => {
    expect(true).toBe(true);
  });
});
