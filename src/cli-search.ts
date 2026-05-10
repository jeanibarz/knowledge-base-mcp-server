import * as fsp from 'fs/promises';
import * as path from 'path';
import { FaissIndexManager } from './FaissIndexManager.js';
import {
  resolveActiveModel,
  resolveFaissIndexBinaryPath,
} from './active-model.js';
import {
  classifyKbSearchError,
  exitCodeForFailure,
  formatKbSearchFailureJson,
  formatKbSearchFailureStderr,
  type SearchFailure,
} from './cli-search-errors.js';
import {
  FRONTMATTER_EXTRAS_WIRE_VISIBLE,
  KNOWLEDGE_BASES_ROOT_DIR,
} from './config.js';
import {
  formatRetrievalAsJson,
  formatRetrievalAsMarkdown,
  formatRetrievalGroupedBySourceAsMarkdown,
  groupRetrievalBySource,
} from './formatter.js';
import { enumerateIngestableKbFiles, listKnowledgeBases } from './kb-fs.js';
import { withWriteLock } from './write-lock.js';
import { loadManagerForModel, loadWithJsonRetry } from './cli-shared.js';
import { LexicalIndex, type LexicalSearchResult } from './lexical-index.js';
import { chunkIdFromMetadata, reciprocalRankFusion, type RankedList } from './rrf.js';

export const SEARCH_HELP = `kb search — semantic search across knowledge bases

Usage:
  kb search <query> [options]
  kb search --stdin [options]
  kb search <query> --refresh [options]

Default is dense (FAISS) similarity search, read-only. \`--refresh\` re-scans
KB files under a per-model write lock before searching. \`--mode=lexical\`
runs a BM25 debug surface; \`--mode=hybrid\` fuses dense + lexical via RRF.

Output ends with a freshness footer (markdown) or staleness fields (JSON)
indicating whether the index is up-to-date relative to KB file mtimes.

Scope:
  --kb=<name>           Scope to one knowledge base. Omit to search ALL KBs.
  --model=<id>          Override the active model for this call (RFC 013).

Result tuning:
  --threshold=<float>   Max similarity score; lower = closer match (default 2).
  --threshold=auto      Pick a knee-based cutoff from the top-K score curve.
  --k=<int>             Top-K results (default 10).
  --mode=dense|lexical|hybrid
                        Retrieval mode (default: dense). \`hybrid\` fuses
                        dense + BM25 via reciprocal rank fusion (#206).

Output:
  --format=md|json      Output format (default: md).
  --group-by-source     Collapse repeated chunks from the same source file
                        in markdown output. With \`--format=json\`, adds a
                        \`grouped_results\` field alongside raw results.

Indexing:
  --refresh             Re-scan KB files; acquires the per-model write lock.

Input:
  --stdin               Read query from stdin (multi-line safe).
  --help, -h            Show this help.

Examples:
  kb search "rollback procedure"
  kb search "deploy" --kb=work --k=5
  kb search "INDEX_NOT_INITIALIZED" --mode=lexical --refresh
  kb search "INDEX_NOT_INITIALIZED" --mode=hybrid
  kb search --stdin --format=json < query.txt
`;

export type SearchMode = 'dense' | 'lexical' | 'hybrid';

interface SearchArgs {
  query: string | null;
  kb?: string;
  model?: string;
  threshold?: number;
  thresholdAuto: boolean;
  k: number;
  format: 'md' | 'json';
  refresh: boolean;
  stdin: boolean;
  groupBySource: boolean;
  mode: SearchMode;
}

export interface Staleness {
  indexMtime: string | null;
  modifiedFiles: number;
  newFiles: number;
  scope?: StalenessScope;
  global?: StalenessCounts;
}

export interface StalenessCounts {
  modifiedFiles: number;
  newFiles: number;
}

export interface StalenessScope extends StalenessCounts {
  kb: string;
}

export interface AutoThresholdDecision {
  threshold: number;
  kneeIndex: number | null;
  kept: number;
}

export async function runSearch(rest: string[]): Promise<number> {
  let parsed: SearchArgs;
  try {
    parsed = parseSearchArgs(rest);
  } catch (err) {
    process.stderr.write(`kb search: ${(err as Error).message}\n`);
    return 2;
  }

  if (parsed.stdin && parsed.query === null) {
    parsed.query = await readAllStdin();
    if (parsed.query.trim() === '') {
      process.stderr.write('kb search: empty query from stdin\n');
      return 2;
    }
  } else if (parsed.query === null) {
    process.stderr.write('kb search: missing <query> (or use --stdin)\n');
    return 2;
  }

  if (parsed.mode === 'lexical') {
    return runLexicalSearch(parsed);
  }
  if (parsed.mode === 'hybrid') {
    return runHybridSearch(parsed);
  }

  try {
    await FaissIndexManager.bootstrapLayout();
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }

  let activeModelId: string;
  try {
    activeModelId = await resolveActiveModel({ explicitOverride: parsed.model });
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }

  let manager: FaissIndexManager;
  try {
    manager = await loadManagerForModel(activeModelId);
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }

  try {
    if (parsed.refresh) {
      await withWriteLock(manager.modelDir, async () => {
        await manager.initialize();
        await manager.updateIndex(parsed.kb);
      });
    } else {
      await loadWithJsonRetry(manager);
    }
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }

  let results;
  let autoDecision: AutoThresholdDecision | null = null;
  try {
    if (parsed.thresholdAuto) {
      const rawResults = await manager.similaritySearch(
        parsed.query,
        parsed.k,
        Number.POSITIVE_INFINITY,
        parsed.kb,
      );
      autoDecision = computeAutoThreshold(rawResults.map((r) => r.score));
      results = rawResults.slice(0, autoDecision.kept);
    } else {
      results = await manager.similaritySearch(
        parsed.query,
        parsed.k,
        parsed.threshold,
        parsed.kb,
      );
    }
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }

  const staleness = await computeStaleness(activeModelId, parsed.kb);

  if (parsed.format === 'json') {
    const body = formatRetrievalAsJson(results, FRONTMATTER_EXTRAS_WIRE_VISIBLE);
    const effectiveCounts = parsed.refresh
      ? { modifiedFiles: 0, newFiles: 0 }
      : { modifiedFiles: staleness.modifiedFiles, newFiles: staleness.newFiles };
    const globalCounts = staleness.global ?? {
      modifiedFiles: staleness.modifiedFiles,
      newFiles: staleness.newFiles,
    };
    const scopedCounts = staleness.scope
      ? {
          modifiedFiles: parsed.refresh ? 0 : staleness.scope.modifiedFiles,
          newFiles: parsed.refresh ? 0 : staleness.scope.newFiles,
        }
      : null;
    const globalCountsForPayload = parsed.refresh && !parsed.kb
      ? { modifiedFiles: 0, newFiles: 0 }
      : globalCounts;
    const payload = {
      results: body,
      ...(parsed.groupBySource
        ? { grouped_results: groupRetrievalBySource(results, FRONTMATTER_EXTRAS_WIRE_VISIBLE) }
        : {}),
      index_mtime: staleness.indexMtime,
      stale: hasStaleCounts(effectiveCounts),
      modified_files: effectiveCounts.modifiedFiles,
      new_files: effectiveCounts.newFiles,
      global_stale: hasStaleCounts(globalCountsForPayload),
      global_modified_files: globalCountsForPayload.modifiedFiles,
      global_new_files: globalCountsForPayload.newFiles,
      ...(staleness.scope && scopedCounts
        ? {
            scope: {
              kb: staleness.scope.kb,
              stale: hasStaleCounts(scopedCounts),
              modified_files: scopedCounts.modifiedFiles,
              new_files: scopedCounts.newFiles,
            },
          }
        : {}),
      ...(autoDecision !== null
        ? {
            auto_threshold: {
              threshold: autoDecision.threshold,
              knee_index: autoDecision.kneeIndex,
              kept: autoDecision.kept,
            },
          }
        : {}),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    if (autoDecision !== null) {
      process.stdout.write(formatAutoThresholdHeader(autoDecision));
      process.stdout.write('\n\n');
    }
    const md = parsed.groupBySource
      ? formatRetrievalGroupedBySourceAsMarkdown(results, FRONTMATTER_EXTRAS_WIRE_VISIBLE)
      : formatRetrievalAsMarkdown(results, FRONTMATTER_EXTRAS_WIRE_VISIBLE);
    process.stdout.write(md);
    process.stdout.write('\n\n');
    process.stdout.write(formatFreshnessFooter(staleness, parsed.refresh));
    process.stdout.write('\n');
  }

  return 0;
}

function parseSearchArgs(rest: string[]): SearchArgs {
  const out: SearchArgs = {
    query: null,
    k: 10,
    format: 'md',
    refresh: false,
    stdin: false,
    thresholdAuto: false,
    groupBySource: false,
    mode: 'dense',
  };
  for (const raw of rest) {
    if (raw === '--refresh') { out.refresh = true; continue; }
    if (raw === '--stdin')   { out.stdin = true; continue; }
    if (raw === '--group-by-source') { out.groupBySource = true; continue; }
    if (raw.startsWith('--kb=')) { out.kb = raw.slice('--kb='.length); continue; }
    if (raw.startsWith('--model=')) { out.model = raw.slice('--model='.length); continue; }
    if (raw.startsWith('--mode=')) {
      const v = raw.slice('--mode='.length);
      if (v !== 'dense' && v !== 'lexical' && v !== 'hybrid') {
        throw new Error(`invalid --mode: ${raw} (expected 'dense', 'lexical', or 'hybrid')`);
      }
      out.mode = v; continue;
    }
    if (raw.startsWith('--threshold=')) {
      const v = raw.slice('--threshold='.length);
      if (v === 'auto') { out.thresholdAuto = true; continue; }
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`invalid --threshold: ${raw}`);
      out.threshold = n; continue;
    }
    if (raw.startsWith('--k=')) {
      const n = Number(raw.slice('--k='.length));
      if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid --k: ${raw}`);
      out.k = n; continue;
    }
    if (raw.startsWith('--format=')) {
      const v = raw.slice('--format='.length);
      if (v !== 'md' && v !== 'json') throw new Error(`invalid --format: ${raw}`);
      out.format = v; continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    if (out.query === null) { out.query = raw; continue; }
    throw new Error(`unexpected argument: ${raw}`);
  }
  return out;
}

export async function computeStaleness(modelId: string, scopedKb?: string): Promise<Staleness> {
  const binaryPath = await resolveFaissIndexBinaryPath(modelId);
  if (binaryPath === null) {
    return emptyStaleness(null, scopedKb);
  }
  let indexStat;
  try {
    indexStat = await fsp.stat(binaryPath);
  } catch {
    return emptyStaleness(null, scopedKb);
  }
  const indexMtimeMs = indexStat.mtimeMs;
  const indexMtime = new Date(indexMtimeMs).toISOString();

  let kbs: string[];
  try {
    kbs = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
  } catch {
    return emptyStaleness(indexMtime, scopedKb);
  }

  const enumerations = await enumerateIngestableKbFiles(KNOWLEDGE_BASES_ROOT_DIR, kbs);
  const global = await countStaleness(enumerations, indexMtimeMs);
  if (!scopedKb) {
    return { indexMtime, modifiedFiles: global.modifiedFiles, newFiles: global.newFiles };
  }

  const scopedEnumeration = enumerations.filter((entry) => entry.kbName === scopedKb);
  const scopeCounts = await countStaleness(scopedEnumeration, indexMtimeMs);
  return {
    indexMtime,
    modifiedFiles: scopeCounts.modifiedFiles,
    newFiles: scopeCounts.newFiles,
    scope: { kb: scopedKb, ...scopeCounts },
    global,
  };
}

async function countStaleness(
  enumerations: Awaited<ReturnType<typeof enumerateIngestableKbFiles>>,
  indexMtimeMs: number,
): Promise<StalenessCounts> {
  let modifiedFiles = 0;
  let newFiles = 0;
  for (const { kbPath, filePaths } of enumerations) {
    for (const filePath of filePaths) {
      try {
        const st = await fsp.stat(filePath);
        if (st.mtimeMs > indexMtimeMs) modifiedFiles += 1;
      } catch {
        // file vanished between the walker and stat; ignore it
      }
    }

    const sidecarCount = await countSidecarFiles(path.join(kbPath, '.index'));
    if (filePaths.length > sidecarCount) {
      newFiles += filePaths.length - sidecarCount;
    }
  }
  return { modifiedFiles, newFiles };
}

async function countSidecarFiles(dir: string): Promise<number> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += await countSidecarFiles(entryPath);
    } else if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}

function emptyStaleness(indexMtime: string | null, scopedKb?: string): Staleness {
  if (!scopedKb) return { indexMtime, modifiedFiles: 0, newFiles: 0 };
  return {
    indexMtime,
    modifiedFiles: 0,
    newFiles: 0,
    scope: { kb: scopedKb, modifiedFiles: 0, newFiles: 0 },
    global: { modifiedFiles: 0, newFiles: 0 },
  };
}

export function formatFreshnessFooter(s: Staleness, refreshed: boolean): string {
  if (s.indexMtime === null) {
    return `> _Index not yet built. Run \`kb search --refresh\` to create it._`;
  }
  if (s.scope) {
    return formatScopedFreshnessFooter(s, refreshed);
  }
  if (refreshed) {
    return `> _Index refreshed at ${s.indexMtime}._`;
  }
  if (s.modifiedFiles === 0 && s.newFiles === 0) {
    return `> _Index up-to-date as of ${s.indexMtime}._`;
  }
  if (s.modifiedFiles === 0) {
    return (
      `> _${s.newFiles} new file(s) since ${s.indexMtime}; ` +
      `run \`kb search --refresh\` to include them._`
    );
  }
  return (
    `> _Index may be stale: ${s.modifiedFiles} modified, ${s.newFiles} new ` +
    `file(s) since ${s.indexMtime}. Run \`kb search --refresh\` to update._`
  );
}

function formatScopedFreshnessFooter(s: Staleness, refreshed: boolean): string {
  const scope = s.scope!;
  const global = s.global ?? { modifiedFiles: s.modifiedFiles, newFiles: s.newFiles };
  const globalText = `${global.modifiedFiles} modified, ${global.newFiles} new file(s)`;
  if (refreshed) {
    if (global.modifiedFiles === 0 && global.newFiles === 0) {
      return `> _Index refreshed for KB "${scope.kb}" at ${s.indexMtime}; global index drift is also 0 modified, 0 new file(s)._`;
    }
    return `> _Index refreshed for KB "${scope.kb}" at ${s.indexMtime}. Global index drift outside this scope: ${globalText}._`;
  }
  if (scope.modifiedFiles === 0 && scope.newFiles === 0) {
    if (global.modifiedFiles === 0 && global.newFiles === 0) {
      return `> _Index up-to-date for KB "${scope.kb}" as of ${s.indexMtime}; global index drift is also 0 modified, 0 new file(s)._`;
    }
    return `> _Index up-to-date for KB "${scope.kb}" as of ${s.indexMtime}. Global index drift outside this scope: ${globalText}._`;
  }
  return (
    `> _Index may be stale for KB "${scope.kb}": ${scope.modifiedFiles} modified, ${scope.newFiles} new ` +
    `file(s) since ${s.indexMtime}. Run \`kb search --kb=${scope.kb} --refresh\` to update this scope. ` +
    `Global index drift: ${globalText}._`
  );
}

function hasStaleCounts(counts: StalenessCounts): boolean {
  return counts.modifiedFiles + counts.newFiles > 0;
}

function reportFailure(failure: SearchFailure, format: 'md' | 'json'): number {
  if (format === 'json') {
    process.stdout.write(formatKbSearchFailureJson(failure));
  } else {
    process.stderr.write(formatKbSearchFailureStderr(failure));
  }
  return exitCodeForFailure(failure);
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

/**
 * Pick a knee-based distance cutoff from FAISS top-K scores (lower = closer).
 *
 * Scores must already be sorted ascending — FAISS returns them this way.
 * The largest first-difference is the "knee" where relevance falls off; the
 * cutoff is the score at the elbow (the last result kept). When the largest
 * gap is within 10% of the mean gap the distribution is uniform and we keep
 * everything (no clear knee).
 */
export function computeAutoThreshold(scores: readonly number[]): AutoThresholdDecision {
  if (scores.length === 0) {
    return { threshold: 0, kneeIndex: null, kept: 0 };
  }
  if (scores.length === 1) {
    return { threshold: scores[0], kneeIndex: null, kept: 1 };
  }

  let sumDiff = 0;
  let maxDiff = -Infinity;
  let maxIdx = 0;
  for (let i = 0; i < scores.length - 1; i += 1) {
    const d = scores[i + 1] - scores[i];
    sumDiff += d;
    if (d > maxDiff) {
      maxDiff = d;
      maxIdx = i;
    }
  }
  const meanDiff = sumDiff / (scores.length - 1);

  if (maxDiff <= meanDiff * 1.1) {
    return {
      threshold: scores[scores.length - 1],
      kneeIndex: null,
      kept: scores.length,
    };
  }

  return {
    threshold: scores[maxIdx],
    kneeIndex: maxIdx,
    kept: maxIdx + 1,
  };
}

export function formatAutoThresholdHeader(d: AutoThresholdDecision): string {
  if (d.kept === 0) {
    return '> _Auto-threshold: no results to score._';
  }
  const t = d.threshold.toFixed(2);
  if (d.kneeIndex === null) {
    if (d.kept === 1) {
      return `> _Auto-threshold: ${t} (1 result; no knee detection)._`;
    }
    return `> _Auto-threshold: ${t} (no clear knee; kept all ${d.kept} results)._`;
  }
  return `> _Auto-threshold: ${t} (knee at result ${d.kneeIndex + 1}; kept ${d.kept})._`;
}

// -- #206 stage 1 — lexical search dispatch ----------------------------------

interface LexicalKbResult {
  kbName: string;
  kbPath: string;
  refreshSummary: { added: number; updated: number; removed: number; failed: number; totalFiles: number; totalChunks: number } | null;
  hits: LexicalSearchResult[];
  error?: Error;
}

async function listLexicalKbs(scoped?: string): Promise<Array<{ kbName: string; kbPath: string }>> {
  const all = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
  const filtered = scoped ? all.filter((n) => n === scoped) : all;
  return filtered.map((kbName) => ({
    kbName,
    kbPath: path.join(KNOWLEDGE_BASES_ROOT_DIR, kbName),
  }));
}

async function runLexicalSearch(parsed: SearchArgs): Promise<number> {
  if (parsed.thresholdAuto || parsed.threshold !== undefined) {
    process.stderr.write('kb search: --threshold/--threshold=auto are dense-only; ignored under --mode=lexical\n');
  }
  if (parsed.groupBySource) {
    process.stderr.write('kb search: --group-by-source is dense-only in stage 1; ignored under --mode=lexical\n');
  }

  const query = parsed.query as string;

  let kbs: Array<{ kbName: string; kbPath: string }>;
  try {
    kbs = await listLexicalKbs(parsed.kb);
  } catch (err) {
    process.stderr.write(`kb search (lexical): could not list KBs: ${(err as Error).message}\n`);
    return 1;
  }
  if (parsed.kb && kbs.length === 0) {
    process.stderr.write(`kb search (lexical): KB not found: ${parsed.kb}\n`);
    return 2;
  }

  const perKb: LexicalKbResult[] = [];
  for (const { kbName, kbPath } of kbs) {
    let index: LexicalIndex;
    try {
      index = await LexicalIndex.load(kbName, kbPath);
    } catch (err) {
      perKb.push({ kbName, kbPath, refreshSummary: null, hits: [], error: err as Error });
      continue;
    }

    let refreshSummary: LexicalKbResult['refreshSummary'] = null;
    if (parsed.refresh || index.numFiles() === 0) {
      try {
        refreshSummary = await index.refresh();
        await index.save();
      } catch (err) {
        perKb.push({ kbName, kbPath, refreshSummary: null, hits: [], error: err as Error });
        continue;
      }
    }

    let hits: LexicalSearchResult[];
    try {
      hits = await index.query(query, parsed.k);
    } catch (err) {
      perKb.push({ kbName, kbPath, refreshSummary, hits: [], error: err as Error });
      continue;
    }
    perKb.push({ kbName, kbPath, refreshSummary, hits });
  }

  // Merge across KBs by score (BM25 score is positive; higher is better).
  const merged: LexicalSearchResult[] = [];
  for (const row of perKb) {
    for (const hit of row.hits) {
      merged.push(hit);
    }
  }
  merged.sort((a, b) => b.score - a.score);
  const topK = merged.slice(0, parsed.k);

  const errors = perKb.filter((r) => r.error);
  for (const e of errors) {
    process.stderr.write(`kb search (lexical): ${e.kbName} — ${e.error?.message ?? 'unknown error'}\n`);
  }

  // For format reuse, transform LexicalSearchResult into the dense
  // shape `{...Document, score}` that formatRetrievalAs* expect.
  const formatted = topK.map((h) => {
    const obj: Record<string, unknown> & { pageContent: string; metadata: Record<string, unknown>; score: number } = {
      pageContent: h.pageContent,
      metadata: h.metadata,
      score: h.score,
    };
    return obj;
  });

  if (parsed.format === 'json') {
    const payload = {
      mode: 'lexical' as const,
      results: formatRetrievalAsJson(formatted as never, FRONTMATTER_EXTRAS_WIRE_VISIBLE),
      knowledge_bases: perKb.map((r) => ({
        kb: r.kbName,
        files: r.refreshSummary?.totalFiles ?? null,
        chunks: r.refreshSummary?.totalChunks ?? null,
        refresh: r.refreshSummary
          ? {
              added: r.refreshSummary.added,
              updated: r.refreshSummary.updated,
              removed: r.refreshSummary.removed,
              failed: r.refreshSummary.failed,
            }
          : null,
        error: r.error ? r.error.message : null,
      })),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`> _Mode: lexical (BM25). Stage 1 — debug surface; see #206._\n\n`);
    if (formatted.length === 0) {
      process.stdout.write(`_No matches._\n\n`);
    } else {
      process.stdout.write(formatRetrievalAsMarkdown(formatted as never, FRONTMATTER_EXTRAS_WIRE_VISIBLE));
      process.stdout.write('\n\n');
    }
    const summaryLines = perKb.map((r) => {
      if (r.error) return `- ${r.kbName}: error — ${r.error.message}`;
      const f = r.refreshSummary;
      const counts = f
        ? `${f.totalFiles} file(s), ${f.totalChunks} chunk(s)` +
          (f.added || f.updated || f.removed || f.failed
            ? ` (refresh: +${f.added}/~${f.updated}/-${f.removed}, ${f.failed} failed)`
            : '')
        : '(no refresh this run)';
      return `- ${r.kbName}: ${counts}`;
    });
    process.stdout.write(`> _Lexical index status:_\n${summaryLines.join('\n')}\n`);
  }

  return errors.length > 0 ? 1 : 0;
}

// -- #206 stage 2 — hybrid (RRF) dispatch ----------------------------------

const HYBRID_FETCH_MULTIPLIER = 4;
const HYBRID_RRF_C = 60;

interface HybridChunk {
  pageContent: string;
  metadata: Record<string, unknown>;
  score: number;
}

async function runHybridSearch(parsed: SearchArgs): Promise<number> {
  if (parsed.thresholdAuto || parsed.threshold !== undefined) {
    process.stderr.write('kb search: --threshold/--threshold=auto are dense-only; ignored under --mode=hybrid\n');
  }
  if (parsed.groupBySource) {
    process.stderr.write('kb search: --group-by-source is dense-only in stage 2; ignored under --mode=hybrid\n');
  }

  const query = parsed.query as string;
  const fetchK = Math.max(parsed.k * HYBRID_FETCH_MULTIPLIER, parsed.k);

  // -- dense leg -----------------------------------------------------------
  let densePromise: Promise<HybridChunk[]>;
  let denseError: Error | null = null;
  let activeModelId: string | null = null;
  try {
    await FaissIndexManager.bootstrapLayout();
    activeModelId = await resolveActiveModel({ explicitOverride: parsed.model });
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }
  let manager: FaissIndexManager;
  try {
    manager = await loadManagerForModel(activeModelId);
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }
  try {
    if (parsed.refresh) {
      await withWriteLock(manager.modelDir, async () => {
        await manager.initialize();
        await manager.updateIndex(parsed.kb);
      });
    } else {
      await loadWithJsonRetry(manager);
    }
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }
  densePromise = manager
    .similaritySearch(query, fetchK, Number.POSITIVE_INFINITY, parsed.kb)
    .then((rs) => rs.map((r) => ({ pageContent: r.pageContent, metadata: r.metadata, score: r.score })))
    .catch((err) => {
      denseError = err as Error;
      return [];
    });

  // -- lexical leg ---------------------------------------------------------
  let lexicalKbs: Array<{ kbName: string; kbPath: string }>;
  try {
    lexicalKbs = await listLexicalKbs(parsed.kb);
  } catch (err) {
    process.stderr.write(`kb search (hybrid): could not list KBs: ${(err as Error).message}\n`);
    return 1;
  }

  const lexicalPromise: Promise<{ hits: HybridChunk[]; refreshed: number; failed: number }> = (async () => {
    let refreshed = 0;
    let failed = 0;
    const all: LexicalSearchResult[] = [];
    for (const { kbName, kbPath } of lexicalKbs) {
      try {
        const idx = await LexicalIndex.load(kbName, kbPath);
        if (parsed.refresh || idx.numFiles() === 0) {
          await idx.refresh();
          await idx.save();
          refreshed += 1;
        }
        const hits = await idx.query(query, fetchK);
        for (const h of hits) all.push(h);
      } catch (err) {
        failed += 1;
        process.stderr.write(`kb search (hybrid lexical leg): ${kbName} — ${(err as Error).message}\n`);
      }
    }
    all.sort((a, b) => b.score - a.score);
    const top = all.slice(0, fetchK);
    return {
      hits: top.map((h) => ({ pageContent: h.pageContent, metadata: h.metadata, score: h.score })),
      refreshed,
      failed,
    };
  })();

  const [denseResults, lexicalResultsRow] = await Promise.all([densePromise, lexicalPromise]);
  if (denseError) {
    return reportFailure(classifyKbSearchError(denseError), parsed.format);
  }
  const lexicalResults = lexicalResultsRow.hits;

  // -- fuse ----------------------------------------------------------------
  const denseList: RankedList = {
    retriever: 'dense',
    results: denseResults.map((r, i) => ({ id: chunkIdFromMetadata(r.metadata), rank: i + 1 })),
  };
  const lexicalList: RankedList = {
    retriever: 'lexical',
    results: lexicalResults.map((r, i) => ({ id: chunkIdFromMetadata(r.metadata), rank: i + 1 })),
  };
  const fused = reciprocalRankFusion([denseList, lexicalList], { c: HYBRID_RRF_C });

  // Index chunks by id for output. When both legs return the same id, prefer
  // the dense entry (more complete metadata typically), but read from
  // whichever exists.
  const byId = new Map<string, HybridChunk>();
  for (const r of lexicalResults) byId.set(chunkIdFromMetadata(r.metadata), r);
  for (const r of denseResults) byId.set(chunkIdFromMetadata(r.metadata), r);
  const ranked = fused.slice(0, parsed.k).map((f) => {
    const chunk = byId.get(f.id);
    return chunk ? { ...chunk, score: f.fusedScore } : null;
  }).filter((x): x is HybridChunk => x !== null);

  if (parsed.format === 'json') {
    const payload = {
      mode: 'hybrid' as const,
      results: formatRetrievalAsJson(ranked as never, FRONTMATTER_EXTRAS_WIRE_VISIBLE),
      retrievers: {
        dense: { fetched: denseResults.length, model: activeModelId },
        lexical: { fetched: lexicalResults.length, refreshed: lexicalResultsRow.refreshed, failed: lexicalResultsRow.failed },
      },
      rrf: { c: HYBRID_RRF_C, fetch_k: fetchK },
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`> _Mode: hybrid (RRF c=${HYBRID_RRF_C}). Stage 2 — dense ⨁ lexical; see #206._\n\n`);
    if (ranked.length === 0) {
      process.stdout.write(`_No matches._\n\n`);
    } else {
      process.stdout.write(formatRetrievalAsMarkdown(ranked as never, FRONTMATTER_EXTRAS_WIRE_VISIBLE));
      process.stdout.write('\n\n');
    }
    process.stdout.write(
      `> _Hybrid status: dense fetched ${denseResults.length}, lexical fetched ${lexicalResults.length} (refreshed ${lexicalResultsRow.refreshed}, ${lexicalResultsRow.failed} failed); fused via RRF (c=${HYBRID_RRF_C}, fetch_k=${fetchK})._\n`,
    );
  }

  return 0;
}
