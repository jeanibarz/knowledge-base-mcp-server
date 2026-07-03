import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_FACETS,
  aggregateFacets,
  collectTagsReport,
  extractFacetValues,
  formatTagsReport,
  parseTagsArgs,
  TAGS_SCHEMA_VERSION,
} from './cli-tags.js';

describe('parseTagsArgs', () => {
  it('defaults to the tags/status/type facet set, md format, all KBs', () => {
    const args = parseTagsArgs([]);
    expect(args.facets).toEqual([...DEFAULT_FACETS]);
    expect(args.format).toBe('md');
    expect(args.kb).toBeUndefined();
  });

  it('parses --kb, --facet, and --format', () => {
    const args = parseTagsArgs(['--kb=work', '--facet=status', '--format=json']);
    expect(args.kb).toBe('work');
    expect(args.facets).toEqual(['status']);
    expect(args.format).toBe('json');
  });

  it('rejects empty --kb= and --facet=', () => {
    expect(() => parseTagsArgs(['--kb='])).toThrow('--kb=<name>');
    expect(() => parseTagsArgs(['--facet='])).toThrow('--facet=<name>');
  });

  it('rejects an invalid --format value', () => {
    expect(() => parseTagsArgs(['--format=xml'])).toThrow('invalid --format');
  });

  it('rejects unknown flags and positional arguments', () => {
    expect(() => parseTagsArgs(['--zzz'])).toThrow('unknown flag');
    expect(() => parseTagsArgs(['stray'])).toThrow('unexpected argument');
  });
});

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
  it('counts each value once per note and sorts by count then value', () => {
    const frontmatters = [
      { tags: ['llm', 'rag', 'llm'], status: 'draft' },
      { tags: ['llm', 'rag'], status: 'published' },
      { tags: ['rag'] },
    ];
    const [tags, status] = aggregateFacets(frontmatters, ['tags', 'status']);
    // 'llm' appears in 2 notes (deduped within note 0), 'rag' in 3 notes.
    expect(tags.values).toEqual([
      { value: 'rag', count: 3 },
      { value: 'llm', count: 2 },
    ]);
    expect(status.values).toEqual([
      { value: 'draft', count: 1 },
      { value: 'published', count: 1 },
    ]);
  });

  it('returns an empty value list for a facet no note carries', () => {
    const [facet] = aggregateFacets([{ tags: ['x'] }], ['type']);
    expect(facet).toEqual({ facet: 'type', values: [] });
  });
});

describe('collectTagsReport (filesystem)', () => {
  async function makeKbRoot(prefix: string): Promise<{ rootDir: string; cleanup: () => Promise<void> }> {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    const rootDir = path.join(tempDir, 'kbs');
    await fsp.mkdir(rootDir, { recursive: true });
    return {
      rootDir,
      cleanup: async () => fsp.rm(tempDir, { recursive: true, force: true }),
    };
  }

  async function writeNote(rootDir: string, rel: string, body: string): Promise<void> {
    const full = path.join(rootDir, rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, body, 'utf-8');
  }

  it('aggregates facet values across notes in a scoped KB', async () => {
    const { rootDir, cleanup } = await makeKbRoot('kb-tags-fs-');
    try {
      await writeNote(rootDir, 'work/a.md', '---\ntags: [llm, rag]\nstatus: draft\n---\nbody\n');
      await writeNote(rootDir, 'work/nested/b.md', '---\ntags:\n  - rag\ntype: note\n---\nbody\n');
      await writeNote(rootDir, 'work/no-frontmatter.md', '# just a heading\n');
      // A different KB must be excluded when --kb scopes the scan.
      await writeNote(rootDir, 'other/c.md', '---\ntags: [ignored]\n---\n');

      const report = await collectTagsReport({
        rootDir,
        kbFilter: 'work',
        facets: [...DEFAULT_FACETS],
      });

      expect(report.kbs).toEqual(['work']);
      expect(report.notesScanned).toBe(3);
      const tags = report.facets.find((f) => f.facet === 'tags');
      expect(tags?.values).toEqual([
        { value: 'rag', count: 2 },
        { value: 'llm', count: 1 },
      ]);
      const status = report.facets.find((f) => f.facet === 'status');
      expect(status?.values).toEqual([{ value: 'draft', count: 1 }]);
    } finally {
      await cleanup();
    }
  });

  it('scans every KB when no filter is given', async () => {
    const { rootDir, cleanup } = await makeKbRoot('kb-tags-all-');
    try {
      await writeNote(rootDir, 'k1/a.md', '---\ntags: [x]\n---\n');
      await writeNote(rootDir, 'k2/b.md', '---\ntags: [x, y]\n---\n');
      const report = await collectTagsReport({ rootDir, facets: ['tags'] });
      expect(report.kbs).toEqual(['k1', 'k2']);
      expect(report.notesScanned).toBe(2);
      expect(report.facets[0].values).toEqual([
        { value: 'x', count: 2 },
        { value: 'y', count: 1 },
      ]);
    } finally {
      await cleanup();
    }
  });

  it('returns empty facets for a KB with no matching frontmatter', async () => {
    const { rootDir, cleanup } = await makeKbRoot('kb-tags-empty-');
    try {
      await writeNote(rootDir, 'k/a.md', '# no frontmatter here\n');
      const report = await collectTagsReport({ rootDir, kbFilter: 'k', facets: ['tags'] });
      expect(report.notesScanned).toBe(1);
      expect(report.facets[0].values).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe('formatTagsReport', () => {
  const report = {
    kbs: ['work'],
    notesScanned: 3,
    facets: [
      { facet: 'tags', values: [{ value: 'rag', count: 2 }, { value: 'llm', count: 1 }] },
      { facet: 'status', values: [] },
    ],
  };

  it('renders an aligned md table with a scan summary', () => {
    const out = formatTagsReport(report, 'md');
    expect(out).toContain('tags — 2 distinct value(s)');
    expect(out).toContain('  rag  2');
    expect(out).toContain('  llm  1');
    expect(out).toContain('status — no values found');
    expect(out).toContain('Scanned 3 note(s) across 1 KB(s).');
  });

  it('renders a stable json shape', () => {
    const parsed = JSON.parse(formatTagsReport(report, 'json'));
    expect(parsed).toEqual({
      schemaVersion: TAGS_SCHEMA_VERSION,
      knowledgeBases: ['work'],
      notesScanned: 3,
      facets: {
        tags: [{ value: 'rag', count: 2 }, { value: 'llm', count: 1 }],
        status: [],
      },
    });
  });
});
