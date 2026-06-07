import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  citationEntryFromFrontmatter,
  formatCitation,
  normalizeAuthors,
  parseCiteArgs,
  runCite,
  type RunCiteDeps,
} from './cli-cite.js';

describe('kb cite', () => {
  it('parses the required path selector and format option', () => {
    expect(parseCiteArgs(['research/paper.md'])).toEqual({
      target: 'research/paper.md',
      format: 'bibtex',
    });
    expect(parseCiteArgs(['research/paper.md', '--format=csl-json'])).toEqual({
      target: 'research/paper.md',
      format: 'csl-json',
    });
    expect(() => parseCiteArgs([])).toThrow('missing <chunk-id|kb://uri|kb-relative-path>');
    expect(() => parseCiteArgs(['research/paper.md', '--format=json'])).toThrow('invalid --format');
  });

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

  it('resolves a note path, reads frontmatter, and writes the requested format', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cite-'));
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

    const stdout: string[] = [];
    const stderr: string[] = [];
    const deps: RunCiteDeps = {
      rootDir: tempDir,
      readFile: (filePath) => fsp.readFile(filePath, 'utf-8'),
      stdout: (text) => { stdout.push(text); },
      stderr: (text) => { stderr.push(text); },
    };

    await expect(runCite(['research/papers/paper.md', '--format=text'], deps)).resolves.toBe(0);
    expect(stderr.join('')).toBe('');
    expect(stdout.join('')).toBe(
      '[lovelace-1843-example] Ada Lovelace. (1843). Example Paper. DOI: 10.1000/example. KB note: research/papers/paper.md\n',
    );
  });

  it('returns input and runtime exit codes for bad selectors and missing files', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cite-errors-'));
    await fsp.mkdir(path.join(tempDir, 'research'), { recursive: true });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const deps: RunCiteDeps = {
      rootDir: tempDir,
      readFile: (filePath) => fsp.readFile(filePath, 'utf-8'),
      stdout: (text) => { stdout.push(text); },
      stderr: (text) => { stderr.push(text); },
    };

    await expect(runCite(['not-a-reference'], deps)).resolves.toBe(2);
    await expect(runCite(['research/missing.md'], deps)).resolves.toBe(1);
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toContain("cannot parse reference 'not-a-reference'");
    expect(stderr.join('')).toContain('path not found: "missing.md"');
  });
});
