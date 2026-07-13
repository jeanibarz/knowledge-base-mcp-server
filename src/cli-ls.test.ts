import { afterEach, describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  collectLsReport,
  formatLsReport,
  parseLsArgs,
  LS_SCHEMA_VERSION,
} from './cli-ls.js';
import { listKnowledgeBaseDocuments } from './kb-document-listing.js';
import { recordIngestFailure } from './ingest-quarantine.js';

describe('TS-CLI-857: kb ls argument parsing', () => {
  it('defaults to all KBs, plain paths, and short output', () => {
    expect(parseLsArgs([])).toEqual({
      kb: undefined,
      prefix: undefined,
      long: false,
      format: 'md',
    });
  });

  it('parses a positional KB, subtree, long metadata, and JSON output', () => {
    expect(parseLsArgs(['work', '--prefix=docs/', '--long', '--format=json'])).toEqual({
      kb: 'work',
      prefix: 'docs',
      long: true,
      format: 'json',
    });
  });

  it('rejects invalid formats, empty values, traversal, and extra positionals', () => {
    expect(() => parseLsArgs(['--format=xml'])).toThrow('invalid --format');
    expect(() => parseLsArgs(['--prefix='])).toThrow('--prefix=<path>');
    expect(() => parseLsArgs(['--prefix=../secret'])).toThrow('path escapes KB root');
    expect(() => parseLsArgs(['one', 'two'])).toThrow('unexpected argument');
  });
});

describe('TS-CLI-857: shared ingestable document listing', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir !== undefined) {
      await fsp.rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  async function makeRoot(): Promise<string> {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-ls-'));
    const rootDir = path.join(tempDir, 'kbs');
    await fsp.mkdir(rootDir, { recursive: true });
    return rootDir;
  }

  async function writeFile(rootDir: string, relativePath: string, content: string): Promise<void> {
    const fullPath = path.join(rootDir, relativePath);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, content, 'utf8');
  }

  it('shares ingest and quarantine rules while applying a true subtree prefix', async () => {
    const rootDir = await makeRoot();
    await writeFile(rootDir, 'work/docs/guide.md', '# Guide\n');
    await writeFile(rootDir, 'work/docs/reference.txt', 'reference\n');
    await writeFile(rootDir, 'work/docs/skip.pdf', 'not enabled by default\n');
    await writeFile(rootDir, 'work/docs2/not-in-prefix.md', '# Other\n');
    await writeFile(rootDir, 'work/projects/active/current.md', '# Current\n');
    await writeFile(rootDir, 'work/projects/active-old/old.md', '# Old\n');
    await writeFile(rootDir, 'work/logs/ignored.md', '# Log\n');
    await writeFile(rootDir, 'work/.hidden.md', '# Hidden\n');
    await writeFile(rootDir, 'work/docs/quarantined.md', '# Quarantined\n');
    await writeFile(rootDir, 'other/elsewhere.md', '# Elsewhere\n');

    await recordIngestFailure({
      kbPath: path.join(rootDir, 'work'),
      relativePath: 'docs/quarantined.md',
      error: new Error('fixture failure'),
    });

    const scoped = await listKnowledgeBaseDocuments({
      rootDir,
      kbName: 'work',
      prefix: 'docs/',
    });
    expect(scoped.knowledgeBases).toEqual(['work']);
    expect(scoped.documents.map((document) => document.relativePath)).toEqual([
      'docs/guide.md',
      'docs/reference.txt',
    ]);

    const nestedScoped = await listKnowledgeBaseDocuments({
      rootDir,
      kbName: 'work',
      prefix: 'projects/active',
    });
    expect(nestedScoped.documents.map((document) => document.relativePath)).toEqual([
      'projects/active/current.md',
    ]);

    const all = await listKnowledgeBaseDocuments({ rootDir });
    expect(all.documents.map((document) => `${document.kbName}/${document.relativePath}`)).toEqual([
      'other/elsewhere.md',
      'work/docs/guide.md',
      'work/docs/reference.txt',
      'work/docs2/not-in-prefix.md',
      'work/projects/active-old/old.md',
      'work/projects/active/current.md',
    ]);
  });

  it('rejects knowledge-base roots that resolve outside the configured root', async () => {
    const rootDir = await makeRoot();
    const outsideDir = path.join(tempDir!, 'outside');
    await fsp.mkdir(outsideDir, { recursive: true });
    await fsp.writeFile(path.join(outsideDir, 'leaked.md'), '# Outside\n', 'utf8');
    await fsp.symlink(outsideDir, path.join(rootDir, 'evil'), 'dir');

    await expect(listKnowledgeBaseDocuments({ rootDir })).rejects.toThrow('resolves outside');
  });
});

describe('TS-CLI-857: report formatting', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir !== undefined) {
      await fsp.rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('renders long frontmatter and mtime fields in markdown and JSON', async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-ls-format-'));
    const rootDir = path.join(tempDir, 'kbs');
    await fsp.mkdir(path.join(rootDir, 'work'), { recursive: true });
    await fsp.writeFile(
      path.join(rootDir, 'work', 'guide.md'),
      '---\ntier: durable\nstatus: active\ntype: guide\n---\n# Guide\n',
      'utf8',
    );

    const report = await collectLsReport({ rootDir, kb: 'work', long: true });
    expect(report.documents).toEqual([
      expect.objectContaining({
        knowledgeBase: 'work',
        path: 'guide.md',
        tier: 'durable',
        status: 'active',
        type: 'guide',
        mtime: expect.any(String),
      }),
    ]);

    const json = JSON.parse(formatLsReport(report, 'json')) as {
      schemaVersion: string;
      knowledgeBases: string[];
      documents: Array<Record<string, unknown>>;
    };
    expect(json).toMatchObject({
      schemaVersion: LS_SCHEMA_VERSION,
      knowledgeBases: ['work'],
      documents: [{
        knowledgeBase: 'work',
        path: 'guide.md',
        tier: 'durable',
        status: 'active',
        type: 'guide',
      }],
    });
    expect(json.documents[0].mtime).toEqual(expect.any(String));

    const markdown = formatLsReport(report, 'md');
    const mtime = report.documents[0]?.mtime;
    expect(mtime).toEqual(expect.any(String));
    expect(markdown).toContain('| KB | Path | Tier | Status | Type | Modified |');
    expect(markdown).toContain(`| work | guide.md | durable | active | guide | ${mtime} |`);
  });

  it('renders scoped short output as KB-relative paths and all-KB output with a KB prefix', async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-ls-short-'));
    const rootDir = path.join(tempDir, 'kbs');
    await fsp.mkdir(path.join(rootDir, 'work'), { recursive: true });
    await fsp.mkdir(path.join(rootDir, 'other'), { recursive: true });
    await fsp.writeFile(path.join(rootDir, 'work', 'guide.md'), '# Guide\n', 'utf8');
    await fsp.writeFile(path.join(rootDir, 'other', 'else.md'), '# Else\n', 'utf8');

    const scoped = await collectLsReport({ rootDir, kb: 'work' });
    expect(formatLsReport(scoped, 'md')).toBe('guide.md\n');

    const all = await collectLsReport({ rootDir });
    expect(formatLsReport(all, 'md')).toBe('other/else.md\nwork/guide.md\n');
  });
});
