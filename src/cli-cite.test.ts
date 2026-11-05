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
      target: 'research/paper.md',
      format: 'bibtex',
    });
    expect(parseCiteArgs(['research/paper.md', '--format=csl-json'])).toEqual({
      target: 'research/paper.md',
      format: 'csl-json',
    });
    expect(parseCiteArgs(['research/paper.md', '--format=ris'])).toEqual({
      target: 'research/paper.md',
      format: 'ris',
    });
    expect(() => parseCiteArgs([])).toThrow('missing <chunk-id|kb://uri|kb-relative-path>');
    expect(() => parseCiteArgs(['research/paper.md', '--format=json'])).toThrow('invalid --format');
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
