// RFC 017 M0c — unit tests for `src/cli-eval-compare.ts`.
//
// The compare path requires two loaded FAISS indexes. Rather than
// constructing real ones, we drive `runCompareEval` against a mock
// manager whose `similaritySearch` returns scripted results — that
// covers the diff/report logic without touching faiss-node.

import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  formatCompareReportMarkdown,
  resolveIndexVersionPath,
  runCompareEval,
  type CompareReport,
} from './cli-eval-compare.js';
import type { ScoredDocument } from './formatter.js';
import type { RetrievalEvalFixture } from './retrieval-eval.js';
import type { FaissIndexManager } from './FaissIndexManager.js';

// Build a fake document that retrieval-eval's pipeline accepts.
function doc(source: string, score: number): ScoredDocument {
  return {
    pageContent: `content of ${source}`,
    metadata: {
      source,
      relativePath: source,
      knowledgeBase: 'alpha',
      extension: '.md',
      chunkIndex: 0,
      score,
    },
  } as unknown as ScoredDocument;
}

function fixture(): RetrievalEvalFixture {
  return {
    cases: [
      { name: 'case A', query: 'query about deployments' } as RetrievalEvalFixture['cases'][0],
    ],
  } as RetrievalEvalFixture;
}

// Stage scripted results for each pass. The compare flow calls
// `loadFromVersionDir(dir)` then runs queries; we use the dir path to
// pick which result set to return on the next `similaritySearch` call.
function fakeManager(scripted: Record<string, ScoredDocument[]>): FaissIndexManager {
  let activeDir = '';
  const handle = {
    modelDir: '/fake/model',
    async loadFromVersionDir(dir: string): Promise<void> {
      activeDir = dir;
    },
    async similaritySearch(
      _query: string,
      _k: number,
      _threshold: number,
    ): Promise<ScoredDocument[]> {
      const r = scripted[activeDir];
      if (r === undefined) {
        throw new Error(`fakeManager: no scripted results for ${activeDir}`);
      }
      return r;
    },
  };
  return handle as unknown as FaissIndexManager;
}

// runCompareEval requires the version dirs to exist on disk. Stage a
// pair of empty version dirs with the two required files inside.
async function stageVersionDir(tmp: string, name: string): Promise<string> {
  const dir = path.join(tmp, name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'faiss.index'), 'fake');
  await fsp.writeFile(path.join(dir, 'docstore.json'), '{}');
  return dir;
}

describe('resolveIndexVersionPath', () => {
  it('expands a numeric version into <modelDir>/index.v<n>', () => {
    expect(resolveIndexVersionPath('42', '/m')).toBe('/m/index.v42');
    expect(resolveIndexVersionPath('0', '/m')).toBe('/m/index.v0');
  });

  it('passes absolute paths through unchanged', () => {
    expect(resolveIndexVersionPath('/some/abs/path', '/m')).toBe('/some/abs/path');
  });

  it('resolves relative paths against the model dir', () => {
    expect(resolveIndexVersionPath('index.v17', '/m')).toBe('/m/index.v17');
    expect(resolveIndexVersionPath('subdir/index.v1', '/m')).toBe('/m/subdir/index.v1');
  });
});

describe('runCompareEval', () => {
  it('reports rank changes when sources reorder between versions', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-eval-compare-'));
    try {
      const beforeDir = await stageVersionDir(tmp, 'index.v1');
      const afterDir = await stageVersionDir(tmp, 'index.v2');

      // Before: notes/deploy.md is rank 1; notes/rollback.md is rank 2.
      // After: rollback.md jumps to rank 1, deploy.md slips to rank 2.
      const manager = fakeManager({
        [beforeDir]: [doc('notes/deploy.md', 0.10), doc('notes/rollback.md', 0.20)],
        [afterDir]: [doc('notes/rollback.md', 0.08), doc('notes/deploy.md', 0.12)],
      });

      const report = await runCompareEval({
        manager,
        fixture: fixture(),
        before: beforeDir,
        after: afterDir,
        defaultK: 10,
        defaultThreshold: 2,
        defaultMode: 'dense',
      });

      expect(report.case_count).toBe(1);
      const c = report.cases[0];
      expect(c.before.top_sources).toEqual(['notes/deploy.md', 'notes/rollback.md']);
      expect(c.after.top_sources).toEqual(['notes/rollback.md', 'notes/deploy.md']);
      expect(c.changes.result_count_delta).toBe(0);
      expect(c.changes.new_sources).toEqual([]);
      expect(c.changes.dropped_sources).toEqual([]);
      expect(c.changes.rank_changes).toHaveLength(2);
      // rollback.md improved from rank 1 (index 1) to rank 0 (index 0) — rank_delta = +1
      const rollbackChange = c.changes.rank_changes.find((rc) => rc.source === 'notes/rollback.md');
      expect(rollbackChange?.rank_delta).toBe(1);
      const deployChange = c.changes.rank_changes.find((rc) => rc.source === 'notes/deploy.md');
      expect(deployChange?.rank_delta).toBe(-1);

      expect(report.aggregate.cases_with_top1_change).toBe(1);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('reports new and dropped sources when top-K membership changes', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-eval-compare-'));
    try {
      const beforeDir = await stageVersionDir(tmp, 'index.v1');
      const afterDir = await stageVersionDir(tmp, 'index.v2');

      const manager = fakeManager({
        [beforeDir]: [doc('a.md', 0.1), doc('b.md', 0.2), doc('c.md', 0.3)],
        [afterDir]: [doc('a.md', 0.1), doc('d.md', 0.2), doc('e.md', 0.3)],
      });

      const report = await runCompareEval({
        manager,
        fixture: fixture(),
        before: beforeDir,
        after: afterDir,
        defaultK: 10,
        defaultThreshold: 2,
        defaultMode: 'dense',
      });

      const c = report.cases[0];
      expect(c.changes.new_sources.sort()).toEqual(['d.md', 'e.md']);
      expect(c.changes.dropped_sources.sort()).toEqual(['b.md', 'c.md']);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('reports mean_score_delta when scores shift', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-eval-compare-'));
    try {
      const beforeDir = await stageVersionDir(tmp, 'index.v1');
      const afterDir = await stageVersionDir(tmp, 'index.v2');

      const manager = fakeManager({
        [beforeDir]: [doc('a.md', 0.5), doc('b.md', 0.5)],
        [afterDir]: [doc('a.md', 0.1), doc('b.md', 0.1)],
      });

      const report = await runCompareEval({
        manager,
        fixture: fixture(),
        before: beforeDir,
        after: afterDir,
        defaultK: 10,
        defaultThreshold: 2,
        defaultMode: 'dense',
      });

      const c = report.cases[0];
      expect(c.before.mean_score).toBeCloseTo(0.5, 4);
      expect(c.after.mean_score).toBeCloseTo(0.1, 4);
      // Lower score = closer match for dense retrieval (L2 distance), so a
      // negative delta means the AFTER side is closer to the query than
      // BEFORE — i.e. retrieval improved.
      expect(c.changes.mean_score_delta).toBeCloseTo(-0.4, 4);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a version dir that is missing faiss.index', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-eval-compare-'));
    try {
      const beforeDir = await stageVersionDir(tmp, 'index.v1');
      const afterDir = path.join(tmp, 'index.v2');
      await fsp.mkdir(afterDir, { recursive: true });
      // Only write the docstore, omit faiss.index.
      await fsp.writeFile(path.join(afterDir, 'docstore.json'), '{}');

      const manager = fakeManager({});
      await expect(
        runCompareEval({
          manager,
          fixture: fixture(),
          before: beforeDir,
          after: afterDir,
          defaultK: 10,
          defaultThreshold: 2,
          defaultMode: 'dense',
        }),
      ).rejects.toThrow(/missing faiss\.index/);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('formatCompareReportMarkdown', () => {
  it('renders the aggregate table and per-case sections', () => {
    const report: CompareReport = {
      schema_version: 'kb-eval-compare.v1',
      before_path: '/m/index.v1',
      after_path: '/m/index.v2',
      case_count: 1,
      cases: [
        {
          name: 'case A',
          query: 'q',
          mode: 'dense',
          before: { result_count: 2, top_sources: ['a', 'b'], top_scores: [0.1, 0.2], mean_score: 0.15 },
          after:  { result_count: 2, top_sources: ['b', 'a'], top_scores: [0.1, 0.2], mean_score: 0.15 },
          changes: {
            result_count_delta: 0,
            mean_score_delta: 0,
            new_sources: [],
            dropped_sources: [],
            rank_changes: [
              { source: 'a', before_rank: 0, after_rank: 1, rank_delta: -1 },
              { source: 'b', before_rank: 1, after_rank: 0, rank_delta: 1 },
            ],
          },
        },
      ],
      aggregate: {
        mean_result_count_delta: 0,
        mean_score_delta: 0,
        new_sources_per_case: 0,
        dropped_sources_per_case: 0,
        cases_with_top1_change: 1,
      },
    };
    const md = formatCompareReportMarkdown(report);
    expect(md).toContain('# kb eval --compare-index');
    expect(md).toContain('case A');
    expect(md).toContain('Rank shifts');
    expect(md).toContain('Cases with top-1 change');
  });
});
