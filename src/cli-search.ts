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
  };
  for (const raw of rest) {
    if (raw === '--refresh') { out.refresh = true; continue; }
    if (raw === '--stdin')   { out.stdin = true; continue; }
    if (raw === '--group-by-source') { out.groupBySource = true; continue; }
    if (raw.startsWith('--kb=')) { out.kb = raw.slice('--kb='.length); continue; }
    if (raw.startsWith('--model=')) { out.model = raw.slice('--model='.length); continue; }
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
