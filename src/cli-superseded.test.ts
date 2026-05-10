import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  formatSupersededJson,
  formatSupersededMarkdown,
  parseSupersededArgs,
  supersededCheck,
  type SemanticNeighborSearcher,
} from './cli-superseded.js';

describe('parseSupersededArgs', () => {
  it('parses the documented flags', () => {
    expect(parseSupersededArgs([
      '--kb=ops',
      '--format=json',
      '--k=7',
      '--include-clean',
      '--model=ollama__nomic-embed-text-latest',
    ])).toEqual({
      kb: 'ops',
      format: 'json',
      k: 7,
      includeClean: true,
      model: 'ollama__nomic-embed-text-latest',
    });
  });

  it('rejects missing --kb', () => {
    expect(() => parseSupersededArgs([])).toThrow('missing --kb=<name>');
  });

  it('rejects invalid flags', () => {
    expect(() => parseSupersededArgs(['--kb=ops', '--format=yaml'])).toThrow('invalid --format');
    expect(() => parseSupersededArgs(['--kb=ops', '--k=0'])).toThrow('invalid --k');
    expect(() => parseSupersededArgs(['--kb=ops', '--zzz'])).toThrow('unknown flag');
  });
});

describe('supersededCheck', () => {
  async function makeKb(): Promise<{ rootDir: string; cleanup: () => Promise<void> }> {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-superseded-'));
    const rootDir = path.join(tempDir, 'kbs');
    const kbDir = path.join(rootDir, 'ops');
    await fsp.mkdir(path.join(kbDir, 'patterns'), { recursive: true });
    await fsp.writeFile(
      path.join(kbDir, 'patterns', 'old-low.md'),
      [
        '---',
        'status: active',
        'confidence: 0.2',
        'last_verified_at: 2025-01-01',
        '---',
        '# Old Low Confidence',
        '',
        'Old agent memory that may have been replaced.',
      ].join('\n') + '\n',
      'utf-8',
    );
    await fsp.writeFile(
      path.join(kbDir, 'patterns', 'current.md'),
      [
        '---',
        'status: active',
        'confidence: 0.9',
        'last_verified_at: 2026-05-01',
        '---',
        '# Current',
        '',
        'Newer replacement note.',
      ].join('\n') + '\n',
      'utf-8',
    );
    await fsp.writeFile(
      path.join(kbDir, 'contradicted.md'),
      [
        '---',
        'contradicted_by:',
        '  - patterns/current.md',
        '---',
        '# Contradicted',
      ].join('\n') + '\n',
      'utf-8',
    );
    await fsp.writeFile(
      path.join(kbDir, 'archived.md'),
      [
        '---',
        'review_status: archived',
        '---',
        '# Archived',
      ].join('\n') + '\n',
      'utf-8',
    );
    return {
      rootDir,
      cleanup: async () => fsp.rm(tempDir, { recursive: true, force: true }),
    };
  }

  it('flags lifecycle metadata and conservative same-KB semantic neighbors', async () => {
    const { rootDir, cleanup } = await makeKb();
    try {
      const searcher: SemanticNeighborSearcher = async (note) => {
        if (note.relPath !== 'patterns/old-low.md') return [];
        return [{
          pageContent: 'Newer replacement note.',
          metadata: {
            knowledgeBase: 'ops',
            relativePath: 'ops/patterns/current.md',
            frontmatter: {
              status: 'active',
              confidence: 0.9,
              last_verified_at: '2026-05-01',
            },
          },
          score: 0.42,
        }];
      };

      const report = await supersededCheck({
        rootDir,
        kb: 'ops',
        k: 5,
        includeClean: false,
        now: new Date('2026-05-10T00:00:00Z'),
        semanticSearcher: searcher,
      });

      expect(report.totals.filesScanned).toBe(4);
      expect(report.totals.candidates).toBe(3);
      const byPath = new Map(report.candidates.map((c) => [c.candidate, c]));
      expect(byPath.get('patterns/old-low.md')?.reasons).toEqual([
        'stale_last_verified_at',
        'low_confidence_active_note',
        'newer_near_neighbor',
      ]);
      expect(byPath.get('patterns/old-low.md')?.evidence).toEqual([{
        path: 'patterns/current.md',
        score: 0.42,
        newer_by_days: 485,
        reason: 'newer_or_stronger_neighbor',
      }]);
      expect(byPath.get('contradicted.md')?.reasons).toContain('explicit_contradiction');
      expect(byPath.get('archived.md')?.reasons).toContain('deprecated_status');
      expect(byPath.has('patterns/current.md')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('can include clean notes in read-only output', async () => {
    const { rootDir, cleanup } = await makeKb();
    try {
      const report = await supersededCheck({
        rootDir,
        kb: 'ops',
        k: 5,
        includeClean: true,
        now: new Date('2026-05-10T00:00:00Z'),
        semanticSearcher: async () => [],
      });
      const clean = report.candidates.find((c) => c.candidate === 'patterns/current.md');
      expect(clean).toBeDefined();
      expect(clean?.reasons).toEqual([]);
      expect(clean?.suggested_action).toBe('no action suggested');
    } finally {
      await cleanup();
    }
  });
});

describe('superseded formatting', () => {
  it('renders JSON and markdown with candidates, evidence, and totals', () => {
    const report = {
      kb: 'ops',
      generatedAt: '2026-05-10T00:00:00.000Z',
      totals: { filesScanned: 2, candidates: 1, clean: 1 },
      candidates: [{
        candidate: 'old.md',
        reasons: ['newer_near_neighbor' as const],
        evidence: [{ path: 'new.md', score: 0.4, newer_by_days: 12, reason: 'newer_or_stronger_neighbor' as const }],
        frontmatter: { status: 'active', confidence: 0.2 },
        suggested_action: 'review candidate and consider status=deprecated or contradicted_by',
      }],
    };

    const parsed = JSON.parse(formatSupersededJson(report));
    expect(parsed.totals.candidates).toBe(1);
    expect(parsed.candidates[0].evidence[0].path).toBe('new.md');

    const md = formatSupersededMarkdown(report);
    expect(md).toContain('## Superseded Review');
    expect(md).toContain('old.md');
    expect(md).toContain('newer_near_neighbor');
    expect(md).toContain('Summary: 1 candidate(s), 1 clean note(s), 2 file(s) scanned.');
  });
});
