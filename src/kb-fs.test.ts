import { afterEach, describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { KBError } from './errors.js';
import { listKnowledgeBaseDocuments } from './kb-document-listing.js';
import {
  describeKnowledgeBase,
  extractKbDescription,
  listKnowledgeBases,
  listResolvableKnowledgeBases,
  resolveKbPath,
  resolveKnowledgeBaseDir,
} from './kb-fs.js';

describe('listKnowledgeBases', () => {
  it('returns names of subdirectories, filtering dot-prefixed entries', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-fs-list-'));
    try {
      await fsp.mkdir(path.join(tempDir, 'engineering'));
      await fsp.mkdir(path.join(tempDir, 'personal'));
      await fsp.mkdir(path.join(tempDir, '.faiss'));            // dot-prefixed: skipped
      await fsp.writeFile(path.join(tempDir, '.reindex-trigger'), '');  // dot-file: skipped

      const out = await listKnowledgeBases(tempDir);
      expect(out.sort()).toEqual(['engineering', 'personal']);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns empty array when only dot entries exist', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-fs-empty-'));
    try {
      await fsp.mkdir(path.join(tempDir, '.faiss'));
      const out = await listKnowledgeBases(tempDir);
      expect(out).toEqual([]);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('throws on missing root directory (caller decides surfacing)', async () => {
    await expect(
      listKnowledgeBases('/nonexistent/path/that/should/not/exist'),
    ).rejects.toThrow();
  });
});

describe('resolveKnowledgeBaseDir unknown-name diagnostics (FR-CLI-832)', () => {
  it('includes the closest available KB and a bounded list in KB_NOT_FOUND', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-fs-suggest-'));
    try {
      for (const name of ['alpha', 'beta', 'delta', 'gamma', 'theta', 'epsilon', 'zeta']) {
        await fsp.mkdir(path.join(tempDir, name));
      }

      const pending = resolveKnowledgeBaseDir(tempDir, 'alpah');
      await expect(pending).rejects.toBeInstanceOf(KBError);
      await expect(pending).rejects.toThrow(
        `Knowledge base "alpah" not found under ${tempDir}.\n` +
        'Available knowledge bases: alpha, beta, zeta, delta, gamma.\n' +
        'Did you mean alpha?',
      );
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves the original diagnostic when available KBs cannot be enumerated', async () => {
    const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-fs-file-root-'));
    const rootFile = path.join(rootDir, 'root');
    try {
      await fsp.writeFile(rootFile, 'not a directory');
      await expect(resolveKnowledgeBaseDir(rootFile, 'missing')).rejects.toThrow(
        `Knowledge base "missing" not found under ${rootFile}.`,
      );
    } finally {
      await fsp.rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe('extractKbDescription', () => {
  it('returns the first heading title with leading hashes stripped', () => {
    expect(extractKbDescription('# Engineering KB\n\nrest of body')).toBe('Engineering KB');
  });

  it('uses any-level heading and trims trailing whitespace', () => {
    expect(extractKbDescription('\n### Deep heading wins   \n\nbody')).toBe('Deep heading wins');
  });

  it('skips blank lines before reaching a paragraph fallback', () => {
    expect(extractKbDescription('\n\n\nplain prose with no heading\n')).toBe(
      'plain prose with no heading',
    );
  });

  it('truncates long paragraphs to 80 characters', () => {
    const long = 'a'.repeat(200);
    const out = extractKbDescription(`${long}\n`);
    expect(out.length).toBe(80);
    expect(out).toBe('a'.repeat(80));
  });

  it('returns empty string for empty content', () => {
    expect(extractKbDescription('')).toBe('');
  });

  it('returns empty string when content is only whitespace', () => {
    expect(extractKbDescription('\n   \n\t\n')).toBe('');
  });

  it('prefers heading over earlier paragraph text', () => {
    // The pure-text "first non-empty paragraph" branch is a fallback only —
    // a heading anywhere wins so READMEs that lead with a banner image or
    // shields don't lose their title to the banner alt-text.
    const body = '![banner](b.png)\n\n# Real Title\n\nbody';
    expect(extractKbDescription(body)).toBe('Real Title');
  });
});

describe('describeKnowledgeBase', () => {
  it('reads README.md and returns the heading title', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-fs-describe-'));
    try {
      const kbDir = path.join(tempDir, 'engineering');
      await fsp.mkdir(kbDir);
      await fsp.writeFile(path.join(kbDir, 'README.md'), '# Engineering notes\n\nbody\n');

      expect(await describeKnowledgeBase(tempDir, 'engineering')).toBe('Engineering notes');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns empty string when README.md is absent', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-fs-describe-noreadme-'));
    try {
      await fsp.mkdir(path.join(tempDir, 'personal'));
      expect(await describeKnowledgeBase(tempDir, 'personal')).toBe('');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns empty string for dot-prefixed or path-like names without throwing', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-fs-describe-bad-'));
    try {
      expect(await describeKnowledgeBase(tempDir, '.faiss')).toBe('');
      expect(await describeKnowledgeBase(tempDir, '../escape')).toBe('');
      expect(await describeKnowledgeBase(tempDir, '')).toBe('');
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('listResolvableKnowledgeBases (#1167)', () => {
  it('keeps addressable KB directories and skips non-addressable top-level entries', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-fs-resolvable-'));
    const rootDir = path.join(tempDir, 'kbs');
    try {
      await fsp.mkdir(path.join(rootDir, 'good'), { recursive: true });
      await fsp.mkdir(path.join(rootDir, 'also'), { recursive: true });
      await fsp.writeFile(path.join(rootDir, 'good', 'note.md'), '# Note\n', 'utf8');
      // Kept: an in-root directory symlink alias still resolves, so it matches
      // resolveKnowledgeBaseDir's acceptance (unlike the stricter
      // resources/list inventory, which drops aliases).
      await fsp.symlink(path.join(rootDir, 'good'), path.join(rootDir, 'alias'), 'dir');
      // Skipped (KB_NOT_FOUND): a plain file, a dangling symlink, a symlink to a file.
      await fsp.writeFile(path.join(rootDir, 'not-a-kb'), 'x', 'utf8');
      await fsp.symlink(path.join(rootDir, 'missing'), path.join(rootDir, 'dangling'));
      await fsp.symlink(path.join(rootDir, 'good', 'note.md'), path.join(rootDir, 'readme.md'));
      // Skipped (VALIDATION): a directory symlink that escapes the root.
      const outsideDir = path.join(tempDir, 'outside');
      await fsp.mkdir(outsideDir, { recursive: true });
      await fsp.symlink(outsideDir, path.join(rootDir, 'evil'), 'dir');

      const out = (await listResolvableKnowledgeBases(rootDir)).sort();
      expect(out).toEqual(['alias', 'also', 'good']);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('propagates non-addressable errors that are not KB_NOT_FOUND/VALIDATION (ELOOP)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-fs-resolvable-loop-'));
    const rootDir = path.join(tempDir, 'kbs');
    try {
      await fsp.mkdir(path.join(rootDir, 'good'), { recursive: true });
      // A self-referential symlink makes stat() fail with ELOOP — a real error
      // that must abort rather than be silently dropped.
      await fsp.symlink('loop', path.join(rootDir, 'loop'));

      await expect(listResolvableKnowledgeBases(rootDir)).rejects.toMatchObject({ code: 'ELOOP' });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});

const itSymlink = process.platform === 'win32' ? it.skip : it;

describe('resolveKbPath symlink confinement (#1191)', () => {
  async function withKb<T>(fn: (ctx: { rootDir: string; kbDir: string; outside: string }) => Promise<T>): Promise<T> {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-fs-symlink-'));
    const rootDir = path.join(tempDir, 'kbs');
    const kbDir = path.join(rootDir, 'kb');
    const outside = path.join(tempDir, 'outside');
    await fsp.mkdir(kbDir, { recursive: true });
    await fsp.mkdir(outside, { recursive: true });
    try {
      return await fn({ rootDir, kbDir, outside });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  }

  itSymlink('rejects a dangling leaf symlink that points outside the KB', async () => {
    await withKb(async ({ rootDir, kbDir, outside }) => {
      await fsp.symlink(path.join(outside, 'new.md'), path.join(kbDir, 'link.md'));
      await expect(
        resolveKbPath(rootDir, 'kb', 'link.md', { mustExist: false }),
      ).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('path escapes KB root') });
    });
  });

  itSymlink('rejects a dangling leaf symlink even when it points inside the KB', async () => {
    await withKb(async ({ rootDir, kbDir }) => {
      await fsp.symlink(path.join(kbDir, 'not-yet.md'), path.join(kbDir, 'link.md'));
      await expect(
        resolveKbPath(rootDir, 'kb', 'link.md', { mustExist: false }),
      ).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('dangling symlink') });
    });
  });

  itSymlink('rejects a file symlink to an existing outside file (characterization)', async () => {
    await withKb(async ({ rootDir, kbDir, outside }) => {
      await fsp.writeFile(path.join(outside, 'secret.md'), 'x');
      await fsp.symlink(path.join(outside, 'secret.md'), path.join(kbDir, 'link.md'));
      await expect(
        resolveKbPath(rootDir, 'kb', 'link.md', { mustExist: false }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });
  });

  itSymlink('rejects a new leaf under a directory symlink to outside (characterization)', async () => {
    await withKb(async ({ rootDir, kbDir, outside }) => {
      await fsp.symlink(outside, path.join(kbDir, 'dirlink'), 'dir');
      await expect(
        resolveKbPath(rootDir, 'kb', 'dirlink/new.md', { mustExist: false }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });
  });

  itSymlink('still allows a symlink whose existing target is inside the KB', async () => {
    await withKb(async ({ rootDir, kbDir }) => {
      await fsp.writeFile(path.join(kbDir, 'real.md'), 'x');
      await fsp.symlink(path.join(kbDir, 'real.md'), path.join(kbDir, 'link.md'));
      await expect(
        resolveKbPath(rootDir, 'kb', 'link.md', { mustExist: false }),
      ).resolves.toBe(path.join(kbDir, 'link.md'));
    });
  });

  itSymlink('allows a plain not-yet-existing path', async () => {
    await withKb(async ({ rootDir, kbDir }) => {
      await expect(
        resolveKbPath(rootDir, 'kb', 'sub/new.md', { mustExist: false }),
      ).resolves.toBe(path.join(kbDir, 'sub', 'new.md'));
    });
  });
});

describe('KB_EXTERNAL_SHELF_ROOTS (#1088)', () => {
  const original = process.env.KB_EXTERNAL_SHELF_ROOTS;
  afterEach(() => {
    if (original === undefined) delete process.env.KB_EXTERNAL_SHELF_ROOTS;
    else process.env.KB_EXTERNAL_SHELF_ROOTS = original;
  });

  async function withLayout(
    fn: (l: { rootDir: string; allowed: string; other: string }) => Promise<void>,
  ): Promise<void> {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-fs-ext-'));
    try {
      const rootDir = path.join(base, 'root');
      const allowed = path.join(base, 'allowed');
      const other = path.join(base, 'other');
      for (const d of [rootDir, allowed, other]) await fsp.mkdir(d);
      await fsp.mkdir(path.join(allowed, 'eng'));
      await fsp.writeFile(path.join(allowed, 'eng', 'note.md'), '# hi\n');
      await fsp.mkdir(path.join(other, 'bad'));
      await fsp.writeFile(path.join(other, 'bad', 'note.md'), '# bad\n');
      await fsp.mkdir(path.join(rootDir, 'local'));
      await fsp.writeFile(path.join(rootDir, 'local', 'a.md'), '# a\n');
      await fn({ rootDir, allowed, other });
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  }

  it('accepts an allowlisted top-level link for resolution, path resolution and listing', async () => {
    await withLayout(async ({ rootDir, allowed }) => {
      await fsp.symlink(path.join(allowed, 'eng'), path.join(rootDir, 'programming'), 'dir');
      process.env.KB_EXTERNAL_SHELF_ROOTS = [path.join(allowed), '/nonexistent-root'].join(path.delimiter);
      await expect(resolveKnowledgeBaseDir(rootDir, 'programming')).resolves.toBe(path.join(rootDir, 'programming'));
      await expect(resolveKbPath(rootDir, 'programming', 'note.md', { mustExist: true }))
        .resolves.toBe(await fsp.realpath(path.join(allowed, 'eng', 'note.md')));
      expect(await listResolvableKnowledgeBases(rootDir)).toEqual(expect.arrayContaining(['local', 'programming']));
      const listing = await listKnowledgeBaseDocuments({ rootDir });
      expect(listing.documents.map((d) => `${d.kbName}/${d.relativePath}`).sort()).toEqual([
        'local/a.md',
        'programming/note.md',
      ]);
    });
  });

  it('still refuses a link outside the allowlist', async () => {
    await withLayout(async ({ rootDir, allowed, other }) => {
      await fsp.symlink(path.join(other, 'bad'), path.join(rootDir, 'evil'), 'dir');
      process.env.KB_EXTERNAL_SHELF_ROOTS = allowed;
      await expect(resolveKnowledgeBaseDir(rootDir, 'evil')).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(await listResolvableKnowledgeBases(rootDir)).toEqual(['local']);
    });
  });

  it('keeps refusing escaping links when the env is unset or empty', async () => {
    await withLayout(async ({ rootDir, allowed }) => {
      await fsp.symlink(path.join(allowed, 'eng'), path.join(rootDir, 'programming'), 'dir');
      delete process.env.KB_EXTERNAL_SHELF_ROOTS;
      await expect(resolveKnowledgeBaseDir(rootDir, 'programming')).rejects.toMatchObject({ code: 'VALIDATION' });
      process.env.KB_EXTERNAL_SHELF_ROOTS = '';
      await expect(resolveKnowledgeBaseDir(rootDir, 'programming')).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(await listResolvableKnowledgeBases(rootDir)).toEqual(['local']);
    });
  });

  it('still refuses an inner symlink that escapes the resolved external shelf', async () => {
    await withLayout(async ({ rootDir, allowed, other }) => {
      await fsp.symlink(path.join(other, 'bad', 'note.md'), path.join(allowed, 'eng', 'leak.md'));
      await fsp.symlink(path.join(allowed, 'eng'), path.join(rootDir, 'programming'), 'dir');
      process.env.KB_EXTERNAL_SHELF_ROOTS = allowed;
      await expect(resolveKbPath(rootDir, 'programming', 'leak.md', { mustExist: true }))
        .rejects.toMatchObject({ code: 'VALIDATION' });
    });
  });

  it('dedupes two aliases of the same shelf, keeping the first by sorted name', async () => {
    await withLayout(async ({ rootDir, allowed }) => {
      await fsp.symlink(path.join(allowed, 'eng'), path.join(rootDir, 'zeta'), 'dir');
      await fsp.symlink(path.join(allowed, 'eng'), path.join(rootDir, 'alpha'), 'dir');
      process.env.KB_EXTERNAL_SHELF_ROOTS = allowed;
      expect((await listKnowledgeBases(rootDir)).sort()).toEqual(['alpha', 'local']);
      expect(await listResolvableKnowledgeBases(rootDir)).not.toContain('zeta');
      const listing = await listKnowledgeBaseDocuments({ rootDir });
      expect(listing.documents.map((d) => `${d.kbName}/${d.relativePath}`).sort()).toEqual([
        'alpha/note.md',
        'local/a.md',
      ]);
    });
  });

  it('ignores broad allowlist entries (/, ancestors of the root) and unreadable ones without throwing', async () => {
    await withLayout(async ({ rootDir, allowed, other }) => {
      await fsp.symlink(path.join(other, 'bad'), path.join(rootDir, 'evil'), 'dir');
      await fsp.symlink(path.join(allowed, 'eng'), path.join(rootDir, 'good'), 'dir');
      const parent = path.dirname(rootDir);
      const loop = path.join(allowed, 'loop');
      await fsp.symlink('loop', loop);
      process.env.KB_EXTERNAL_SHELF_ROOTS = ['/', parent, loop, allowed].join(path.delimiter);
      // '/' and the root's parent admit nothing; the loop entry is skipped; the sane entry still works.
      await expect(resolveKnowledgeBaseDir(rootDir, 'evil')).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(resolveKnowledgeBaseDir(rootDir, 'good')).resolves.toBe(path.join(rootDir, 'good'));
      await expect(listKnowledgeBases(rootDir)).resolves.toEqual(expect.arrayContaining(['local', 'good']));
      process.env.KB_EXTERNAL_SHELF_ROOTS = ['/', parent, loop].join(path.delimiter);
      await expect(resolveKnowledgeBaseDir(rootDir, 'good')).rejects.toMatchObject({ code: 'VALIDATION' });
    });
  });
});
