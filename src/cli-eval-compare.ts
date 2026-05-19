// RFC 017 M0c — `kb eval --compare-index --before=<v> --after=<v>`.
//
// Measurement infrastructure that M1 needs to make a real go/no-go
// call on contextual retrieval. Runs the same fixture against two
// historical index versions of the active model and emits a per-case
// rank/score diff.
//
// The two indexes are loaded sequentially through the same
// FaissIndexManager (via `loadFromVersionDir`) — there's no need to
// hold both in memory at once, and the single-manager design reuses
// every query-side concern (post-filters, query cache, mode dispatch)
// from `manager.similaritySearch`.

import * as path from 'path';
import * as fsp from 'fs/promises';

import { FaissIndexManager } from './FaissIndexManager.js';
import {
  retrieveForRetrievalEvalCase,
  type RetrievalEvalFixture,
} from './retrieval-eval.js';
import type { ScoredDocument } from './formatter.js';
import type { SearchMode } from './search-core.js';

export interface CompareEvalOptions {
  manager: FaissIndexManager;
  fixture: RetrievalEvalFixture;
  before: string;
  after: string;
  defaultK: number;
  defaultThreshold: number;
  defaultMode: SearchMode;
}

export interface CompareCaseResult {
  name: string;
  query: string;
  kb?: string;
  mode: SearchMode;
  before: CompareSnapshot;
  after: CompareSnapshot;
  changes: CompareChanges;
}

export interface CompareSnapshot {
  result_count: number;
  top_sources: string[]; // up to 10
  top_scores: number[];  // aligned with top_sources
  mean_score: number | null;
}

export interface CompareChanges {
  result_count_delta: number;
  mean_score_delta: number | null;
  // Sources that appeared in `after` but not `before` (within top-K).
  new_sources: string[];
  // Sources that vanished from top-K.
  dropped_sources: string[];
  // For sources present in both top-K snapshots: rank delta (positive = improved).
  rank_changes: Array<{ source: string; before_rank: number; after_rank: number; rank_delta: number }>;
}

export interface CompareReport {
  schema_version: 'kb-eval-compare.v1';
  before_path: string;
  after_path: string;
  case_count: number;
  cases: CompareCaseResult[];
  aggregate: {
    mean_result_count_delta: number;
    mean_score_delta: number | null;
    new_sources_per_case: number;
    dropped_sources_per_case: number;
    cases_with_top1_change: number;
  };
}

/**
 * Resolve `--before=<arg>` to an absolute path. If `arg` parses as a
 * non-negative integer, it's expanded to `<modelDir>/index.v<arg>`.
 * Otherwise treated as a path (relative paths are resolved against
 * `<modelDir>`).
 */
export function resolveIndexVersionPath(arg: string, modelDir: string): string {
  if (/^\d+$/.test(arg)) {
    return path.join(modelDir, `index.v${arg}`);
  }
  if (path.isAbsolute(arg)) return arg;
  return path.join(modelDir, arg);
}

export async function assertIndexVersionDir(versionPath: string): Promise<void> {
  let stat: import('fs').Stats;
  try {
    stat = await fsp.stat(versionPath);
  } catch (err) {
    throw new Error(
      `kb eval --compare-index: index version directory not found: ${versionPath} (${(err as Error).message})`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `kb eval --compare-index: expected a directory at ${versionPath}, found a file`,
    );
  }
  // FaissStore.load reads `${versionPath}/faiss.index` and
  // `${versionPath}/docstore.json`; fail fast if either is missing so
  // we don't surface a cryptic load error to the operator.
  for (const name of ['faiss.index', 'docstore.json']) {
    try {
      await fsp.access(path.join(versionPath, name));
    } catch {
      throw new Error(
        `kb eval --compare-index: ${versionPath} is not a complete FAISS version dir (missing ${name})`,
      );
    }
  }
}

export async function runCompareEval(opts: CompareEvalOptions): Promise<CompareReport> {
  await assertIndexVersionDir(opts.before);
  await assertIndexVersionDir(opts.after);

  // Pass 1 — load `before`, query every case, collect results.
  await opts.manager.loadFromVersionDir(opts.before);
  const beforeResults = await queryFixture(opts);

  // Pass 2 — load `after`, query every case again.
  await opts.manager.loadFromVersionDir(opts.after);
  const afterResults = await queryFixture(opts);

  const cases: CompareCaseResult[] = opts.fixture.cases.map((fixtureCase, i) => {
    const before = toSnapshot(beforeResults[i]);
    const after = toSnapshot(afterResults[i]);
    return {
      name: fixtureCase.name,
      query: fixtureCase.query,
      ...(fixtureCase.kb !== undefined ? { kb: fixtureCase.kb } : {}),
      mode: fixtureCase.mode ?? opts.defaultMode,
      before,
      after,
      changes: diffSnapshots(before, after),
    };
  });

  return {
    schema_version: 'kb-eval-compare.v1',
    before_path: opts.before,
    after_path: opts.after,
    case_count: cases.length,
    cases,
    aggregate: aggregate(cases),
  };
}

async function queryFixture(opts: CompareEvalOptions): Promise<ScoredDocument[][]> {
  const out: ScoredDocument[][] = [];
  for (const fixtureCase of opts.fixture.cases) {
    const requestedMode = fixtureCase.mode ?? opts.defaultMode;
    const search = await retrieveForRetrievalEvalCase(
      fixtureCase,
      {
        manager: opts.manager,
        defaultK: opts.defaultK,
        defaultThreshold: opts.defaultThreshold,
      },
      requestedMode,
    );
    out.push(search.results);
  }
  return out;
}

function toSnapshot(results: ScoredDocument[]): CompareSnapshot {
  const topK = Math.min(results.length, 10);
  const sources = results.slice(0, topK).map((r) => sourceOf(r));
  const scores = results.slice(0, topK).map((r) => scoreOf(r));
  const meanScore = results.length === 0
    ? null
    : results.reduce((sum, r) => sum + scoreOf(r), 0) / results.length;
  return {
    result_count: results.length,
    top_sources: sources,
    top_scores: scores,
    mean_score: meanScore,
  };
}

function diffSnapshots(before: CompareSnapshot, after: CompareSnapshot): CompareChanges {
  const beforeSources = new Set(before.top_sources);
  const afterSources = new Set(after.top_sources);
  const newSources = [...afterSources].filter((s) => !beforeSources.has(s));
  const droppedSources = [...beforeSources].filter((s) => !afterSources.has(s));
  const rankChanges: CompareChanges['rank_changes'] = [];
  for (const source of beforeSources) {
    if (!afterSources.has(source)) continue;
    const beforeRank = before.top_sources.indexOf(source);
    const afterRank = after.top_sources.indexOf(source);
    if (beforeRank === afterRank) continue;
    rankChanges.push({
      source,
      before_rank: beforeRank,
      after_rank: afterRank,
      rank_delta: beforeRank - afterRank, // positive = improved (smaller rank index)
    });
  }
  rankChanges.sort((a, b) => Math.abs(b.rank_delta) - Math.abs(a.rank_delta));
  return {
    result_count_delta: after.result_count - before.result_count,
    mean_score_delta:
      before.mean_score !== null && after.mean_score !== null
        ? after.mean_score - before.mean_score
        : null,
    new_sources: newSources,
    dropped_sources: droppedSources,
    rank_changes: rankChanges,
  };
}

function aggregate(cases: CompareCaseResult[]): CompareReport['aggregate'] {
  if (cases.length === 0) {
    return {
      mean_result_count_delta: 0,
      mean_score_delta: null,
      new_sources_per_case: 0,
      dropped_sources_per_case: 0,
      cases_with_top1_change: 0,
    };
  }
  let totalResultDelta = 0;
  let totalScoreDelta = 0;
  let scoreDeltaCount = 0;
  let totalNew = 0;
  let totalDropped = 0;
  let top1Changes = 0;
  for (const c of cases) {
    totalResultDelta += c.changes.result_count_delta;
    if (c.changes.mean_score_delta !== null) {
      totalScoreDelta += c.changes.mean_score_delta;
      scoreDeltaCount += 1;
    }
    totalNew += c.changes.new_sources.length;
    totalDropped += c.changes.dropped_sources.length;
    if (
      c.before.top_sources.length > 0 &&
      c.after.top_sources.length > 0 &&
      c.before.top_sources[0] !== c.after.top_sources[0]
    ) {
      top1Changes += 1;
    }
  }
  return {
    mean_result_count_delta: totalResultDelta / cases.length,
    mean_score_delta: scoreDeltaCount > 0 ? totalScoreDelta / scoreDeltaCount : null,
    new_sources_per_case: totalNew / cases.length,
    dropped_sources_per_case: totalDropped / cases.length,
    cases_with_top1_change: top1Changes,
  };
}

function sourceOf(result: ScoredDocument): string {
  const meta = result.metadata as Record<string, unknown> | undefined;
  const rel = meta?.relativePath;
  if (typeof rel === 'string' && rel.length > 0) return rel;
  const src = meta?.source;
  if (typeof src === 'string' && src.length > 0) return src;
  return '<unknown>';
}

function scoreOf(result: ScoredDocument): number {
  const meta = result.metadata as Record<string, unknown> | undefined;
  const score = meta?.score;
  if (typeof score === 'number' && Number.isFinite(score)) return score;
  return 0;
}

export function formatCompareReportMarkdown(report: CompareReport): string {
  const lines: string[] = [];
  lines.push(`# kb eval --compare-index`);
  lines.push('');
  lines.push(`- **Before**: \`${report.before_path}\``);
  lines.push(`- **After**:  \`${report.after_path}\``);
  lines.push(`- **Cases**:  ${report.case_count}`);
  lines.push('');
  lines.push('## Aggregate');
  lines.push('');
  lines.push(`| metric | value |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Mean result-count delta | ${report.aggregate.mean_result_count_delta.toFixed(2)} |`);
  lines.push(
    `| Mean score delta | ${
      report.aggregate.mean_score_delta === null ? 'n/a' : report.aggregate.mean_score_delta.toFixed(4)
    } |`,
  );
  lines.push(`| New sources per case (avg) | ${report.aggregate.new_sources_per_case.toFixed(2)} |`);
  lines.push(`| Dropped sources per case (avg) | ${report.aggregate.dropped_sources_per_case.toFixed(2)} |`);
  lines.push(`| Cases with top-1 change | ${report.aggregate.cases_with_top1_change} / ${report.case_count} |`);
  lines.push('');
  lines.push('## Per case');
  lines.push('');
  for (const c of report.cases) {
    lines.push(`### ${c.name}`);
    lines.push(`- Query: \`${c.query}\`${c.kb !== undefined ? `  (kb=${c.kb})` : ''}`);
    lines.push(`- Mode: ${c.mode}`);
    const resultDeltaStr = c.changes.result_count_delta >= 0
      ? `+${c.changes.result_count_delta}`
      : String(c.changes.result_count_delta);
    lines.push(`- Results: ${c.before.result_count} → ${c.after.result_count} (Δ ${resultDeltaStr})`);
    lines.push(
      `- Mean score: ${formatNum(c.before.mean_score)} → ${formatNum(c.after.mean_score)} (Δ ${formatNum(c.changes.mean_score_delta, true)})`,
    );
    if (c.changes.new_sources.length > 0) {
      lines.push(`- **New top-K sources**: ${c.changes.new_sources.map((s) => `\`${s}\``).join(', ')}`);
    }
    if (c.changes.dropped_sources.length > 0) {
      lines.push(`- **Dropped from top-K**: ${c.changes.dropped_sources.map((s) => `\`${s}\``).join(', ')}`);
    }
    if (c.changes.rank_changes.length > 0) {
      lines.push(`- **Rank shifts** (top 3):`);
      for (const rc of c.changes.rank_changes.slice(0, 3)) {
        const arrow = rc.rank_delta > 0 ? '↑' : '↓';
        lines.push(`  - ${arrow} \`${rc.source}\` rank ${rc.before_rank + 1} → ${rc.after_rank + 1}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatNum(value: number | null, signed = false): string {
  if (value === null) return 'n/a';
  if (signed) {
    const formatted = value.toFixed(4);
    return value > 0 ? `+${formatted}` : formatted;
  }
  return value.toFixed(4);
}
