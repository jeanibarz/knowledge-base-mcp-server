import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  citationEntryFromFrontmatter,
  CitationReadError,
  formatCitation,
  formatCitations,
  normalizeAuthors,
  resolveCitationEntries,
  resolveCitationEntry,
  type CitationResolutionDeps,
} from './citation-core.js';
import { KBError } from './errors.js';

describe('citation-core formatting', () => {
  it('normalizes author string and array forms conservatively', () => {
    expect(normalizeAuthors(['Ada Lovelace', 'Grace Hopper', 42])).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
    ]);
    expect(normalizeAuthors('Ada Lovelace and Grace Hopper')).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
    ]);
    expect(normalizeAuthors('Ada Lovelace, Grace Hopper, Katherine Johnson')).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
      'Katherine Johnson',
    ]);
    expect(normalizeAuthors('Lovelace, Ada')).toEqual(['Lovelace, Ada']);
  });

  it('builds a deterministic BibTeX entry from scholarly frontmatter', () => {
    const entry = citationEntryFromFrontmatter({
      arxiv_id: '2604.21215',
      authors: 'Costin-Andrei Oncescu, Jane Smith, Alex Kim',
      published: '2026-04-23',
      title: 'The Recurrent Transformer: Efficient Long Context',
      doi: 'https://doi.org/10.5555/example.42',
    }, 'arxiv-llm-inference/papers/recurrent-transformer.md');

    expect(entry.key).toBe('oncescu-2026-260421215');
    expect(formatCitation(entry, 'bibtex')).toBe(`@article{oncescu-2026-260421215,
  author = {Costin-Andrei Oncescu and Jane Smith and Alex Kim},
  title = {The Recurrent Transformer: Efficient Long Context},
  year = {2026},
  doi = {10.5555/example.42},
  url = {https://arxiv.org/abs/2604.21215},
  eprint = {2604.21215},
  archivePrefix = {arXiv},
  note = {KB note: arxiv-llm-inference/papers/recurrent-transformer.md},
}`);
  });

  it('emits CSL-JSON with literal authors and issued date parts', () => {
    const entry = citationEntryFromFrontmatter({
      authors: ['Ada Lovelace', 'Grace Hopper'],
      published: '1843-09',
      title: 'Notes on Analytical Engines',
      url: 'https://example.test/notes',
    }, 'history/notes/analytical-engine.md');

    expect(JSON.parse(formatCitation(entry, 'csl-json'))).toEqual([
      {
        id: 'lovelace-1843-notesonanalyticalengines',
        type: 'article',
        title: 'Notes on Analytical Engines',
        author: [{ literal: 'Ada Lovelace' }, { literal: 'Grace Hopper' }],
        issued: { 'date-parts': [[1843, 9]] },
        URL: 'https://example.test/notes',
        note: 'KB note: history/notes/analytical-engine.md',
      },
    ]);
  });

  it('emits a RIS record with JOUR type for a typical scholarly note', () => {
    const entry = citationEntryFromFrontmatter({
      authors: ['Ada Lovelace', 'Grace Hopper'],
      published: '1843-09',
      title: 'Notes on Analytical Engines',
      doi: 'https://doi.org/10.1000/example',
      url: 'https://example.test/notes',
    }, 'history/notes/analytical-engine.md');

    const ris = formatCitation(entry, 'ris');
    expect(ris).toBe(
      [
        'TY  - JOUR',
        'TI  - Notes on Analytical Engines',
        'AU  - Ada Lovelace',
        'AU  - Grace Hopper',
        'PY  - 1843',
        'DO  - 10.1000/example',
        'UR  - https://example.test/notes',
        'N1  - KB note: history/notes/analytical-engine.md',
        'ER  - ',
      ].join('\n'),
    );
    // Acceptance criteria: a valid RIS record begins `TY  - ` and ends `ER  - `.
    expect(ris.startsWith('TY  - ')).toBe(true);
    expect(ris.endsWith('ER  - ')).toBe(true);
  });

  it('falls back to TY=GEN for a note without a DOI-derived type', () => {
    const entry = citationEntryFromFrontmatter({}, 'notes/plain-note.md');

    expect(formatCitation(entry, 'ris')).toBe(
      ['TY  - GEN', 'N1  - KB note: notes/plain-note.md', 'ER  - '].join('\n'),
    );
  });

  it('collapses multi-line/multi-space RIS values and emits arXiv id + derived URL', () => {
    const entry = citationEntryFromFrontmatter({
      arxiv_id: '2604.21215',
      authors: ['Ada   Lovelace', 'Grace\tHopper'],
      published: '2026-04-23',
      title: 'The  Recurrent\nTransformer',
    }, 'arxiv-llm-inference/papers/recurrent-transformer.md');

    // No DOI → TY=GEN; whitespace in title/authors is collapsed so a multi-line
    // value cannot break the one-line tag grammar; the arXiv id rides in an N1
    // note while its abstract URL (derived upstream) is the UR line.
    expect(formatCitation(entry, 'ris')).toBe(
      [
        'TY  - GEN',
        'TI  - The Recurrent Transformer',
        'AU  - Ada Lovelace',
        'AU  - Grace Hopper',
        'PY  - 2026',
        'UR  - https://arxiv.org/abs/2604.21215',
        'N1  - KB note: arxiv-llm-inference/papers/recurrent-transformer.md',
        'N1  - arXiv: 2604.21215',
        'ER  - ',
      ].join('\n'),
    );
  });

  it('treats a malformed empty DOI as absent in RIS (no bare DO tag, TY=GEN)', () => {
    // normalizeDoi reduces "doi:" to "", which must not surface as a valueless
    // `DO  - ` line nor promote the reference type to JOUR.
    const entry = citationEntryFromFrontmatter({ doi: 'doi:' }, 'notes/plain-note.md');

    expect(entry.doi).toBe('');
    expect(formatCitation(entry, 'ris')).toBe(
      ['TY  - GEN', 'N1  - KB note: notes/plain-note.md', 'ER  - '].join('\n'),
    );
  });

  it('degrades gracefully when citation frontmatter is missing', () => {
    const entry = citationEntryFromFrontmatter({}, 'notes/plain-note.md');

    expect(entry.key).toBe('plainnote-nd-plainnote');
    expect(formatCitation(entry, 'bibtex')).toBe(`@misc{plainnote-nd-plainnote,
  note = {KB note: notes/plain-note.md},
}`);
    expect(formatCitation(entry, 'text')).toBe(
      '[plainnote-nd-plainnote] KB note: notes/plain-note.md',
    );
  });
});

// Merge of several resolved entries into one bibliography, shared by `kb cite`
// and export_citations so both emit identical merged output (#1158).
describe('formatCitations (merge)', () => {
  const alpha = citationEntryFromFrontmatter(
    { title: 'Alpha', authors: ['Ada Lovelace'], published: '1843' },
    'kb/a.md',
  );
  const beta = citationEntryFromFrontmatter(
    { title: 'Beta', authors: ['Grace Hopper'], published: '1952' },
    'kb/b.md',
  );

  it('renders a single entry with no record separator and a one-element CSL array', () => {
    // Literal expectations (not `formatCitation(...)`, which now delegates here —
    // comparing the two would be a tautology). These pin that a single-selector
    // call is unchanged from #1153: a bare record with no blank-line separator,
    // a one-line text reference, and a one-element CSL-JSON array.
    expect(formatCitations([alpha], 'bibtex')).toBe(
      [
        '@misc{lovelace-1843-alpha,',
        '  author = {Ada Lovelace},',
        '  title = {Alpha},',
        '  year = {1843},',
        '  note = {KB note: kb/a.md},',
        '}',
      ].join('\n'),
    );
    expect(formatCitations([alpha], 'text')).toBe(
      '[lovelace-1843-alpha] Ada Lovelace. (1843). Alpha. KB note: kb/a.md',
    );
    const parsedCsl = JSON.parse(formatCitations([alpha], 'csl-json')) as unknown[];
    expect(parsedCsl).toHaveLength(1);
    // A single entry must never introduce the `\n\n` record separator.
    expect(formatCitations([alpha], 'bibtex')).not.toContain('\n\n');
    expect(formatCitations([alpha], 'ris')).not.toContain('\n\n');
  });

  it('dedupes DISTINCT notes that collide on cite key, keeping the first occurrence', () => {
    // Two different files with identical author/title/year resolve to the same
    // cite key — the real case dedup exists for. Pins dedup-by-KEY (not by
    // notePath) and first-wins across every format, killing a dedup-by-path or
    // keep-last mutant.
    const first = citationEntryFromFrontmatter(
      { title: 'Alpha', authors: ['Ada Lovelace'], published: '1843' },
      'kb/first.md',
    );
    const second = citationEntryFromFrontmatter(
      { title: 'Alpha', authors: ['Ada Lovelace'], published: '1843' },
      'kb/second.md',
    );
    expect(first.key).toBe(second.key); // precondition: a genuine key collision
    for (const format of ['bibtex', 'text', 'ris'] as const) {
      const merged = formatCitations([first, second], format);
      expect(merged).toContain('kb/first.md');
      expect(merged).not.toContain('kb/second.md');
    }
    const csl = JSON.parse(formatCitations([first, second], 'csl-json')) as Array<{ note: string }>;
    expect(csl).toHaveLength(1);
    expect(csl[0].note).toContain('kb/first.md');
  });

  it('concatenates BibTeX entries with a blank line and dedupes by cite key', () => {
    // alpha appears twice → one entry; order follows first occurrence.
    expect(formatCitations([alpha, beta, alpha], 'bibtex')).toBe(
      `${formatCitation(alpha, 'bibtex')}\n\n${formatCitation(beta, 'bibtex')}`,
    );
  });

  it('merges CSL-JSON into one combined array (deduped), not N one-element arrays', () => {
    const parsed = JSON.parse(formatCitations([alpha, beta, alpha], 'csl-json')) as Array<{ id: string }>;
    expect(parsed.map((e) => e.id)).toEqual(['lovelace-1843-alpha', 'hopper-1952-beta']);
  });

  it('prints one text line per source and concatenates RIS records with a blank line', () => {
    expect(formatCitations([alpha, beta], 'text')).toBe(
      `${formatCitation(alpha, 'text')}\n${formatCitation(beta, 'text')}`,
    );
    expect(formatCitations([alpha, beta], 'ris')).toBe(
      `${formatCitation(alpha, 'ris')}\n\n${formatCitation(beta, 'ris')}`,
    );
  });
});

// The selector→entry core shared verbatim with both `kb cite` (cli-cite.ts) and
// the export_citations MCP tool (#1153), so both surfaces produce one citation.
describe('resolveCitationEntry', () => {
  it('resolves a note path and builds a CitationEntry from frontmatter', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cite-core-'));
    await fsp.mkdir(path.join(tempDir, 'research', 'papers'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'research', 'papers', 'paper.md'), [
      '---',
      'title: Example Paper',
      'authors:',
      '  - Ada Lovelace',
      'published: 1843-01-01',
      'doi: doi:10.1000/example',
      '---',
      '',
      '# Example Paper',
      '',
    ].join('\n'));

    const deps: CitationResolutionDeps = {
      rootDir: tempDir,
      readFile: (filePath) => fsp.readFile(filePath, 'utf-8'),
    };

    const entry = await resolveCitationEntry('research/papers/paper.md', deps);
    expect(entry.key).toBe('lovelace-1843-example');
    expect(entry.notePath).toBe('research/papers/paper.md');
    expect(entry.authors).toEqual(['Ada Lovelace']);
    expect(entry.doi).toBe('10.1000/example');
  });

  it('promotes a malformed selector to a VALIDATION KBError', async () => {
    const deps: CitationResolutionDeps = {
      rootDir: await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cite-core-bad-')),
      readFile: (filePath) => fsp.readFile(filePath, 'utf-8'),
    };

    await expect(resolveCitationEntry('not-a-reference', deps)).rejects.toMatchObject({
      name: 'KBError',
      code: 'VALIDATION',
    });
    await expect(resolveCitationEntry('not-a-reference', deps)).rejects.toBeInstanceOf(KBError);
  });

  it('throws CitationReadError when the resolved note cannot be read', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cite-core-read-'));
    await fsp.mkdir(path.join(tempDir, 'research', 'papers'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'research', 'papers', 'paper.md'), '# body\n');

    const deps: CitationResolutionDeps = {
      rootDir: tempDir,
      readFile: () => Promise.reject(new Error('EIO: simulated read failure')),
    };

    const error = await resolveCitationEntry('research/papers/paper.md', deps).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CitationReadError);
    expect((error as CitationReadError).displayPath).toBe('research/papers/paper.md');
    expect((error as CitationReadError).message).toContain('failed to read research/papers/paper.md');
  });
});

// The multi-selector resolver behind `kb cite A B` and export_citations with an
// array (#1158): resolve in order, fail fast on the first failing selector.
describe('resolveCitationEntries', () => {
  async function writeNotes(): Promise<CitationResolutionDeps> {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cite-core-multi-'));
    await fsp.mkdir(path.join(tempDir, 'p'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'p', 'a.md'), ['---', 'title: Alpha', '---', ''].join('\n'));
    await fsp.writeFile(path.join(tempDir, 'p', 'b.md'), ['---', 'title: Beta', '---', ''].join('\n'));
    return { rootDir: tempDir, readFile: (filePath) => fsp.readFile(filePath, 'utf-8') };
  }

  it('resolves every selector preserving argument order', async () => {
    const deps = await writeNotes();
    const entries = await resolveCitationEntries(['p/b.md', 'p/a.md'], deps);
    expect(entries.map((e) => e.notePath)).toEqual(['p/b.md', 'p/a.md']);
  });

  it('rejects with a missing note after an earlier selector resolves (path-not-found propagates)', async () => {
    const deps = await writeNotes();
    // Second selector is a valid KB but a missing note: resolveKbPath throws a
    // plain "path not found" Error, and that exact error propagates.
    await expect(resolveCitationEntries(['p/a.md', 'p/missing.md'], deps)).rejects.toThrow(
      'path not found: "missing.md"',
    );
  });

  it('promotes a malformed selector to VALIDATION even when earlier selectors resolve', async () => {
    const deps = await writeNotes();
    await expect(
      resolveCitationEntries(['p/a.md', 'not-a-reference'], deps),
    ).rejects.toMatchObject({ name: 'KBError', code: 'VALIDATION' });
  });

  it('throws the FIRST failing selector in argument order, not a race winner', async () => {
    const deps = await writeNotes();
    // Both selectors fail, but with DIFFERENT errors. Sequential in-order
    // resolution means the first one decides, so the error class flips with the
    // order — killing a Promise.all (race) or order-reversed mutant.
    await expect(
      resolveCitationEntries(['not-a-reference', 'p/missing.md'], deps),
    ).rejects.toMatchObject({ name: 'KBError', code: 'VALIDATION' });
    await expect(
      resolveCitationEntries(['p/missing.md', 'not-a-reference'], deps),
    ).rejects.toThrow('path not found: "missing.md"');
  });
});
