import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  applyTagUpdates,
  parseTagArgs,
  tagNote,
} from './cli-tag.js';
import { collectTagsReport } from './cli-tags.js';
import {
  parseFrontmatter,
  parseFrontmatterStrict,
  rewriteFrontmatter,
} from './frontmatter.js';

describe('FR-CLI-833: kb tag', () => {
  it('TS-CLI-833-001 parses a positional note and repeated add/remove flags', () => {
    expect(parseTagArgs([
      'alpha/notes/deploy.md',
      '--add', 'new',
      '--add=keep',
      '--remove', 'old',
      '--format=json',
      '--yes',
    ])).toEqual({
      target: 'alpha/notes/deploy.md',
      add: ['new', 'keep'],
      remove: ['old'],
      format: 'json',
      yes: true,
    });
  });

  it('TS-CLI-833-002 rejects missing targets, mutations, and invalid flags', () => {
    expect(() => parseTagArgs([])).toThrow('missing <chunk-id|kb://uri|kb-relative-path>');
    expect(() => parseTagArgs(['alpha/note.md'])).toThrow('at least one of --add or --remove');
    expect(() => parseTagArgs(['alpha/note.md', '--add='])).toThrow('requires a non-empty value');
    expect(() => parseTagArgs(['alpha/note.md', '--unknown=x'])).toThrow('unknown flag');
    expect(() => parseTagArgs(['alpha/note.md', 'second.md', '--add=x'])).toThrow('unexpected argument');
  });

  it('TS-CLI-833-003 applies stable set semantics and preserves the body', () => {
    const body = '# Deploy\n\nKeep this body byte-for-byte.\n';
    const original = [
      '---',
      'title: Deploy',
      'tags:',
      '  - old',
      '  - keep',
      'owner: platform',
      '---',
      body,
    ].join('\n');

    const result = applyTagUpdates(original, {
      add: ['new', 'keep'],
      remove: ['old'],
    });

    expect(result.before).toEqual(['old', 'keep']);
    expect(result.after).toEqual(['keep', 'new']);
    expect(result.changed).toBe(true);
    const reparsed = parseFrontmatter(result.newContent);
    expect(reparsed.frontmatter).toMatchObject({
      title: 'Deploy',
      owner: 'platform',
      tags: ['keep', 'new'],
    });
    expect(reparsed.body).toBe(body);
  });

  it('TS-CLI-833-004 creates a tags array when a plain note has no frontmatter', () => {
    const original = '# Plain note\n\nBody only.\n';
    const result = applyTagUpdates(original, { add: ['new'], remove: [] });
    const reparsed = parseFrontmatter(result.newContent);

    expect(reparsed.frontmatter.tags).toEqual(['new']);
    expect(reparsed.body).toBe(original);
  });

  it('TS-CLI-833-005 rejects malformed frontmatter before producing a write', () => {
    expect(() => applyTagUpdates(
      '---\ntags: [unterminated\n---\nBody\n',
      { add: ['new'], remove: [] },
    )).toThrow(/frontmatter/);
  });

  it('TS-CLI-833-010 exposes strict mutation parsing and body validation', () => {
    expect(() => parseFrontmatterStrict('---\ntags: [a]\nBody\n')).toThrow(/closing/);
    expect(() => parseFrontmatterStrict('---\njust a scalar\n---\nBody\n')).toThrow(/mapping/);

    const rewritten = rewriteFrontmatter('---\ntitle: Note\n---\nBody\n', (frontmatter) => ({
      ...frontmatter,
      tags: ['new'],
    }));
    expect(rewritten.body).toBe('Body\n');
    expect(parseFrontmatterStrict(rewritten.newContent).frontmatter.tags).toEqual(['new']);
  });

  async function makeTmpKb(): Promise<{
    tempDir: string;
    rootDir: string;
    notePath: string;
  }> {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-tag-'));
    const rootDir = path.join(tempDir, 'knowledge-bases');
    const notePath = path.join(rootDir, 'alpha', 'notes', 'deploy.md');
    await fsp.mkdir(path.dirname(notePath), { recursive: true });
    await fsp.writeFile(notePath, [
      '---',
      'title: Deploy',
      'tags: [old, keep]',
      'owner: platform',
      '---',
      '',
      '# Deploy',
      '',
      'Keep this body byte-for-byte.',
      '',
    ].join('\n'));
    return { tempDir, rootDir, notePath };
  }

  it('TS-CLI-833-006 dry-runs without changing the note', async () => {
    const fixture = await makeTmpKb();
    try {
      const before = await fsp.readFile(fixture.notePath, 'utf-8');
      const result = await tagNote({
        rootDir: fixture.rootDir,
        target: 'alpha/notes/deploy.md',
        add: ['new'],
        remove: ['old'],
        apply: false,
      });

      expect(result).toMatchObject({
        knowledgeBase: 'alpha',
        relativePath: 'notes/deploy.md',
        applied: false,
        before: ['old', 'keep'],
        after: ['keep', 'new'],
      });
      expect(await fsp.readFile(fixture.notePath, 'utf-8')).toBe(before);
    } finally {
      await fsp.rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it('TS-CLI-833-011 rejects malformed on-disk frontmatter without writing', async () => {
    const fixture = await makeTmpKb();
    try {
      await fsp.writeFile(fixture.notePath, '---\ntags: [unterminated\n---\nBody\n');
      const before = await fsp.readFile(fixture.notePath, 'utf-8');
      await expect(tagNote({
        rootDir: fixture.rootDir,
        target: 'alpha/notes/deploy.md',
        add: ['new'],
        remove: [],
        apply: true,
      })).rejects.toThrow(/frontmatter/);
      expect(await fsp.readFile(fixture.notePath, 'utf-8')).toBe(before);
    } finally {
      await fsp.rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it('TS-CLI-833-007 applies atomically and makes the new tag visible to kb tags', async () => {
    const fixture = await makeTmpKb();
    try {
      const before = await fsp.readFile(fixture.notePath, 'utf-8');
      const result = await tagNote({
        rootDir: fixture.rootDir,
        target: 'kb://alpha/notes/deploy.md',
        add: ['new'],
        remove: ['old'],
        apply: true,
      });
      const after = await fsp.readFile(fixture.notePath, 'utf-8');

      expect(result.applied).toBe(true);
      expect(after).not.toBe(before);
      expect(parseFrontmatter(after).tags).toEqual(['keep', 'new']);
      expect(parseFrontmatter(after).body).toBe(parseFrontmatter(before).body);

      const report = await collectTagsReport({
        rootDir: fixture.rootDir,
        kbFilter: 'alpha',
        facets: ['tags'],
      });
      expect(report.facets[0].values).toEqual([
        { value: 'keep', count: 1 },
        { value: 'new', count: 1 },
      ]);
    } finally {
      await fsp.rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it('TS-CLI-833-008 refuses a denied KB mutation without changing the note', async () => {
    const fixture = await makeTmpKb();
    try {
      const before = await fsp.readFile(fixture.notePath, 'utf-8');
      await fsp.writeFile(
        path.join(fixture.rootDir, 'alpha', '.kb-policy.json'),
        JSON.stringify({ mutations: 'deny' }),
      );

      await expect(tagNote({
        rootDir: fixture.rootDir,
        target: 'alpha/notes/deploy.md',
        add: ['new'],
        remove: [],
        apply: true,
      })).rejects.toThrow(/denies mutations/);
      expect(await fsp.readFile(fixture.notePath, 'utf-8')).toBe(before);
    } finally {
      await fsp.rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it('TS-CLI-833-009 rejects a traversal selector without changing the note', async () => {
    const fixture = await makeTmpKb();
    try {
      const before = await fsp.readFile(fixture.notePath, 'utf-8');
      await expect(tagNote({
        rootDir: fixture.rootDir,
        target: 'alpha/../secret.md',
        add: ['new'],
        remove: [],
        apply: true,
      })).rejects.toThrow(/path escapes KB root/);
      expect(await fsp.readFile(fixture.notePath, 'utf-8')).toBe(before);
    } finally {
      await fsp.rm(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it('TS-CLI-833-012 rejects hidden and non-Markdown targets before resolving files', async () => {
    const fixture = await makeTmpKb();
    try {
      await expect(tagNote({
        rootDir: fixture.rootDir,
        target: 'alpha/.index/fake.md',
        add: ['new'],
        remove: [],
        apply: true,
      })).rejects.toThrow(/visible Markdown note/);
      await expect(tagNote({
        rootDir: fixture.rootDir,
        target: 'alpha/notes/deploy.txt',
        add: ['new'],
        remove: [],
        apply: true,
      })).rejects.toThrow(/Markdown note/);
    } finally {
      await fsp.rm(fixture.tempDir, { recursive: true, force: true });
    }
  });
});
