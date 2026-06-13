import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { createTestCorpus } from './corpus.js';

describe('createTestCorpus', () => {
  it('writes nested files under an isolated KB root and cleans them up', async () => {
    const corpus = await createTestCorpus({
      prefix: 'kb-corpus-test-',
      files: {
        'ops/note.md': 'hello\n',
        'ops/deep/second.md': 'world\n',
      },
    });

    try {
      await expect(fsp.readFile(corpus.pathFor('ops/note.md'), 'utf-8')).resolves.toBe('hello\n');
      await expect(fsp.readFile(corpus.pathFor('ops/deep/second.md'), 'utf-8')).resolves.toBe('world\n');
      expect(path.basename(corpus.rootDir)).toBe('kbs');
      expect(path.dirname(corpus.rootDir)).toBe(corpus.tempDir);
    } finally {
      await corpus.cleanup();
    }

    await expect(fsp.stat(corpus.tempDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('supports explicit writes after setup', async () => {
    const corpus = await createTestCorpus({ prefix: 'kb-corpus-test-' });

    try {
      const filePath = await corpus.writeFile('ops/new.md', 'new note\n');
      expect(filePath).toBe(corpus.pathFor('ops/new.md'));
      await expect(fsp.readFile(filePath, 'utf-8')).resolves.toBe('new note\n');
    } finally {
      await corpus.cleanup();
    }
  });

  it('rejects paths that escape the corpus root', async () => {
    await expect(createTestCorpus({
      prefix: 'kb-corpus-test-',
      files: {
        '../outside.md': 'nope\n',
      },
    })).rejects.toThrow('escapes the root');
  });
});
