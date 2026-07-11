import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createTestCorpus } from './test-support/corpus.js';
import {
  extractReferences,
  formatReport,
  parseStaleCheckArgs,
  staleCheck,
  type UrlChecker,
} from './cli-stale-check.js';

describe('parseStaleCheckArgs', () => {
  it('parses --kb=<name>', () => {
    expect(parseStaleCheckArgs(['--kb=ops']).kb).toBe('ops');
  });
  it('rejects empty --kb=', () => {
    expect(() => parseStaleCheckArgs(['--kb='])).toThrow('--kb=<name>');
  });
  it('rejects unknown flags', () => {
    expect(() => parseStaleCheckArgs(['--zzz'])).toThrow('unknown flag');
  });
  it('toggles --no-cache and --verbose', () => {
    const a = parseStaleCheckArgs(['--no-cache', '--verbose']);
    expect(a.noCache).toBe(true);
    expect(a.verbose).toBe(true);
    expect(a.quiet).toBe(false);
  });
  it('defers --quiet / -q to the shared verbosity mechanism (#739)', () => {
    expect(parseStaleCheckArgs(['--quiet'])).toMatchObject({ quiet: true, verbose: false });
    expect(parseStaleCheckArgs(['-q'])).toMatchObject({ quiet: true, verbose: false });
    expect(parseStaleCheckArgs(['-v'])).toMatchObject({ quiet: false, verbose: true });
  });
});

describe('extractReferences', () => {
  it('finds bare https URLs and tilde paths on the same line', () => {
    const refs = extractReferences('see https://example.com/foo and ~/notes/bar.md ok\n');
    const types = refs.map((r) => `${r.type}:${r.value}`).sort();
    expect(types).toEqual([
      'tilde-path:~/notes/bar.md',
      'url:https://example.com/foo',
    ]);
    expect(refs.every((r) => r.line === 1)).toBe(true);
  });

  it('extracts markdown link targets (URL and relative path)', () => {
    const refs = extractReferences('[home](https://example.com)\n[doc](docs/intro.md)\n');
    const sig = refs.map((r) => `${r.type}:${r.value}@${r.line}`).sort();
    expect(sig).toEqual([
      'rel-path:docs/intro.md@2',
      'url:https://example.com@1',
    ]);
  });

  it('strips trailing punctuation glued to URLs', () => {
    const refs = extractReferences('See https://example.com/foo, then go.\n');
    expect(refs.find((r) => r.type === 'url')?.value).toBe('https://example.com/foo');
  });

  it('dedupes references that appear multiple times on the same line', () => {
    const refs = extractReferences('~/dup ~/dup ~/dup\n');
    expect(refs).toHaveLength(1);
  });

  it('ignores anchor-only and mailto: markdown links', () => {
    const refs = extractReferences('[a](#section) [b](mailto:x@y.z) [c](tel:+15551234)\n');
    expect(refs).toHaveLength(0);
  });

  it('does not flag plain "/usr/bin" prose absolute paths (MVP scope)', () => {
    const refs = extractReferences('the system uses /usr/bin/env to find node\n');
    expect(refs).toHaveLength(0);
  });
});

describe('staleCheck (filesystem + injected url checker)', () => {
  async function makeKb(prefix: string): Promise<{ rootDir: string; cleanup: () => Promise<void> }> {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    const rootDir = path.join(tempDir, 'kbs');
    await fsp.mkdir(rootDir, { recursive: true });
    return {
      rootDir,
      cleanup: async () => fsp.rm(tempDir, { recursive: true, force: true }),
    };
  }

  it('flags MISSING tilde paths, OK url, MISSING relative path', async () => {
    const corpus = await createTestCorpus({
      prefix: 'kb-stale-fs-',
      files: {
        'ops/note.md': [
          'Active: ~/this-path-should-not-exist-stale-check-test',
          'See https://example.com/ok',
          '[broken](missing.md)',
        ].join('\n') + '\n',
      },
    });
    try {
      const checker: UrlChecker = async () => ({ status: 'OK' });
      const report = await staleCheck({
        rootDir: corpus.rootDir,
        cachePath: null,
        urlChecker: checker,
      });

      expect(report.totals.filesScanned).toBe(1);
      expect(report.totals.referencesChecked).toBe(3);
      expect(report.totals.staleReferences).toBe(2);
      const stale = report.files[0].results.filter((r) => r.status !== 'OK');
      const types = stale.map((r) => r.type).sort();
      expect(types).toEqual(['rel-path', 'tilde-path']);
    } finally {
      await corpus.cleanup();
    }
  });

  it('reports HTTP errors from the url checker', async () => {
    const { rootDir, cleanup } = await makeKb('kb-stale-http-');
    try {
      const kbDir = path.join(rootDir, 'ops');
      await fsp.mkdir(kbDir, { recursive: true });
      await fsp.writeFile(
        path.join(kbDir, 'note.md'),
        'See https://example.invalid/foo\n',
        'utf-8',
      );

      const checker: UrlChecker = async () => ({ status: 'HTTP_ERROR', detail: 'HTTP 404' });
      const report = await staleCheck({ rootDir, cachePath: null, urlChecker: checker });

      expect(report.totals.staleReferences).toBe(1);
      const r = report.files[0].results[0];
      expect(r.status).toBe('HTTP_ERROR');
      expect(r.detail).toBe('HTTP 404');
    } finally {
      await cleanup();
    }
  });

  it('writes a cache file and reuses it across runs without re-checking', async () => {
    const { rootDir, cleanup } = await makeKb('kb-stale-cache-');
    try {
      const kbDir = path.join(rootDir, 'ops');
      await fsp.mkdir(kbDir, { recursive: true });
      await fsp.writeFile(
        path.join(kbDir, 'note.md'),
        'See https://example.com/cached\n',
        'utf-8',
      );
      const cachePath = path.join(rootDir, '.stale-check-cache.json');

      let calls = 0;
      const checker: UrlChecker = async () => {
        calls++;
        return { status: 'OK' };
      };

      await staleCheck({ rootDir, cachePath, urlChecker: checker });
      expect(calls).toBe(1);
      const cached = JSON.parse(await fsp.readFile(cachePath, 'utf-8'));
      expect(cached['https://example.com/cached']).toBeDefined();

      await staleCheck({ rootDir, cachePath, urlChecker: checker });
      expect(calls).toBe(1); // cache hit, no second call
    } finally {
      await cleanup();
    }
  });

  it('expires cache entries past the TTL', async () => {
    const { rootDir, cleanup } = await makeKb('kb-stale-cache-ttl-');
    try {
      const kbDir = path.join(rootDir, 'ops');
      await fsp.mkdir(kbDir, { recursive: true });
      await fsp.writeFile(
        path.join(kbDir, 'note.md'),
        'See https://example.com/ttl\n',
        'utf-8',
      );
      const cachePath = path.join(rootDir, '.stale-check-cache.json');
      await fsp.writeFile(
        cachePath,
        JSON.stringify({
          'https://example.com/ttl': {
            checkedAt: Date.now() - 25 * 60 * 60 * 1000,
            status: 'OK',
          },
        }),
        'utf-8',
      );

      let calls = 0;
      const checker: UrlChecker = async () => {
        calls++;
        return { status: 'OK' };
      };

      await staleCheck({ rootDir, cachePath, urlChecker: checker });
      expect(calls).toBe(1); // expired, re-checked
    } finally {
      await cleanup();
    }
  });

  it('honors --kb=<name> by scanning only that KB', async () => {
    const { rootDir, cleanup } = await makeKb('kb-stale-scope-');
    try {
      await fsp.mkdir(path.join(rootDir, 'a'), { recursive: true });
      await fsp.mkdir(path.join(rootDir, 'b'), { recursive: true });
      await fsp.writeFile(path.join(rootDir, 'a', 'x.md'), 'a:~/aa-bogus-target\n', 'utf-8');
      await fsp.writeFile(path.join(rootDir, 'b', 'x.md'), 'b:~/bb-bogus-target\n', 'utf-8');

      const checker: UrlChecker = async () => ({ status: 'OK' });
      const report = await staleCheck({ rootDir, cachePath: null, kbFilter: 'a', urlChecker: checker });

      expect(report.kbs).toEqual(['a']);
      expect(report.files).toHaveLength(1);
      expect(report.files[0].kb).toBe('a');
    } finally {
      await cleanup();
    }
  });

  it('skips dot-prefixed and .faiss directories', async () => {
    const { rootDir, cleanup } = await makeKb('kb-stale-hidden-');
    try {
      const kbDir = path.join(rootDir, 'ops');
      await fsp.mkdir(path.join(kbDir, '.index'), { recursive: true });
      await fsp.mkdir(path.join(kbDir, 'visible'), { recursive: true });
      await fsp.writeFile(path.join(kbDir, '.index', 'hidden.md'), '~/hidden-target\n', 'utf-8');
      await fsp.writeFile(path.join(kbDir, 'visible', 'note.md'), '~/visible-target\n', 'utf-8');

      const report = await staleCheck({
        rootDir,
        cachePath: null,
        urlChecker: async () => ({ status: 'OK' }),
      });
      expect(report.totals.filesScanned).toBe(1);
      expect(report.files[0].relPath).toBe('visible/note.md');
    } finally {
      await cleanup();
    }
  });
});

describe('formatReport', () => {
  it('reports "No drift" when totals.staleReferences is 0', () => {
    const out = formatReport({
      kbs: ['ops'],
      files: [{ kb: 'ops', relPath: 'a.md', results: [] }],
      totals: { filesScanned: 1, referencesChecked: 0, staleReferences: 0, filesWithStale: 0 },
    });
    expect(out).toContain('No drift');
  });

  it('lists stale references with line numbers and a summary', () => {
    const out = formatReport({
      kbs: ['ops'],
      files: [{
        kb: 'ops',
        relPath: 'a.md',
        results: [
          { type: 'tilde-path', value: '~/x', line: 3, status: 'MISSING', detail: 'parent dir is empty' },
          { type: 'url', value: 'https://e.invalid', line: 7, status: 'HTTP_ERROR', detail: 'HTTP 404' },
        ],
      }],
      totals: { filesScanned: 1, referencesChecked: 2, staleReferences: 2, filesWithStale: 1 },
    });
    expect(out).toContain('ops/a.md');
    expect(out).toContain('L3');
    expect(out).toContain('parent dir is empty');
    expect(out).toContain('L7');
    expect(out).toContain('HTTP 404');
    expect(out).toContain('Summary: 2 stale reference(s) in 1 file(s)');
  });

  it('--quiet drops the summary footer, keeping only the stale-reference lines (#739)', () => {
    const report = {
      kbs: ['ops'],
      files: [{
        kb: 'ops',
        relPath: 'a.md',
        results: [
          { type: 'tilde-path' as const, value: '~/x', line: 3, status: 'MISSING' as const, detail: 'gone' },
        ],
      }],
      totals: { filesScanned: 1, referencesChecked: 1, staleReferences: 1, filesWithStale: 1 },
    };
    const out = formatReport(report, { quiet: true });
    expect(out).toContain('ops/a.md');
    expect(out).toContain('L3');
    expect(out).not.toContain('Summary:');
  });

  it('--quiet emits nothing when there is no drift (#739)', () => {
    const out = formatReport({
      kbs: ['ops'],
      files: [{ kb: 'ops', relPath: 'a.md', results: [] }],
      totals: { filesScanned: 1, referencesChecked: 0, staleReferences: 0, filesWithStale: 0 },
    }, { quiet: true });
    expect(out).toBe('');
  });
});
