import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  formatDiffIndexMarkdown,
  resolveIndexVersionPath,
  runDiffIndex,
  type DiffIndexManager,
} from './diff-index-core.js';
import type { ScoredDocument } from './formatter.js';

interface FakeSearchCall {
  versionDir: string;
  query: string;
  k?: number;
  threshold?: number;
  knowledgeBaseName?: string;
}

function doc(source: string, chunkIndex: number, score: number): ScoredDocument {
  return {
    pageContent: `content for ${source}`,
    metadata: {
      source,
      relativePath: source,
      knowledgeBase: 'alpha',
      chunkIndex,
    },
    score,
  } as ScoredDocument;
}

function fakeManager(scripted: Record<string, ScoredDocument[]>): DiffIndexManager & { calls: FakeSearchCall[] } {
  let activeDir = '';
  const calls: FakeSearchCall[] = [];
  return {
    calls,
    async loadFromVersionDir(dir: string): Promise<void> {
      activeDir = dir;
    },
    async similaritySearch(
      query: string,
      k?: number,
      threshold?: number,
      knowledgeBaseName?: string,
    ): Promise<ScoredDocument[]> {
      calls.push({ versionDir: activeDir, query, k, threshold, knowledgeBaseName });
      const results = scripted[activeDir];
      if (results === undefined) {
        throw new Error(`missing scripted results for ${activeDir}`);
      }
      return results;
    },
  };
}

async function stageVersionDir(tmp: string, name: string): Promise<string> {
  const dir = path.join(tmp, name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'faiss.index'), 'fake');
  await fsp.writeFile(path.join(dir, 'docstore.json'), '{}');
  return dir;
}

describe('resolveIndexVersionPath', () => {
  it('expands numeric versions under the model directory', () => {
    expect(resolveIndexVersionPath('4', '/models/active')).toBe('/models/active/index.v4');
  });

  it('preserves absolute paths and resolves relative paths under the model directory', () => {
    expect(resolveIndexVersionPath('/tmp/index.v4', '/models/active')).toBe('/tmp/index.v4');
    expect(resolveIndexVersionPath('index.v4', '/models/active')).toBe('/models/active/index.v4');
  });
});

describe('runDiffIndex', () => {
  it('reports moved, new, and dropped chunks with aggregate churn', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-diff-index-'));
    try {
      const beforeDir = await stageVersionDir(tmp, 'index.v1');
      const afterDir = await stageVersionDir(tmp, 'index.v2');
      const manager = fakeManager({
        [beforeDir]: [
          doc('notes/deploy.md', 0, 0.10),
          doc('notes/rollback.md', 0, 0.20),
          doc('notes/old.md', 0, 0.30),
        ],
        [afterDir]: [
          doc('notes/rollback.md', 0, 0.11),
          doc('notes/deploy.md', 0, 0.15),
          doc('notes/new.md', 0, 0.22),
        ],
      });

      const report = await runDiffIndex({
        manager,
        before: beforeDir,
        after: afterDir,
        queries: [{ name: 'deployment', query: 'deployment rollback', kb: 'alpha' }],
        topK: 3,
        threshold: 2,
      });

      expect(report.schema_version).toBe('kb.diff-index.v1');
      expect(report.query_count).toBe(1);
      expect(report.summary.moved_queries).toBe(1);
      expect(report.summary.top1_changed_queries).toBe(1);
      expect(report.summary.mean_stability_score).toBeLessThan(1);
      expect(report.summary.by_kb.alpha.queries).toBe(1);
      expect(manager.calls).toEqual([
        {
          versionDir: beforeDir,
          query: 'deployment rollback',
          k: 3,
          threshold: 2,
          knowledgeBaseName: 'alpha',
        },
        {
          versionDir: afterDir,
          query: 'deployment rollback',
          k: 3,
          threshold: 2,
          knowledgeBaseName: 'alpha',
        },
      ]);

      const query = report.queries[0];
      expect(query.before_top_k.map((chunk) => chunk.source)).toEqual([
        'notes/deploy.md',
        'notes/rollback.md',
        'notes/old.md',
      ]);
      expect(query.after_top_k.map((chunk) => chunk.source)).toEqual([
        'notes/rollback.md',
        'notes/deploy.md',
        'notes/new.md',
      ]);
      expect(query.rank_deltas).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'notes/new.md', before_rank: null, after_rank: 3, status: 'new' }),
          expect.objectContaining({ source: 'notes/old.md', before_rank: 3, after_rank: null, status: 'dropped' }),
          expect.objectContaining({ source: 'notes/rollback.md', before_rank: 2, after_rank: 1, rank_delta: -1, status: 'moved' }),
        ]),
      );
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('renders markdown with summary and changed rows', () => {
    const markdown = formatDiffIndexMarkdown({
      schema_version: 'kb.diff-index.v1',
      before_path: '/m/index.v1',
      after_path: '/m/index.v2',
      top_k: 2,
      threshold: 2,
      query_count: 1,
      queries: [{
        query: 'q',
        before_top_k: [],
        after_top_k: [],
        rank_deltas: [{
          chunk_id: 'a#0',
          source: 'a.md',
          before_rank: 2,
          after_rank: 1,
          rank_delta: -1,
          absolute_rank_delta: 1,
          percent_rank_delta: 0.5,
          status: 'moved',
        }],
        stability_score: 0.5,
        churn_score: 0.5,
        top1_changed: true,
      }],
      summary: {
        mean_stability_score: 0.5,
        mean_churn_score: 0.5,
        stable_queries: 0,
        moved_queries: 1,
        top1_changed_queries: 1,
        mean_new_chunks: 0,
        mean_dropped_chunks: 0,
        by_kb: { ALL: { queries: 1, mean_stability_score: 0.5, mean_churn_score: 0.5 } },
      },
    });

    expect(markdown).toContain('# kb diff-index');
    expect(markdown).toContain('Mean stability score');
    expect(markdown).toContain('| moved | 2 | 1 | -1 | `a.md` |');
  });
});
