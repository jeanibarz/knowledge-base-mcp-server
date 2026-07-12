import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { KBError } from './errors.js';
import {
  describeKnowledgeBase,
  extractKbDescription,
  listKnowledgeBases,
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
