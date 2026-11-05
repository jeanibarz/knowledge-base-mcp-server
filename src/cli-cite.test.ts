import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  parseCiteArgs,
  runCite,
  type RunCiteDeps,
} from './cli-cite.js';

describe('kb cite', () => {
  it('parses the required path selector and format option', () => {
    expect(parseCiteArgs(['research/paper.md'])).toEqual({
      targets: ['research/paper.md'],
      format: 'bibtex',
    });
    expect(parseCiteArgs(['research/paper.md', '--format=csl-json'])).toEqual({
      targets: ['research/paper.md'],
      format: 'csl-json',
    });
    expect(parseCiteArgs(['research/paper.md', '--format=ris'])).toEqual({
      targets: ['research/paper.md'],
      format: 'ris',
    });
    expect(() => parseCiteArgs([])).toThrow('missing <chunk-id|kb://uri|kb-relative-path>');
    expect(() => parseCiteArgs(['research/paper.md', '--format=json'])).toThrow('invalid --format');
  });

  it('collects multiple selectors in order regardless of --format position (#1158)', () => {
    expect(parseCiteArgs(['a.md', 'b.md', 'c.md'])).toEqual({
      targets: ['a.md', 'b.md', 'c.md'],
      format: 'bibtex',
    });
    // --format may precede, follow, or sit between selectors; selector order is
    // preserved while the flag is pulled out wherever it appears.
    expect(parseCiteArgs(['a.md', '--format=text', 'b.md'])).toEqual({
      targets: ['a.md', 'b.md'],
      format: 'text',
    });
    // A flag with no positional selector is still the missing-selector error.
    expect(() => parseCiteArgs(['--format=text'])).toThrow(
      'missing <chunk-id|kb://uri|kb-relative-path>',
    );
  });

  it('writes a valid RIS record for --format=ris', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cite-ris-'));
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

    await expect(runCite(['research/papers/paper.md', '--format=ris'], deps)).resolves.toBe(0);
    expect(stderr.join('')).toBe('');
    expect(stdout.join('')).toBe(
      [
        'TY  - JOUR',
        'TI  - Example Paper',
        'AU  - Ada Lovelace',
        'PY  - 1843',
        'DO  - 10.1000/example',
        'N1  - KB note: research/papers/paper.md',
        'ER  - ',
      ].join('\n') + '\n',
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

  it('merges multiple selectors into one BibTeX bibliography, deduped by cite key (#1158)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cite-multi-'));
    await fsp.mkdir(path.join(tempDir, 'research', 'papers'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'research', 'papers', 'a.md'), [
      '---', 'title: Alpha', 'authors:', '  - Ada Lovelace', 'published: 1843', '---', '', 'body',
    ].join('\n'));
    await fsp.writeFile(path.join(tempDir, 'research', 'papers', 'b.md'), [
      '---', 'title: Beta', 'authors:', '  - Grace Hopper', 'published: 1952', '---', '', 'body',
    ].join('\n'));

    const stdout: string[] = [];
    const stderr: string[] = [];
    const deps: RunCiteDeps = {
      rootDir: tempDir,
      readFile: (filePath) => fsp.readFile(filePath, 'utf-8'),
      stdout: (text) => { stdout.push(text); },
      stderr: (text) => { stderr.push(text); },
    };

    // a.md is cited twice; the duplicate cite key collapses to one entry.
    await expect(
      runCite(['research/papers/a.md', 'research/papers/b.md', 'research/papers/a.md'], deps),
    ).resolves.toBe(0);
    expect(stderr.join('')).toBe('');
    expect(stdout.join('')).toBe(
      [
        '@misc{lovelace-1843-alpha,',
        '  author = {Ada Lovelace},',
        '  title = {Alpha},',
        '  year = {1843},',
        '  note = {KB note: research/papers/a.md},',
        '}',
        '',
        '@misc{hopper-1952-beta,',
        '  author = {Grace Hopper},',
        '  title = {Beta},',
        '  year = {1952},',
        '  note = {KB note: research/papers/b.md},',
        '}',
      ].join('\n') + '\n',
    );
  });

  it('merges multiple selectors into one CSL-JSON array (#1158)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cite-multi-csl-'));
    await fsp.mkdir(path.join(tempDir, 'p'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'p', 'a.md'), ['---', 'title: Alpha', 'published: 1843', '---', ''].join('\n'));
    await fsp.writeFile(path.join(tempDir, 'p', 'b.md'), ['---', 'title: Beta', 'published: 1952', '---', ''].join('\n'));

    const stdout: string[] = [];
    const deps: RunCiteDeps = {
      rootDir: tempDir,
      readFile: (filePath) => fsp.readFile(filePath, 'utf-8'),
      stdout: (text) => { stdout.push(text); },
      stderr: () => {},
    };

    await expect(runCite(['p/a.md', 'p/b.md', '--format=csl-json'], deps)).resolves.toBe(0);
    const parsed = JSON.parse(stdout.join('')) as Array<{ id: string }>;
    // One combined array (not two one-element arrays), order preserved.
    expect(parsed).toHaveLength(2);
    expect(parsed.map((e) => e.id)).toEqual(['alpha-1843-alpha', 'beta-1952-beta']);
  });

  it('is all-or-nothing: a later failing selector sets the exit code and writes no output (#1158)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-cite-multi-fail-'));
    await fsp.mkdir(path.join(tempDir, 'research'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'research', 'a.md'), ['---', 'title: Alpha', '---', ''].join('\n'));

    const stdout: string[] = [];
    const stderr: string[] = [];
    const deps: RunCiteDeps = {
      rootDir: tempDir,
      readFile: (filePath) => fsp.readFile(filePath, 'utf-8'),
      stdout: (text) => { stdout.push(text); },
      stderr: (text) => { stderr.push(text); },
    };

    // First selector resolves, second is missing → exit 1, nothing on stdout.
    await expect(runCite(['research/a.md', 'research/missing.md'], deps)).resolves.toBe(1);
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toContain('path not found: "missing.md"');

    // A malformed selector anywhere still maps to the input-error exit 2.
    stdout.length = 0;
    stderr.length = 0;
    await expect(runCite(['research/a.md', 'not-a-reference'], deps)).resolves.toBe(2);
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toContain("cannot parse reference 'not-a-reference'");
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
