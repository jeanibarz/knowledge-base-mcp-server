import { afterEach, describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  collectLsReport,
  formatLsReport,
  parseLsArgs,
} from './cli-ls.js';
import {
  documentMatchesPrefix,
  listKnowledgeBaseDocuments,
} from './kb-document-listing.js';

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
      prefix: 'docs/',
      long: true,
      format: 'json',
    });
    expect(parseLsArgs(['--prefix=./docs//sub/']).prefix).toBe('docs/sub/');
  });

  it('rejects invalid formats, empty values, traversal, and extra positionals', () => {
    expect(() => parseLsArgs(['--format=xml'])).toThrow('invalid --format');
    expect(() => parseLsArgs(['--prefix='])).toThrow('--prefix=<path>');
    expect(() => parseLsArgs(['--prefix=../secret'])).toThrow('path escapes KB root');
    expect(() => parseLsArgs(['../outside'])).toThrow('invalid KB name');
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

  it('keeps CLI subtree and resources/list compatibility prefixes distinct', () => {
    expect(documentMatchesPrefix('docs/guide.md', 'docs')).toBe(true);
    expect(documentMatchesPrefix('docs2/guide.md', 'docs')).toBe(false);
    expect(documentMatchesPrefix('projects/active-old/old.md', 'projects/active')).toBe(false);
    expect(documentMatchesPrefix('docs/guide.md', 'docs/g', 'resource-prefix')).toBe(true);
    expect(documentMatchesPrefix('guide.md', 'guide', 'resource-prefix')).toBe(true);
  });

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
    await writeFile(rootDir, 'work/.private/secret.md', '# Hidden\n');
    await writeFile(rootDir, 'work/docs/quarantined.md', '# Quarantined\n');
    await writeFile(rootDir, 'other/elsewhere.md', '# Elsewhere\n');
    await fsp.writeFile(path.join(rootDir, 'not-a-knowledge-base'), 'ignore me\n', 'utf8');
    await fsp.symlink(
      path.join(rootDir, 'work', 'logs'),
      path.join(rootDir, 'work', 'log-alias'),
      'dir',
    );

    await fsp.mkdir(path.join(rootDir, 'work', '.index'), { recursive: true });
    await fsp.writeFile(
      path.join(rootDir, 'work', '.index', 'quarantine.jsonl'),
      `${JSON.stringify({
        schema_version: 'ingest-quarantine.v1',
        relative_path: 'docs/quarantined.md',
        source_sha256: null,
        error_category: 'input',
        error_code: 'EINVAL',
        error_fingerprint: `sha256:${'0'.repeat(64)}`,
        first_seen_at: '2026-07-13T08:00:00.000Z',
        last_attempted_at: '2026-07-13T08:00:00.000Z',
        retry_count: 1,
        next_retry_at: '2026-07-13T08:01:00.000Z',
        ack: false,
        dead_lettered_at: null,
        message: 'fixture failure',
      })}\n`,
      'utf8',
    );

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

    const hiddenScoped = await listKnowledgeBaseDocuments({
      rootDir,
      kbName: 'work',
      prefix: '.private',
    });
    expect(hiddenScoped.documents).toEqual([]);

    const symlinkScoped = await listKnowledgeBaseDocuments({
      rootDir,
      kbName: 'work',
      prefix: 'log-alias/',
    });
    expect(symlinkScoped.documents).toEqual([]);

    const canonicalizedScoped = await listKnowledgeBaseDocuments({
      rootDir,
      kbName: 'work',
      prefix: './docs//',
    });
    expect(canonicalizedScoped.documents.map((document) => document.relativePath)).toEqual([
      'docs/guide.md',
      'docs/reference.txt',
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

  it('does not treat an in-root KB symlink as a second inventory', async () => {
    const rootDir = await makeRoot();
    await writeFile(rootDir, 'work/logs/secret.md', '# Secret\n');
    await fsp.symlink(
      path.join(rootDir, 'work', 'logs'),
      path.join(rootDir, 'alias'),
      'dir',
    );

    const listing = await listKnowledgeBaseDocuments({ rootDir });
    expect(listing.knowledgeBases).toEqual(['work']);
    expect(listing.documents).toEqual([]);
    await expect(listKnowledgeBaseDocuments({ rootDir, kbName: 'alias' }))
      .rejects.toThrow('is a symlink');
  });

  it('rejects prefix roots that resolve outside the knowledge-base root', async () => {
    const rootDir = await makeRoot();
    const outsideDir = path.join(tempDir!, 'outside-prefix');
    await fsp.mkdir(outsideDir, { recursive: true });
    await fsp.writeFile(path.join(outsideDir, 'secret.md'), '# Outside\n', 'utf8');
    await fsp.mkdir(path.join(rootDir, 'work'), { recursive: true });
    await fsp.symlink(outsideDir, path.join(rootDir, 'work', 'link'), 'dir');

    await expect(listKnowledgeBaseDocuments({
      rootDir,
      kbName: 'work',
      prefix: 'link/',
    })).rejects.toThrow('resolves outside');
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
    const guidePath = path.join(rootDir, 'work', 'guide.md');
    await fsp.writeFile(
      guidePath,
      `---\ntier: durable\nstatus: active\ntype: guide\npadding: ${'界'.repeat(3000)}\n---\n# Guide\n`,
      'utf8',
    );
    const expectedMtime = new Date('2026-07-13T08:00:00.000Z');
    await fsp.utimes(guidePath, expectedMtime, expectedMtime);

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
      schemaVersion: 'kb.ls.v1',
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
    expect(mtime).toBe(expectedMtime.toISOString());
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

  it('keeps control characters in short paths on one output line', () => {
    expect(formatLsReport({
      knowledgeBases: ['work'],
      prefix: null,
      scopedKb: 'work',
      documents: [{ knowledgeBase: 'work', path: 'odd\nname.md' }],
    }, 'md')).toBe('odd\\nname.md\n');

    expect(formatLsReport({
      knowledgeBases: ['work'],
      prefix: null,
      scopedKb: 'work',
      documents: [{ knowledgeBase: 'work', path: 'quote"and\\slash.md' }],
    }, 'md')).toBe('quote"and\\slash.md\n');
  });

  it('escapes control characters in long markdown cells', () => {
    const markdown = formatLsReport({
      knowledgeBases: ['work'],
      prefix: null,
      scopedKb: 'work',
      documents: [{
        knowledgeBase: 'work',
        path: 'odd\r\u001b[31m\u0085.md',
        tier: 'durable',
        status: null,
        type: null,
        mtime: '2026-07-13T08:00:00.000Z',
      }],
    }, 'md');
    expect(markdown).toContain('odd\\r\\u001b[31m\\u0085.md');
    const pathWithBackslashPipe = String.raw`foo\|bar.md`;
    const tableWithBackslashPipe = formatLsReport({
      knowledgeBases: ['work'],
      prefix: null,
      scopedKb: 'work',
      documents: [{
        knowledgeBase: 'work',
        path: pathWithBackslashPipe,
        tier: 'durable',
        status: null,
        type: null,
        mtime: '2026-07-13T08:00:00.000Z',
      }],
    }, 'md');
    expect(tableWithBackslashPipe).toContain(String.raw`foo\\\|bar.md`);
  });
});
