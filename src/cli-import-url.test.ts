import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import yaml from 'js-yaml';
import {
  defaultImportUrlDeps,
  parseImportUrlArgs,
  runImportUrl,
  type RunImportUrlDeps,
} from './cli-import-url.js';
import { UrlSnapshotError, type UrlFetcher, type UrlSnapshot } from './url-snapshot.js';
import { KB_WRITE_POLICY_FILENAME } from './kb-write-policy.js';

// ---------------------------------------------------------------------------
// parseImportUrlArgs
// ---------------------------------------------------------------------------

describe('parseImportUrlArgs', () => {
  it('parses a positional URL plus --kb and applies defaults', () => {
    expect(parseImportUrlArgs(['--kb=research', 'https://example.com/x'])).toEqual({
      kb: 'research',
      url: 'https://example.com/x',
      maxBytes: 8 * 1024 * 1024,
      timeoutMs: 30_000,
      maxRedirects: 5,
      allowLocalNetwork: false,
      refresh: false,
    });
  });

  it('accepts the --url= form and every option flag', () => {
    expect(parseImportUrlArgs([
      '--kb=work',
      '--url=https://example.com/y',
      '--note=papers/x.md',
      '--title=Custom Title',
      '--max-bytes=4096',
      '--timeout=5000',
      '--max-redirects=2',
      '--allow-local-network',
      '--refresh',
    ])).toMatchObject({
      kb: 'work',
      url: 'https://example.com/y',
      note: 'papers/x.md',
      title: 'Custom Title',
      maxBytes: 4096,
      timeoutMs: 5000,
      maxRedirects: 2,
      allowLocalNetwork: true,
      refresh: true,
    });
  });

  it('rejects unknown flags', () => {
    expect(() => parseImportUrlArgs(['--kb=x', '--bogus'])).toThrow(/unknown flag/);
  });

  it('rejects a second positional argument', () => {
    expect(() => parseImportUrlArgs(['https://a.example', 'https://b.example']))
      .toThrow(/extra argument/);
  });

  it('rejects a non-positive --max-bytes', () => {
    expect(() => parseImportUrlArgs(['--kb=x', 'https://a', '--max-bytes=0']))
      .toThrow(/invalid --max-bytes/);
  });

  it('accepts --max-redirects=0', () => {
    expect(parseImportUrlArgs(['--kb=x', 'https://a', '--max-redirects=0']).maxRedirects).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runImportUrl — full command against a temp KB root with an injected fetcher
// ---------------------------------------------------------------------------

interface Harness {
  rootDir: string;
  deps: RunImportUrlDeps;
  stdout: () => string;
  stderr: () => string;
  refresh: jest.Mock<(kb: string) => Promise<void>>;
  cleanup: () => Promise<void>;
}

async function makeHarness(fetchUrl: UrlFetcher): Promise<Harness> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-import-url-test-'));
  const rootDir = path.join(tempDir, 'kbs');
  await fsp.mkdir(path.join(rootDir, 'research'), { recursive: true });
  const out: string[] = [];
  const err: string[] = [];
  const refresh = jest.fn<(kb: string) => Promise<void>>(async () => {});
  const deps: RunImportUrlDeps = {
    rootDir,
    fetchUrl,
    refresh,
    now: () => new Date('2026-05-19T12:00:00.000Z'),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return {
    rootDir,
    deps,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    refresh,
    cleanup: () => fsp.rm(tempDir, { recursive: true, force: true }),
  };
}

function snapshotOf(body: string | Buffer, contentType: string, overrides: Partial<UrlSnapshot> = {}): UrlSnapshot {
  return {
    finalUrl: 'https://example.com/article',
    httpStatus: 200,
    contentType,
    body: typeof body === 'string' ? Buffer.from(body, 'utf-8') : body,
    ...overrides,
  };
}

function fixedFetcher(snapshot: UrlSnapshot): UrlFetcher {
  return async () => snapshot;
}

function parseNote(raw: string): { fm: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (m === null) throw new Error('note has no frontmatter fence');
  return { fm: yaml.load(m[1]) as Record<string, unknown>, body: m[2] };
}

describe('runImportUrl', () => {
  let priorCacheDir: string | undefined;
  let cacheTempDir = '';

  beforeEach(async () => {
    cacheTempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-import-url-cache-'));
    priorCacheDir = process.env.EXTRACTION_TEXT_CACHE_DIR;
    process.env.EXTRACTION_TEXT_CACHE_DIR = cacheTempDir;
  });

  afterEach(async () => {
    if (priorCacheDir === undefined) delete process.env.EXTRACTION_TEXT_CACHE_DIR;
    else process.env.EXTRACTION_TEXT_CACHE_DIR = priorCacheDir;
    await fsp.rm(cacheTempDir, { recursive: true, force: true });
  });

  it('snapshots an HTML page into a provenance-tagged note', async () => {
    const html =
      '<html><head><title>Example Article</title></head>' +
      '<body><h1>Heading</h1><p>The paragraph body text.</p></body></html>';
    const h = await makeHarness(fixedFetcher(snapshotOf(html, 'text/html; charset=utf-8')));
    try {
      const code = await runImportUrl(['--kb=research', 'https://example.com/article'], h.deps);
      expect(code).toBe(0);

      const json = JSON.parse(h.stdout()) as Record<string, unknown>;
      expect(json).toMatchObject({
        knowledge_base_name: 'research',
        path: 'example-article.md',
        action: 'import-url',
        source_url: 'https://example.com/article',
        http_status: 200,
        content_type: 'text/html',
        refreshed: false,
      });
      expect(json.content_sha256).toMatch(/^[0-9a-f]{64}$/);

      const noteRaw = await fsp.readFile(
        path.join(h.rootDir, 'research', 'example-article.md'),
        'utf-8',
      );
      const { fm, body } = parseNote(noteRaw);
      expect(fm).toMatchObject({
        title: 'Example Article',
        source_url: 'https://example.com/article',
        fetched_at: '2026-05-19T12:00:00.000Z',
        content_type: 'text/html',
        http_status: 200,
      });
      expect(fm.content_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(body).toContain('# Example Article');
      expect(body).toContain('The paragraph body text.');
      // HTML tags must not leak into the snapshot body.
      expect(body).not.toContain('<p>');
    } finally {
      await h.cleanup();
    }
  });

  it('rejects new notes when the target KB policy denies mutations', async () => {
    const h = await makeHarness(fixedFetcher(snapshotOf('<title>Denied</title><p>x</p>', 'text/html')));
    try {
      await fsp.writeFile(
        path.join(h.rootDir, 'research', KB_WRITE_POLICY_FILENAME),
        '{"mutations":"deny"}\n',
        'utf-8',
      );

      const code = await runImportUrl(['--kb=research', 'https://example.com/denied'], h.deps);
      expect(code).toBe(1);
      expect(h.stderr()).toMatch(/KB write policy denies mutations/);
      await expect(fsp.stat(path.join(h.rootDir, 'research', 'denied.md')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await h.cleanup();
    }
  });

  it('snapshots a text/plain response and respects an explicit --note path', async () => {
    const h = await makeHarness(
      fixedFetcher(snapshotOf('Just some plain text content.', 'text/plain')),
    );
    try {
      const code = await runImportUrl(
        ['--kb=research', 'https://example.com/raw', '--note=imports/raw.md', '--title=Raw Note'],
        h.deps,
      );
      expect(code).toBe(0);
      const json = JSON.parse(h.stdout()) as Record<string, unknown>;
      expect(json.path).toBe('imports/raw.md');
      const noteRaw = await fsp.readFile(
        path.join(h.rootDir, 'research', 'imports', 'raw.md'),
        'utf-8',
      );
      const { fm, body } = parseNote(noteRaw);
      expect(fm.title).toBe('Raw Note');
      expect(body).toContain('Just some plain text content.');
    } finally {
      await h.cleanup();
    }
  });

  it('records resolved_url when the final URL differs from the requested URL', async () => {
    const h = await makeHarness(
      fixedFetcher(snapshotOf('<title>T</title><p>body</p>', 'text/html', {
        finalUrl: 'https://example.com/redirected',
      })),
    );
    try {
      const code = await runImportUrl(['--kb=research', 'https://example.com/start'], h.deps);
      expect(code).toBe(0);
      const json = JSON.parse(h.stdout()) as Record<string, unknown>;
      expect(json.source_url).toBe('https://example.com/start');
      expect(json.final_url).toBe('https://example.com/redirected');
      const noteRaw = await fsp.readFile(path.join(h.rootDir, 'research', json.path as string), 'utf-8');
      expect(parseNote(noteRaw).fm.resolved_url).toBe('https://example.com/redirected');
    } finally {
      await h.cleanup();
    }
  });

  it('runs the refresh hook when --refresh is passed', async () => {
    const h = await makeHarness(fixedFetcher(snapshotOf('<title>T</title><p>x</p>', 'text/html')));
    try {
      const code = await runImportUrl(
        ['--kb=research', 'https://example.com/article', '--refresh'],
        h.deps,
      );
      expect(code).toBe(0);
      expect(h.refresh).toHaveBeenCalledWith('research');
      expect((JSON.parse(h.stdout()) as Record<string, unknown>).refreshed).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  it('refuses to overwrite an existing note', async () => {
    const h = await makeHarness(fixedFetcher(snapshotOf('<title>Dup</title><p>x</p>', 'text/html')));
    try {
      expect(await runImportUrl(['--kb=research', 'https://example.com/dup'], h.deps)).toBe(0);
      const second = await runImportUrl(['--kb=research', 'https://example.com/dup'], h.deps);
      expect(second).toBe(1);
      expect(h.stderr()).toMatch(/refusing to overwrite/);
    } finally {
      await h.cleanup();
    }
  });

  it('rejects an unsupported content type without writing a note', async () => {
    const h = await makeHarness(fixedFetcher(snapshotOf(Buffer.from([0, 1, 2]), 'image/png')));
    try {
      const code = await runImportUrl(['--kb=research', 'https://example.com/pic.png'], h.deps);
      expect(code).toBe(1);
      expect(h.stderr()).toMatch(/unsupported content type/);
      expect(await fsp.readdir(path.join(h.rootDir, 'research'))).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });

  it('surfaces a fetch failure as exit 1', async () => {
    const failing: UrlFetcher = async () => {
      throw new UrlSnapshotError('host resolves to a private/loopback address: 127.0.0.1');
    };
    const h = await makeHarness(failing);
    try {
      const code = await runImportUrl(['--kb=research', 'http://localhost/x'], h.deps);
      expect(code).toBe(1);
      expect(h.stderr()).toMatch(/private\/loopback/);
    } finally {
      await h.cleanup();
    }
  });

  it('exits 2 on missing --kb or missing URL', async () => {
    const h = await makeHarness(fixedFetcher(snapshotOf('x', 'text/plain')));
    try {
      expect(await runImportUrl(['https://example.com/x'], h.deps)).toBe(2);
      expect(h.stderr()).toMatch(/missing --kb/);
      expect(await runImportUrl(['--kb=research'], h.deps)).toBe(2);
      expect(h.stderr()).toMatch(/missing <url>/);
    } finally {
      await h.cleanup();
    }
  });

  it('exits 2 when --note does not end in .md', async () => {
    const h = await makeHarness(fixedFetcher(snapshotOf('x', 'text/plain')));
    try {
      const code = await runImportUrl(
        ['--kb=research', 'https://example.com/x', '--note=notes/x.txt'],
        h.deps,
      );
      expect(code).toBe(2);
      expect(h.stderr()).toMatch(/must end in \.md/);
    } finally {
      await h.cleanup();
    }
  });

  it('rejects a traversal --note path', async () => {
    const h = await makeHarness(fixedFetcher(snapshotOf('x', 'text/plain')));
    try {
      const code = await runImportUrl(
        ['--kb=research', 'https://example.com/x', '--note=../escape.md'],
        h.deps,
      );
      expect(code).toBe(1);
      expect(h.stderr()).toMatch(/escapes KB root/);
    } finally {
      await h.cleanup();
    }
  });
});

describe('defaultImportUrlDeps', () => {
  it('wires the real fetcher, refresh hook, and clock', () => {
    const deps = defaultImportUrlDeps();
    expect(typeof deps.fetchUrl).toBe('function');
    expect(typeof deps.refresh).toBe('function');
    expect(deps.now()).toBeInstanceOf(Date);
  });
});
