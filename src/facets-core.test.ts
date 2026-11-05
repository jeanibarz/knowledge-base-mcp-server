// Tests for the command-independent facet core (issue #1151). The `kb tags`
// CLI adapter and the `list_facets` MCP tool both delegate here, so this pins
// the pure aggregation, the stable JSON payload shape, and the disk scan +
// KB_NOT_FOUND fail-closed contract directly against the module.

import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  aggregateFacets,
  buildFacetsJsonPayload,
  collectTagsReport,
  DEFAULT_FACETS,
  extractFacetValues,
  formatTagsReport,
  TAGS_SCHEMA_VERSION,
  type TagsReport,
} from './facets-core.js';
import { KBError } from './errors.js';

describe('extractFacetValues', () => {
  it('splits array values, trims, and drops empties/non-strings', () => {
    expect(extractFacetValues(['  a ', 'b', '', 3, null])).toEqual(['a', 'b']);
  });

  it('coerces a bare string to a single value', () => {
    expect(extractFacetValues('  draft ')).toEqual(['draft']);
  });

  it('yields nothing for missing or non-facet shapes', () => {
    expect(extractFacetValues(undefined)).toEqual([]);
    expect(extractFacetValues({ nested: true })).toEqual([]);
  });
});

describe('aggregateFacets', () => {
  it('counts each value once per note and sorts by count desc then value asc', () => {
    const [tags] = aggregateFacets(
      [{ tags: ['deploy', 'ops'] }, { tags: ['deploy'] }, { tags: ['ops'] }],
      ['tags'],
    );
    expect(tags).toEqual({
      facet: 'tags',
      values: [
        { value: 'deploy', count: 2 },
        { value: 'ops', count: 2 },
      ],
    });
  });

  it('does not double-count a value repeated within one note', () => {
    const [tags] = aggregateFacets([{ tags: ['x', 'x', 'x'] }], ['tags']);
    expect(tags.values).toEqual([{ value: 'x', count: 1 }]);
  });

  it('breaks count ties by ascending value, not note/insertion order', () => {
    // 'zeta' is seen first, 'alpha' second, both count 1. A dropped or reversed
    // value tiebreak would leave them in insertion order (zeta first); the
    // ascending tiebreak must surface 'alpha' first.
    const [tags] = aggregateFacets([{ tags: ['zeta'] }, { tags: ['alpha'] }], ['tags']);
    expect(tags.values).toEqual([
      { value: 'alpha', count: 1 },
      { value: 'zeta', count: 1 },
    ]);
  });

  it('returns an empty value list for a facet no note carries', () => {
    expect(aggregateFacets([{ tags: ['a'] }], ['status'])).toEqual([
      { facet: 'status', values: [] },
    ]);
  });
});

describe('buildFacetsJsonPayload', () => {
  const report: TagsReport = {
    kbs: ['alpha', 'beta'],
    notesScanned: 3,
    facets: [
      { facet: 'tags', values: [{ value: 'deploy', count: 2 }] },
      { facet: 'status', values: [] },
    ],
  };

  it('produces the stable kb.tags.v1 wire shape keyed by facet name', () => {
    expect(buildFacetsJsonPayload(report)).toEqual({
      // Pin the literal wire version, not the constant under test, so a changed
      // constant is caught here rather than silently tracked.
      schemaVersion: 'kb.tags.v1',
      knowledgeBases: ['alpha', 'beta'],
      notesScanned: 3,
      facets: {
        tags: [{ value: 'deploy', count: 2 }],
        status: [],
      },
    });
  });

  it('pins the schema version constant to its wire literal', () => {
    expect(TAGS_SCHEMA_VERSION).toBe('kb.tags.v1');
  });

  it('is exactly what formatTagsReport emits for json (sans trailing newline)', () => {
    expect(formatTagsReport(report, 'json')).toBe(
      `${JSON.stringify(buildFacetsJsonPayload(report), null, 2)}\n`,
    );
  });
});

describe('collectTagsReport', () => {
  async function makeRoot(
    kbs: Record<string, Record<string, string>>,
  ): Promise<string> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'facets-core-'));
    for (const [kb, notes] of Object.entries(kbs)) {
      for (const [rel, body] of Object.entries(notes)) {
        const full = path.join(root, kb, rel);
        await fsp.mkdir(path.dirname(full), { recursive: true });
        await fsp.writeFile(full, body, 'utf-8');
      }
    }
    return root;
  }

  const note = (frontmatter: string): string => `---\n${frontmatter}\n---\nbody\n`;

  it('scans every KB by default and returns a non-empty aggregated report', async () => {
    const root = await makeRoot({
      alpha: { 'a.md': note('tags: [deploy]\nstatus: draft') },
      beta: { 'b.md': note('tags: [deploy, ops]') },
    });

    const report = await collectTagsReport({ rootDir: root, facets: [...DEFAULT_FACETS] });

    expect(report.kbs).toEqual(['alpha', 'beta']);
    expect(report.notesScanned).toBe(2);
    expect(report.facets.map((f) => f.facet)).toEqual(['tags', 'status', 'type']);
    const tags = report.facets.find((f) => f.facet === 'tags');
    expect(tags?.values).toEqual([
      { value: 'deploy', count: 2 },
      { value: 'ops', count: 1 },
    ]);
  });

  it('scopes to a single KB when kbFilter is set', async () => {
    const root = await makeRoot({
      alpha: { 'a.md': note('tags: [alpha-only]') },
      beta: { 'b.md': note('tags: [beta-only]') },
    });

    const report = await collectTagsReport({
      rootDir: root,
      kbFilter: 'alpha',
      facets: ['tags'],
    });

    expect(report.kbs).toEqual(['alpha']);
    expect(report.facets[0].values).toEqual([{ value: 'alpha-only', count: 1 }]);
  });

  it('throws KB_NOT_FOUND for an unknown kbFilter (fail closed)', async () => {
    const root = await makeRoot({ alpha: { 'a.md': note('tags: [x]') } });

    await expect(
      collectTagsReport({ rootDir: root, kbFilter: 'missing', facets: ['tags'] }),
    ).rejects.toMatchObject({ code: 'KB_NOT_FOUND' });
    // And it is a real KBError, not a bare Error with a stray property.
    await expect(
      collectTagsReport({ rootDir: root, kbFilter: 'missing', facets: ['tags'] }),
    ).rejects.toBeInstanceOf(KBError);
  });
});
