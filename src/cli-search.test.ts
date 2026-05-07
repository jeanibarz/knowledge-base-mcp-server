import { describe, expect, it } from '@jest/globals';
import { formatFreshnessFooter, Staleness } from './cli-search.js';

const MTIME = '2026-05-03T15:33:56.964Z';

describe('formatFreshnessFooter', () => {
  it('reports "not yet built" when indexMtime is null', () => {
    const s: Staleness = { indexMtime: null, modifiedFiles: 0, newFiles: 0 };
    expect(formatFreshnessFooter(s, false)).toBe(
      '> _Index not yet built. Run `kb search --refresh` to create it._',
    );
  });

  it('reports a refresh confirmation when refreshed=true', () => {
    const s: Staleness = { indexMtime: MTIME, modifiedFiles: 0, newFiles: 17 };
    expect(formatFreshnessFooter(s, true)).toBe(`> _Index refreshed at ${MTIME}._`);
  });

  it('reports up-to-date when neither modified nor new files exist', () => {
    const s: Staleness = { indexMtime: MTIME, modifiedFiles: 0, newFiles: 0 };
    expect(formatFreshnessFooter(s, false)).toBe(`> _Index up-to-date as of ${MTIME}._`);
  });

  it('uses a gentle hint (no "may be stale") when only new files were added', () => {
    const s: Staleness = { indexMtime: MTIME, modifiedFiles: 0, newFiles: 1857 };
    const out = formatFreshnessFooter(s, false);
    expect(out).toBe(
      `> _1857 new file(s) since ${MTIME}; run \`kb search --refresh\` to include them._`,
    );
    expect(out).not.toMatch(/may be stale/);
  });

  it('still warns "may be stale" when at least one file was modified', () => {
    const s: Staleness = { indexMtime: MTIME, modifiedFiles: 3, newFiles: 0 };
    expect(formatFreshnessFooter(s, false)).toBe(
      `> _Index may be stale: 3 modified, 0 new file(s) since ${MTIME}. Run \`kb search --refresh\` to update._`,
    );
  });

  it('still warns "may be stale" when files were both modified and added', () => {
    const s: Staleness = { indexMtime: MTIME, modifiedFiles: 2, newFiles: 5 };
    expect(formatFreshnessFooter(s, false)).toBe(
      `> _Index may be stale: 2 modified, 5 new file(s) since ${MTIME}. Run \`kb search --refresh\` to update._`,
    );
  });
});
