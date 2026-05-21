import * as fsp from 'fs/promises';
import * as path from 'path';

import type { ScoredDocument } from './formatter.js';
import { chunkIdFromMetadata } from './rrf.js';

export interface DiffIndexManager {
  loadFromVersionDir(versionDir: string): Promise<void>;
  similaritySearch(
    query: string,
    k?: number,
    threshold?: number,
    knowledgeBaseName?: string,
  ): Promise<ScoredDocument[]>;
}

export interface DiffIndexQuery {
  name?: string;
  query: string;
  kb?: string;
}

export interface DiffIndexOptions {
  manager: DiffIndexManager;
  before: string;
  after: string;
  queries: DiffIndexQuery[];
  topK: number;
  threshold: number;
}

export interface DiffIndexRankedChunk {
  chunk_id: string;
  rank: number;
  score: number | null;
  source: string;
  relative_path?: string;
  knowledge_base?: string;
  chunk_index?: number;
}

export interface DiffIndexRankDelta {
  chunk_id: string;
  source: string;
  before_rank: number | null;
  after_rank: number | null;
  rank_delta: number | null;
  absolute_rank_delta: number;
  percent_rank_delta: number;
  status: 'stable' | 'moved' | 'new' | 'dropped';
}

export interface DiffIndexQueryReport {
  name?: string;
  query: string;
  kb?: string;
  before_top_k: DiffIndexRankedChunk[];
  after_top_k: DiffIndexRankedChunk[];
  rank_deltas: DiffIndexRankDelta[];
  stability_score: number;
  churn_score: number;
  top1_changed: boolean;
}

export interface DiffIndexKbSummary {
  queries: number;
  mean_stability_score: number;
  mean_churn_score: number;
}

export interface DiffIndexReport {
  schema_version: 'kb.diff-index.v1';
  before_path: string;
  after_path: string;
  top_k: number;
  threshold: number;
  query_count: number;
  queries: DiffIndexQueryReport[];
  summary: {
    mean_stability_score: number;
    mean_churn_score: number;
    stable_queries: number;
    moved_queries: number;
    top1_changed_queries: number;
    mean_new_chunks: number;
    mean_dropped_chunks: number;
    by_kb: Record<string, DiffIndexKbSummary>;
  };
}

export function resolveIndexVersionPath(arg: string, modelDir: string): string {
  if (/^\d+$/.test(arg)) return path.join(modelDir, `index.v${arg}`);
  if (path.isAbsolute(arg)) return arg;
  return path.join(modelDir, arg);
}

export async function assertIndexVersionDir(
  versionPath: string,
  commandName = 'kb diff-index',
): Promise<void> {
  let stat: import('fs').Stats;
  try {
    stat = await fsp.stat(versionPath);
  } catch (err) {
    throw new Error(
      `${commandName}: index version directory not found: ${versionPath} (${(err as Error).message})`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`${commandName}: expected a directory at ${versionPath}, found a file`);
  }
  for (const name of ['faiss.index', 'docstore.json']) {
    try {
      await fsp.access(path.join(versionPath, name));
    } catch {
      throw new Error(
        `${commandName}: ${versionPath} is not a complete FAISS version dir (missing ${name})`,
      );
    }
  }
}

export async function runDiffIndex(opts: DiffIndexOptions): Promise<DiffIndexReport> {
  if (!Number.isInteger(opts.topK) || opts.topK <= 0) {
    throw new Error(`kb diff-index: invalid topK ${opts.topK}`);
  }
  if (!Number.isFinite(opts.threshold)) {
    throw new Error(`kb diff-index: invalid threshold ${opts.threshold}`);
  }
  if (opts.queries.length === 0) {
    throw new Error('kb diff-index: at least one query is required');
  }

  await assertIndexVersionDir(opts.before);
  await assertIndexVersionDir(opts.after);

  await opts.manager.loadFromVersionDir(opts.before);
  const beforeResults = await queryAll(opts);

  await opts.manager.loadFromVersionDir(opts.after);
  const afterResults = await queryAll(opts);

  const queries = opts.queries.map((querySpec, index): DiffIndexQueryReport => {
    const beforeTopK = toRankedChunks(beforeResults[index], opts.topK);
    const afterTopK = toRankedChunks(afterResults[index], opts.topK);
    const stabilityScore = kendallStability(beforeTopK, afterTopK);
    return {
      ...(querySpec.name !== undefined ? { name: querySpec.name } : {}),
      query: querySpec.query,
      ...(querySpec.kb !== undefined ? { kb: querySpec.kb } : {}),
      before_top_k: beforeTopK,
      after_top_k: afterTopK,
      rank_deltas: diffRankedChunks(beforeTopK, afterTopK, opts.topK),
      stability_score: stabilityScore,
      churn_score: 1 - stabilityScore,
      top1_changed: beforeTopK[0]?.chunk_id !== afterTopK[0]?.chunk_id,
    };
  });

  return {
    schema_version: 'kb.diff-index.v1',
    before_path: opts.before,
    after_path: opts.after,
    top_k: opts.topK,
    threshold: opts.threshold,
    query_count: queries.length,
    queries,
    summary: summarize(queries),
  };
}

async function queryAll(opts: DiffIndexOptions): Promise<ScoredDocument[][]> {
  const out: ScoredDocument[][] = [];
  for (const querySpec of opts.queries) {
    const results = await opts.manager.similaritySearch(
      querySpec.query,
      opts.topK,
      opts.threshold,
      querySpec.kb,
    );
    out.push(results);
  }
  return out;
}

function toRankedChunks(results: readonly ScoredDocument[], topK: number): DiffIndexRankedChunk[] {
  return results.slice(0, topK).map((result, index) => {
    const metadata = recordMetadata(result.metadata);
    const chunkIndex = numberField(metadata.chunkIndex);
    const relativePath = stringField(metadata.relativePath);
    const source = stringField(metadata.source) ?? relativePath ?? '<unknown>';
    const knowledgeBase = stringField(metadata.knowledgeBase);
    return {
      chunk_id: chunkIdFromMetadata(metadata),
      rank: index + 1,
      score: scoreOf(result),
      source,
      ...(relativePath !== undefined ? { relative_path: relativePath } : {}),
      ...(knowledgeBase !== undefined ? { knowledge_base: knowledgeBase } : {}),
      ...(chunkIndex !== undefined ? { chunk_index: chunkIndex } : {}),
    };
  });
}

function diffRankedChunks(
  before: readonly DiffIndexRankedChunk[],
  after: readonly DiffIndexRankedChunk[],
  topK: number,
): DiffIndexRankDelta[] {
  const beforeById = new Map(before.map((chunk) => [chunk.chunk_id, chunk]));
  const afterById = new Map(after.map((chunk) => [chunk.chunk_id, chunk]));
  const ids = new Set<string>([...beforeById.keys(), ...afterById.keys()]);
  const deltas = [...ids].map((id): DiffIndexRankDelta => {
    const beforeChunk = beforeById.get(id);
    const afterChunk = afterById.get(id);
    const beforeRank = beforeChunk?.rank ?? null;
    const afterRank = afterChunk?.rank ?? null;
    const effectiveBeforeRank = beforeRank ?? topK + 1;
    const effectiveAfterRank = afterRank ?? topK + 1;
    const rankDelta = beforeRank !== null && afterRank !== null
      ? afterRank - beforeRank
      : null;
    const absoluteRankDelta = Math.abs(effectiveAfterRank - effectiveBeforeRank);
    const source = afterChunk?.source ?? beforeChunk?.source ?? '<unknown>';
    return {
      chunk_id: id,
      source,
      before_rank: beforeRank,
      after_rank: afterRank,
      rank_delta: rankDelta,
      absolute_rank_delta: absoluteRankDelta,
      percent_rank_delta: absoluteRankDelta / topK,
      status: deltaStatus(beforeRank, afterRank),
    };
  });
  deltas.sort((a, b) => {
    const byDelta = b.absolute_rank_delta - a.absolute_rank_delta;
    if (byDelta !== 0) return byDelta;
    return a.source.localeCompare(b.source);
  });
  return deltas;
}

function deltaStatus(
  beforeRank: number | null,
  afterRank: number | null,
): DiffIndexRankDelta['status'] {
  if (beforeRank === null) return 'new';
  if (afterRank === null) return 'dropped';
  if (beforeRank === afterRank) return 'stable';
  return 'moved';
}

function kendallStability(
  before: readonly DiffIndexRankedChunk[],
  after: readonly DiffIndexRankedChunk[],
): number {
  const ids = [...new Set([...before.map((chunk) => chunk.chunk_id), ...after.map((chunk) => chunk.chunk_id)])];
  if (ids.length < 2) return 1;
  const beforeRanks = new Map(before.map((chunk) => [chunk.chunk_id, chunk.rank]));
  const afterRanks = new Map(after.map((chunk) => [chunk.chunk_id, chunk.rank]));
  let comparablePairs = 0;
  let discordantPairs = 0;
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const beforeOrder = compareOrder(ids[i], ids[j], beforeRanks);
      const afterOrder = compareOrder(ids[i], ids[j], afterRanks);
      if (beforeOrder === 0 || afterOrder === 0) continue;
      comparablePairs += 1;
      if (beforeOrder !== afterOrder) discordantPairs += 1;
    }
  }
  if (comparablePairs === 0) return 1;
  return 1 - discordantPairs / comparablePairs;
}

function compareOrder(a: string, b: string, ranks: ReadonlyMap<string, number>): -1 | 0 | 1 {
  const rankA = ranks.get(a);
  const rankB = ranks.get(b);
  if (rankA === undefined && rankB === undefined) return 0;
  if (rankA === undefined) return 1;
  if (rankB === undefined) return -1;
  if (rankA === rankB) return 0;
  return rankA < rankB ? -1 : 1;
}

function summarize(queries: readonly DiffIndexQueryReport[]): DiffIndexReport['summary'] {
  if (queries.length === 0) {
    return {
      mean_stability_score: 1,
      mean_churn_score: 0,
      stable_queries: 0,
      moved_queries: 0,
      top1_changed_queries: 0,
      mean_new_chunks: 0,
      mean_dropped_chunks: 0,
      by_kb: {},
    };
  }

  let stabilityTotal = 0;
  let churnTotal = 0;
  let stableQueries = 0;
  let top1ChangedQueries = 0;
  let newChunks = 0;
  let droppedChunks = 0;
  const byKbRows = new Map<string, DiffIndexQueryReport[]>();
  for (const query of queries) {
    stabilityTotal += query.stability_score;
    churnTotal += query.churn_score;
    if (query.churn_score === 0) stableQueries += 1;
    if (query.top1_changed) top1ChangedQueries += 1;
    newChunks += query.rank_deltas.filter((delta) => delta.status === 'new').length;
    droppedChunks += query.rank_deltas.filter((delta) => delta.status === 'dropped').length;
    const kb = query.kb ?? 'ALL';
    byKbRows.set(kb, [...(byKbRows.get(kb) ?? []), query]);
  }

  const byKb: Record<string, DiffIndexKbSummary> = {};
  for (const [kb, rows] of byKbRows) {
    byKb[kb] = {
      queries: rows.length,
      mean_stability_score: mean(rows.map((row) => row.stability_score)),
      mean_churn_score: mean(rows.map((row) => row.churn_score)),
    };
  }

  return {
    mean_stability_score: stabilityTotal / queries.length,
    mean_churn_score: churnTotal / queries.length,
    stable_queries: stableQueries,
    moved_queries: queries.length - stableQueries,
    top1_changed_queries: top1ChangedQueries,
    mean_new_chunks: newChunks / queries.length,
    mean_dropped_chunks: droppedChunks / queries.length,
    by_kb: byKb,
  };
}

export function formatDiffIndexMarkdown(report: DiffIndexReport): string {
  const lines: string[] = [];
  lines.push('# kb diff-index');
  lines.push('');
  lines.push(`- Before: \`${report.before_path}\``);
  lines.push(`- After: \`${report.after_path}\``);
  lines.push(`- Queries: ${report.query_count}`);
  lines.push(`- Top-K: ${report.top_k}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('| --- | ---: |');
  lines.push(`| Mean stability score | ${formatNumber(report.summary.mean_stability_score)} |`);
  lines.push(`| Mean churn score | ${formatNumber(report.summary.mean_churn_score)} |`);
  lines.push(`| Stable queries | ${report.summary.stable_queries} / ${report.query_count} |`);
  lines.push(`| Top-1 changed | ${report.summary.top1_changed_queries} / ${report.query_count} |`);
  lines.push(`| New chunks per query | ${formatNumber(report.summary.mean_new_chunks)} |`);
  lines.push(`| Dropped chunks per query | ${formatNumber(report.summary.mean_dropped_chunks)} |`);
  lines.push('');
  lines.push('## Per query');
  lines.push('');
  for (const query of report.queries) {
    lines.push(`### ${query.name ?? query.query}`);
    lines.push(`- Query: \`${query.query}\`${query.kb !== undefined ? ` (kb=${query.kb})` : ''}`);
    lines.push(`- Stability: ${formatNumber(query.stability_score)} (churn ${formatNumber(query.churn_score)})`);
    lines.push(`- Top-1 changed: ${query.top1_changed ? 'yes' : 'no'}`);
    const changed = query.rank_deltas.filter((delta) => delta.status !== 'stable').slice(0, 10);
    if (changed.length === 0) {
      lines.push('- Rank changes: none');
    } else {
      lines.push('');
      lines.push('| status | before | after | delta | source |');
      lines.push('| --- | ---: | ---: | ---: | --- |');
      for (const delta of changed) {
        lines.push(
          `| ${delta.status} | ${formatRank(delta.before_rank)} | ${formatRank(delta.after_rank)} | ${formatDelta(delta.rank_delta)} | \`${delta.source}\` |`,
        );
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatRank(rank: number | null): string {
  return rank === null ? '-' : String(rank);
}

function formatDelta(delta: number | null): string {
  if (delta === null) return '-';
  return delta > 0 ? `+${delta}` : String(delta);
}

function formatNumber(value: number): string {
  return value.toFixed(4);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function recordMetadata(metadata: unknown): Record<string, unknown> {
  return metadata !== null && typeof metadata === 'object'
    ? metadata as Record<string, unknown>
    : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function scoreOf(result: ScoredDocument): number | null {
  if (typeof result.score === 'number' && Number.isFinite(result.score)) return result.score;
  const metadata = recordMetadata(result.metadata);
  return numberField(metadata.score) ?? null;
}
