import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  applyFrontmatterUpdates,
  formatPromoteApplyJson,
  formatPromoteApplyMarkdown,
  formatPromoteListJson,
  formatPromoteListMarkdown,
  parsePromoteArgs,
  promoteApply,
  promoteListCandidates,
  PROMOTE_REVIEW_STATUSES,
  PROMOTE_TIERS,
  type SemanticCandidateSearcher,
} from './cli-promote.js';
import { parseFrontmatter } from './frontmatter.js';
import { KB_WRITE_POLICY_FILENAME } from './kb-write-policy.js';

// ---------------------------------------------------------------------------
// parsePromoteArgs
// ---------------------------------------------------------------------------

describe('parsePromoteArgs', () => {
  it('parses list mode (query + k + format + model)', () => {
    expect(parsePromoteArgs([
      '--kb=ops',
      '--query=canonical retry policy',
      '--k=7',
      '--format=json',
      '--model=ollama__nomic-embed-text-latest',
    ])).toEqual({
      kb: 'ops',
      query: 'canonical retry policy',
      k: 7,
      format: 'json',
      yes: false,
      model: 'ollama__nomic-embed-text-latest',
    });
  });

  it('parses apply mode with all lifecycle fields and --yes', () => {
    expect(parsePromoteArgs([
      '--kb=ops',
      '--path=patterns/retry.md',
      '--tier=validated',
      '--review-status=approved',
      '--confidence=0.85',
      '--last-verified-at=2026-05-11',
      '--yes',
    ])).toMatchObject({
      kb: 'ops',
      path: 'patterns/retry.md',
      tier: 'validated',
      reviewStatus: 'approved',
      confidence: 0.85,
      lastVerifiedAt: '2026-05-11',
      yes: true,
    });
  });

  it('accepts the literal "now" for --last-verified-at', () => {
    expect(parsePromoteArgs([
      '--kb=ops', '--path=a.md', '--tier=working', '--last-verified-at=now',
    ]).lastVerifiedAt).toBe('now');
  });

  it('rejects missing --kb', () => {
    expect(() => parsePromoteArgs(['--query=x'])).toThrow('missing --kb=<name>');
  });

  it('rejects missing mode (no --query and no --path)', () => {
    expect(() => parsePromoteArgs(['--kb=ops'])).toThrow('list mode');
  });

  it('rejects --query combined with --path', () => {
    expect(() => parsePromoteArgs([
      '--kb=ops', '--query=x', '--path=y.md', '--tier=working',
    ])).toThrow('mutually exclusive');
  });

  it('rejects --query combined with apply-only fields', () => {
    expect(() => parsePromoteArgs([
      '--kb=ops', '--query=x', '--tier=working',
    ])).toThrow('list mode');
  });

  it('rejects --query combined with --yes', () => {
    expect(() => parsePromoteArgs([
      '--kb=ops', '--query=x', '--yes',
    ])).toThrow('read-only');
  });

  it('requires at least one update when --path is given', () => {
    expect(() => parsePromoteArgs([
      '--kb=ops', '--path=a.md',
    ])).toThrow('at least one of --tier');
  });

  it('rejects invalid --tier with the allowed vocabulary in the message', () => {
    expect(() => parsePromoteArgs(['--kb=ops', '--path=a.md', '--tier=wisdom2']))
      .toThrow(/invalid --tier.*working, validated, wisdom/);
  });

  it('rejects invalid --review-status', () => {
    expect(() => parsePromoteArgs(['--kb=ops', '--path=a.md', '--review-status=verified']))
      .toThrow(/invalid --review-status/);
  });

  it.each([
    ['--confidence=-0.1', 'invalid --confidence'],
    ['--confidence=1.5', 'invalid --confidence'],
    ['--confidence=abc', 'invalid --confidence'],
  ])('rejects out-of-range --confidence (%s)', (flag, message) => {
    expect(() => parsePromoteArgs(['--kb=ops', '--path=a.md', flag])).toThrow(message);
  });

  it('rejects malformed --last-verified-at', () => {
    expect(() => parsePromoteArgs([
      '--kb=ops', '--path=a.md', '--tier=working', '--last-verified-at=2026/05/11',
    ])).toThrow(/expected YYYY-MM-DD/);
  });

  it('rejects unknown flags and stray positional args', () => {
    expect(() => parsePromoteArgs(['--kb=ops', '--query=x', '--zzz'])).toThrow('unknown flag');
    expect(() => parsePromoteArgs(['--kb=ops', '--query=x', 'positional'])).toThrow('unexpected argument');
  });

  it('exposes the controlled vocabularies as readonly tuples', () => {
    expect(PROMOTE_TIERS).toEqual(['working', 'validated', 'wisdom']);
    expect(PROMOTE_REVIEW_STATUSES).toEqual(['approved', 'needs-review']);
  });
});

// ---------------------------------------------------------------------------
// applyFrontmatterUpdates (pure rewrite)
// ---------------------------------------------------------------------------

describe('applyFrontmatterUpdates', () => {
  it('updates existing keys and reports the diff', () => {
    const original = [
      '---',
      'title: Retry policy',
      'tier: working',
      'confidence: 0.4',
      '---',
      '',
      '# Retry policy',
      '',
      'Use exponential backoff.',
      '',
    ].join('\n');
    const result = applyFrontmatterUpdates(original, {
      tier: 'validated',
      confidence: 0.85,
    });
    expect(result.changed.sort()).toEqual(['confidence', 'tier']);
    expect(result.before).toMatchObject({ tier: 'working', confidence: '0.4' });
    expect(result.after).toMatchObject({ tier: 'validated', confidence: 0.85 });
    expect(result.newContent).toContain('tier: validated');
    expect(result.newContent).toContain('confidence: 0.85');
    expect(result.newContent).toContain('# Retry policy');
    expect(result.newContent).toContain('Use exponential backoff.');
  });

  it('preserves existing frontmatter keys not touched by updates', () => {
    const original = [
      '---',
      'title: Note',
      'tags: [retry, network]',
      'authors: alice',
      'tier: working',
      '---',
      'body',
      '',
    ].join('\n');
    const result = applyFrontmatterUpdates(original, { tier: 'validated' });
    const reparsed = parseFrontmatter(result.newContent);
    expect(reparsed.frontmatter.title).toBe('Note');
    expect(reparsed.frontmatter.authors).toBe('alice');
    expect(reparsed.frontmatter.tier).toBe('validated');
    expect(reparsed.body.trim()).toBe('body');
  });

  it('adds a frontmatter fence when the file had none', () => {
    const original = '# Plain note\n\nBody text.\n';
    const result = applyFrontmatterUpdates(original, { tier: 'working' });
    expect(result.changed).toEqual(['tier']);
    expect(result.newContent.startsWith('---\n')).toBe(true);
    expect(result.newContent).toContain('tier: working');
    expect(result.newContent).toContain('# Plain note');
  });

  it('reports no changes when the value already matches (idempotent)', () => {
    const original = [
      '---',
      'tier: validated',
      'confidence: 0.85',
      '---',
      'body',
      '',
    ].join('\n');
    // parseFrontmatter is FAILSAFE so scalars arrive as strings; an
    // operator-supplied numeric confidence still counts as a change because
    // the type differs. Tier is a string in both shapes so it should be a no-op.
    const result = applyFrontmatterUpdates(original, { tier: 'validated' });
    expect(result.changed).toEqual([]);
  });

  it('writes a trailing newline so re-parsing the result round-trips', () => {
    const original = [
      '---',
      'tier: working',
      '---',
      '# Note',
      '',
    ].join('\n');
    const result = applyFrontmatterUpdates(original, { tier: 'validated' });
    expect(result.newContent.endsWith('\n')).toBe(true);
    const reparsed = parseFrontmatter(result.newContent);
    expect(reparsed.frontmatter.tier).toBe('validated');
  });
});

// ---------------------------------------------------------------------------
// promoteApply (integration with the filesystem)
// ---------------------------------------------------------------------------

interface TmpKb {
  rootDir: string;
  cleanup: () => Promise<void>;
}

async function makeTmpKb(): Promise<TmpKb> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-promote-'));
  const rootDir = path.join(tempDir, 'kbs');
  const kbDir = path.join(rootDir, 'ops');
  await fsp.mkdir(path.join(kbDir, 'patterns'), { recursive: true });
  await fsp.writeFile(
    path.join(kbDir, 'patterns', 'retry.md'),
    [
      '---',
      'title: Retry policy',
      'tier: working',
      'confidence: 0.4',
      '---',
      '',
      '# Retry policy',
      '',
      'Use exponential backoff.',
      '',
    ].join('\n'),
    'utf-8',
  );
  return {
    rootDir,
    cleanup: () => fsp.rm(tempDir, { recursive: true, force: true }),
  };
}

describe('promoteApply', () => {
  it('dry-runs by default and does NOT write to disk', async () => {
    const { rootDir, cleanup } = await makeTmpKb();
    try {
      const filePath = path.join(rootDir, 'ops', 'patterns', 'retry.md');
      const before = await fsp.readFile(filePath, 'utf-8');

      const result = await promoteApply({
        rootDir,
        kb: 'ops',
        relativePath: 'patterns/retry.md',
        updates: { tier: 'validated', confidence: 0.85 },
        apply: false,
      });

      expect(result.applied).toBe(false);
      expect(result.changed.sort()).toEqual(['confidence', 'tier']);
      expect(result.after).toMatchObject({ tier: 'validated', confidence: 0.85 });

      // File on disk is byte-identical.
      expect(await fsp.readFile(filePath, 'utf-8')).toBe(before);
    } finally {
      await cleanup();
    }
  });

  it('rewrites the file atomically when apply=true', async () => {
    const { rootDir, cleanup } = await makeTmpKb();
    try {
      const filePath = path.join(rootDir, 'ops', 'patterns', 'retry.md');
      const result = await promoteApply({
        rootDir,
        kb: 'ops',
        relativePath: 'patterns/retry.md',
        updates: {
          tier: 'validated',
          review_status: 'approved',
          confidence: 0.85,
          last_verified_at: 'now',
        },
        apply: true,
        now: new Date('2026-05-11T12:34:56Z'),
      });
      expect(result.applied).toBe(true);
      expect(result.changed.sort()).toEqual([
        'confidence', 'last_verified_at', 'review_status', 'tier',
      ]);

      const after = await fsp.readFile(filePath, 'utf-8');
      const reparsed = parseFrontmatter(after);
      expect(reparsed.frontmatter.tier).toBe('validated');
      expect(reparsed.frontmatter.review_status).toBe('approved');
      // js-yaml may emit the date as `2026-05-11` (FAILSAFE re-parses as string).
      expect(reparsed.frontmatter.last_verified_at).toBe('2026-05-11');
      // Body survives.
      expect(after).toContain('# Retry policy');
      expect(after).toContain('Use exponential backoff.');
    } finally {
      await cleanup();
    }
  });

  it('rejects apply writes when the KB policy denies mutations', async () => {
    const { rootDir, cleanup } = await makeTmpKb();
    try {
      const filePath = path.join(rootDir, 'ops', 'patterns', 'retry.md');
      const before = await fsp.readFile(filePath, 'utf-8');
      await fsp.writeFile(
        path.join(rootDir, 'ops', KB_WRITE_POLICY_FILENAME),
        '{"mutations":"deny"}\n',
        'utf-8',
      );

      await expect(promoteApply({
        rootDir,
        kb: 'ops',
        relativePath: 'patterns/retry.md',
        updates: { tier: 'validated' },
        apply: true,
      })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(fsp.readFile(filePath, 'utf-8')).resolves.toBe(before);
    } finally {
      await cleanup();
    }
  });

  it('is a no-op write when no fields change (apply=true, changed=[])', async () => {
    const { rootDir, cleanup } = await makeTmpKb();
    try {
      const filePath = path.join(rootDir, 'ops', 'patterns', 'retry.md');
      const before = await fsp.readFile(filePath, 'utf-8');
      const result = await promoteApply({
        rootDir,
        kb: 'ops',
        relativePath: 'patterns/retry.md',
        updates: { tier: 'working' }, // already 'working'
        apply: true,
      });
      expect(result.changed).toEqual([]);
      expect(result.applied).toBe(false);
      // File untouched.
      expect(await fsp.readFile(filePath, 'utf-8')).toBe(before);
    } finally {
      await cleanup();
    }
  });

  it('rejects path traversal before touching the filesystem', async () => {
    const { rootDir, cleanup } = await makeTmpKb();
    try {
      await expect(promoteApply({
        rootDir,
        kb: 'ops',
        relativePath: '../escape.md',
        updates: { tier: 'working' },
        apply: false,
      })).rejects.toThrow(/path escapes KB root/);
    } finally {
      await cleanup();
    }
  });

  it('rejects absolute paths', async () => {
    const { rootDir, cleanup } = await makeTmpKb();
    try {
      await expect(promoteApply({
        rootDir,
        kb: 'ops',
        relativePath: '/etc/passwd',
        updates: { tier: 'working' },
        apply: false,
      })).rejects.toThrow(/path escapes KB root/);
    } finally {
      await cleanup();
    }
  });

  it('fails clearly when the target file does not exist', async () => {
    const { rootDir, cleanup } = await makeTmpKb();
    try {
      await expect(promoteApply({
        rootDir,
        kb: 'ops',
        relativePath: 'patterns/missing.md',
        updates: { tier: 'working' },
        apply: false,
      })).rejects.toThrow(/path not found/);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// promoteListCandidates
// ---------------------------------------------------------------------------

describe('promoteListCandidates', () => {
  it('dedupes by file, strips the `<kb>/` prefix, and surfaces lifecycle fields', async () => {
    const searcher: SemanticCandidateSearcher = async () => ([
      {
        pageContent: 'first chunk of retry policy',
        metadata: {
          knowledgeBase: 'ops',
          relativePath: 'ops/patterns/retry.md',
          frontmatter: {
            title: 'Retry policy',
            tier: 'working',
            confidence: 0.4,
          },
        },
        score: 0.42,
      },
      {
        pageContent: 'second chunk of retry policy',
        metadata: {
          knowledgeBase: 'ops',
          relativePath: 'ops/patterns/retry.md',
          frontmatter: { tier: 'working' },
        },
        score: 0.43,
      },
      {
        pageContent: 'unrelated dedup target',
        metadata: {
          knowledgeBase: 'ops',
          relativePath: 'ops/patterns/timeout.md',
          frontmatter: { tier: 'working' },
        },
        score: 0.6,
      },
    ]);
    const report = await promoteListCandidates({
      kb: 'ops',
      query: 'retry',
      k: 5,
      semanticSearcher: searcher,
      now: new Date('2026-05-11T00:00:00Z'),
    });
    expect(report.candidates.map((c) => c.relativePath)).toEqual([
      'patterns/retry.md',
      'patterns/timeout.md',
    ]);
    expect(report.candidates[0].frontmatter).toMatchObject({
      title: 'Retry policy',
      tier: 'working',
      confidence: 0.4,
    });
    expect(report.candidates[0].excerpt).toBe('first chunk of retry policy');
  });

  it('skips results without a usable relativePath', async () => {
    const searcher: SemanticCandidateSearcher = async () => ([
      { pageContent: 'no metadata', metadata: {}, score: 0.1 },
      { pageContent: 'short relpath', metadata: { relativePath: '' }, score: 0.2 },
    ]);
    const report = await promoteListCandidates({
      kb: 'ops',
      query: 'x',
      k: 5,
      semanticSearcher: searcher,
    });
    expect(report.candidates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

describe('promote formatting', () => {
  it('renders list markdown with header, query, and lifecycle JSON', () => {
    const md = formatPromoteListMarkdown({
      kb: 'ops',
      query: 'retry',
      generatedAt: '2026-05-11T00:00:00.000Z',
      candidates: [{
        relativePath: 'patterns/retry.md',
        score: 0.42,
        excerpt: 'use exponential backoff',
        frontmatter: { tier: 'working', confidence: 0.4 },
      }],
    });
    expect(md).toContain('## Promote — Candidate Review');
    expect(md).toContain('Knowledge base: `ops`');
    expect(md).toContain('patterns/retry.md');
    expect(md).toContain('"tier": "working"');
    expect(md).toContain('use exponential backoff');
  });

  it('renders an empty-candidates message in list markdown', () => {
    const md = formatPromoteListMarkdown({
      kb: 'ops',
      query: 'nothing here',
      generatedAt: '2026-05-11T00:00:00.000Z',
      candidates: [],
    });
    expect(md).toContain('No candidates found');
  });

  it('renders list JSON identically to JSON.stringify with 2-space indent', () => {
    const report = {
      kb: 'ops',
      query: 'r',
      generatedAt: '2026-05-11T00:00:00.000Z',
      candidates: [],
    };
    expect(formatPromoteListJson(report)).toBe(JSON.stringify(report, null, 2));
  });

  it('renders apply markdown with dry-run hint when changes exist but not applied', () => {
    const md = formatPromoteApplyMarkdown({
      kb: 'ops',
      relativePath: 'patterns/retry.md',
      applied: false,
      before: { tier: 'working' },
      after: { tier: 'validated' },
      changed: ['tier'],
    });
    expect(md).toContain('(dry-run)');
    expect(md).toContain('Changed keys: tier');
    expect(md).toContain('--yes');
  });

  it('renders apply markdown with no-op tag when nothing changed', () => {
    const md = formatPromoteApplyMarkdown({
      kb: 'ops',
      relativePath: 'patterns/retry.md',
      applied: false,
      before: { tier: 'working' },
      after: { tier: 'working' },
      changed: [],
    });
    expect(md).toContain('(no-op)');
    expect(md).toContain('Changed keys: none');
  });

  it('renders apply markdown with applied tag and no dry-run hint when written', () => {
    const md = formatPromoteApplyMarkdown({
      kb: 'ops',
      relativePath: 'patterns/retry.md',
      applied: true,
      before: { tier: 'working' },
      after: { tier: 'validated' },
      changed: ['tier'],
    });
    expect(md).toContain('(applied)');
    expect(md).not.toContain('--yes');
  });

  it('renders apply JSON via JSON.stringify with 2-space indent', () => {
    const result = {
      kb: 'ops',
      relativePath: 'patterns/retry.md',
      applied: true,
      before: { tier: 'working' },
      after: { tier: 'validated' },
      changed: ['tier'],
    };
    expect(formatPromoteApplyJson(result)).toBe(JSON.stringify(result, null, 2));
  });
});
