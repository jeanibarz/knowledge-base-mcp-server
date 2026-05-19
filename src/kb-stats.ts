// kb-stats.ts — read-only observability surface for the kb_stats MCP tool
// (#54) and a future `kb stats` CLI (#157).
//
// Pure data computation: takes a `FaissIndexManager` and the on-disk KB
// layout, returns a structured payload. Knows nothing about MCP wire
// shape — the caller wraps the result. The MCP handler in
// `KnowledgeBaseServer.handleKbStats` and a future CLI subcommand both
// consume `computeKbStats`.

import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  GENERATOR_VERSION as CONTEXTUAL_PREFACE_GENERATOR,
  sidecarRootDir as contextualPrefaceRoot,
} from './contextual-preface.js';
import { isContextualRetrievalEnabled } from './config/contextual-preface.js';
import { FaissIndexManager, type IndexUpdateSummary } from './FaissIndexManager.js';
import {
  FAISS_INDEX_PATH,
  KNOWLEDGE_BASES_ROOT_DIR,
} from './config/paths.js';
import {
  INGEST_EXCLUDE_PATHS,
  INGEST_EXTRA_EXTENSIONS,
} from './config/ingest.js';
import { mapBounded, resolveFsConcurrency } from './bounded-concurrency.js';
import { KBError } from './errors.js';
import { enumerateIngestableKbFiles, listKnowledgeBases } from './kb-fs.js';
import { logger } from './logger.js';
import {
  providerCallMetrics,
  type ProviderCallMetrics,
  type ProviderCallSnapshot,
} from './metrics.js';
import { countIngestQuarantine } from './ingest-quarantine.js';
import { queryEmbeddingCache, type QueryCacheStats } from './query-cache.js';
import {
  relevanceGateMetrics,
  type RelevanceGateMetricsSnapshot,
} from './relevance-gate-metrics.js';

export interface KbStatsRow {
  file_count: number;
  chunk_count: number;
  total_bytes_indexed: number;
  last_updated_at: string | null;
  /**
   * RFC 017 — contextual-retrieval observability. Present (with
   * `enabled: false`) when KB_CONTEXTUAL_RETRIEVAL is off; populated with
   * coverage counts when it's on. Additive on the wire: clients that
   * predate RFC 017 ignore the field; clients that know about it can
   * report coverage_pct, null_preface_chunks, and the reindex state.
   */
  contextual_preface?: KbStatsContextualPrefaceBlock;
}

export interface KbStatsContextualPrefaceBlock {
  enabled: boolean;
  reindex_state: 'never' | 'in_progress' | 'completed' | 'partial' | 'failed' | 'stale';
  last_completed_at: string | null;
  covered_chunks: number;
  null_preface_chunks: number;
  coverage_pct: number;
  cache_bytes: number;
  model: string | null;
  generator: string | null;
}

export interface KbStatsPayload {
  knowledge_bases: Record<string, KbStatsRow>;
  quarantined: Record<string, number>;
  embedding: { provider: string; model: string; dim: number | null };
  index_path: string;
  last_index_update: IndexUpdateSummary;
  server: { version: string; uptime_ms: number };
  /**
   * Issue #210 — per-`model_id` runtime histograms for the active
   * embedding provider's `embedQuery` / `embedDocuments` calls. Empty
   * `{}` until the active provider has served at least one call;
   * additive on the wire, so older clients that do not know about
   * `provider_calls` keep working.
   */
  provider_calls: Record<string, ProviderCallSnapshot>;
  query_cache: QueryCacheStats;
  relevance_gate: RelevanceGateMetricsSnapshot;
}

export interface ComputeKbStatsOptions {
  /** Restrict to a single KB. Throws `KBError('KB_NOT_FOUND')` if unregistered. */
  knowledgeBaseName?: string;
  /** Server version string surfaced under `server.version`. */
  serverVersion: string;
  /** `Date.now()` baseline used to derive `server.uptime_ms`. */
  startedAt: number;
  /**
   * Issue #210 — test seam for the provider-call telemetry registry.
   * Production callers leave this undefined so the process-wide
   * singleton is read.
   */
  metrics?: ProviderCallMetrics;
}

/**
 * Issue #54 + #157 — compute the kb_stats payload from a manager + the
 * registered KB list on disk. Returns plain data; the MCP handler wraps
 * it as `CallToolResult` and a future `kb stats` CLI prints it directly.
 *
 * Counts reflect whatever is on disk + in the loaded FAISS docstore RIGHT
 * NOW. Read-only — does not acquire the write lock and does not trigger
 * an `updateIndex`.
 *
 * Throws `KBError('KB_NOT_FOUND')` when `options.knowledgeBaseName` is
 * set but the KB is not registered under `KNOWLEDGE_BASES_ROOT_DIR`.
 */
export async function computeKbStats(
  manager: FaissIndexManager,
  options: ComputeKbStatsOptions,
): Promise<KbStatsPayload> {
  const allKbs = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
  let kbsToReport: string[];
  if (options.knowledgeBaseName !== undefined) {
    if (!allKbs.includes(options.knowledgeBaseName)) {
      throw new KBError(
        'KB_NOT_FOUND',
        `Knowledge base "${options.knowledgeBaseName}" not found under ${KNOWLEDGE_BASES_ROOT_DIR}.`,
      );
    }
    kbsToReport = [options.knowledgeBaseName];
  } else {
    kbsToReport = allKbs;
  }

  const indexStats = manager.getStats();

  // Apply the SAME ingest filter the indexer uses, so file_count and
  // total_bytes_indexed reflect what would actually be embedded — not the
  // raw file walk (which still includes excluded extensions and excluded
  // subtrees).
  const enumerations = await enumerateIngestableKbFiles(
    KNOWLEDGE_BASES_ROOT_DIR,
    kbsToReport,
    {
      extraExtensions: INGEST_EXTRA_EXTENSIONS,
      excludePaths: INGEST_EXCLUDE_PATHS,
    },
  );

  const knowledge_bases: Record<string, KbStatsRow> = {};
  const quarantined: Record<string, number> = {};
  const fsConcurrency = resolveFsConcurrency();
  for (const { kbName, kbPath, filePaths } of enumerations) {
    const byteCounts = await mapBounded(filePaths, fsConcurrency, async (filePath) => {
      try {
        const st = await fsp.stat(filePath);
        return st.size;
      } catch (err) {
        // Best-effort: a TOCTOU between the walker and stat (e.g. concurrent
        // edit) shouldn't fail the whole stats call.
        logger.debug(`kb_stats: could not stat ${filePath}: ${(err as Error).message}`);
        return 0;
      }
    });
    const totalBytes = byteCounts.reduce((sum, value) => sum + value, 0);
    const lastUpdatedAt = await maxMtimeIso(path.join(kbPath, '.index'));
    const chunkCount = indexStats.chunkCountsByKb[kbName] ?? 0;
    const contextualPreface = await computeContextualPrefaceBlock(kbName, chunkCount);
    knowledge_bases[kbName] = {
      file_count: filePaths.length,
      chunk_count: chunkCount,
      total_bytes_indexed: totalBytes,
      last_updated_at: lastUpdatedAt,
      contextual_preface: contextualPreface,
    };
    quarantined[kbName] = await countIngestQuarantine(kbPath);
  }

  const metricsSource = options.metrics ?? providerCallMetrics;
  const managerSummary = manager.getLastIndexUpdateSummary();
  const readPersistedSummary = FaissIndexManager.readPersistedIndexUpdateSummary;
  const lastIndexUpdate = managerSummary.status === 'never_run'
    ? (
        typeof readPersistedSummary === 'function'
          ? await readPersistedSummary(manager.modelId)
          : null
      ) ?? managerSummary
    : managerSummary;
  return {
    knowledge_bases,
    quarantined,
    embedding: {
      provider: manager.embeddingProvider,
      model: manager.modelName,
      dim: indexStats.dim,
    },
    index_path: FAISS_INDEX_PATH,
    last_index_update: lastIndexUpdate,
    server: {
      version: options.serverVersion,
      uptime_ms: Date.now() - options.startedAt,
    },
    provider_calls: metricsSource.snapshot(),
    query_cache: await queryEmbeddingCache.stats(),
    relevance_gate: relevanceGateMetrics.snapshot(),
  };
}

/**
 * Issue #54 — recursively walk `dir` for the latest mtime of any file
 * under it. Used by `computeKbStats` to derive `last_updated_at` per KB
 * from sidecar hash files at `<kb>/.index/`: the most recent sidecar
 * mtime is the last time any file in this KB was (re)embedded by the
 * active model. Returns an ISO string with millisecond precision, or
 * null when the directory is missing (KB never indexed) or contains no
 * files.
 */
export async function maxMtimeIso(dir: string): Promise<string | null> {
  let latest = 0;
  async function walk(target: string): Promise<void> {
    let entries: Array<import('fs').Dirent>;
    try {
      entries = await fsp.readdir(target, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw err;
    }
    const mtimes = await mapBounded(entries, resolveFsConcurrency(), async (entry) => {
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        return 0;
      }
      if (!entry.isFile()) return 0;
      try {
        const st = await fsp.stat(child);
        return st.mtimeMs;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return 0;
        throw err;
      }
    });
    for (const mtime of mtimes) {
      if (mtime > latest) latest = mtime;
    }
  }
  await walk(dir);
  return latest === 0 ? null : new Date(latest).toISOString();
}

/**
 * RFC 017 — compute the `contextual_preface` sub-block for a single KB.
 *
 * M0a scope: no run-level CLI exists yet, so `reindex_state` is derived
 * purely from sidecar presence. The M0b CLI will write a
 * `.reindex.run.json` file under the FAISS index root that distinguishes
 * `in_progress` / `partial` / `stale` from the M0a-visible states.
 *
 * Cheap when no sidecars exist for the KB (the directory's absent → the
 * readdir returns ENOENT → we return the `never` placeholder).
 */
async function computeContextualPrefaceBlock(
  kbName: string,
  totalChunks: number,
): Promise<import('./kb-stats.js').KbStatsContextualPrefaceBlock> {
  const enabled = isContextualRetrievalEnabled();
  const sidecarDir = path.join(contextualPrefaceRoot(), kbName.replace(/[^A-Za-z0-9._-]/g, '_'));
  let dirEntries: Array<import('fs').Dirent> = [];
  try {
    dirEntries = await fsp.readdir(sidecarDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      logger.debug(`kb_stats: contextual sidecar readdir failed for ${sidecarDir}: ${(err as Error).message}`);
    }
    // No sidecars yet → never reindexed.
    return {
      enabled,
      reindex_state: 'never',
      last_completed_at: null,
      covered_chunks: 0,
      null_preface_chunks: 0,
      coverage_pct: 0,
      cache_bytes: 0,
      model: null,
      generator: enabled ? CONTEXTUAL_PREFACE_GENERATOR : null,
    };
  }

  let covered = 0;
  let nulls = 0;
  let cacheBytes = 0;
  let latestMtime = 0;
  let modelSeen: string | null = null;

  for (const entry of dirEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(sidecarDir, entry.name);
    let stat: import('fs').Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      continue;
    }
    cacheBytes += stat.size;
    if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;
    let raw: string;
    try {
      raw = await fsp.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }
    let parsed: { chunks?: Array<{ preface?: unknown }>; model?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed.model === 'string') modelSeen = parsed.model;
    if (!Array.isArray(parsed.chunks)) continue;
    for (const c of parsed.chunks) {
      if (typeof c?.preface === 'string' && c.preface.length > 0) covered += 1;
      else if (c?.preface === null) nulls += 1;
    }
  }

  const coveragePct = totalChunks > 0 ? Math.round((covered / totalChunks) * 1000) / 10 : 0;
  const lastCompletedAt = latestMtime === 0 ? null : new Date(latestMtime).toISOString();
  // M0a: a populated sidecar dir + zero failures + coverage matching the
  // chunk count means a completed run. Without a `.reindex.run.json` file
  // we can't tell `partial` from `failed`; both surface as `completed` if
  // coverage_pct === 100, otherwise as `partial`.
  const reindexState = covered + nulls === 0
    ? 'never'
    : (covered === totalChunks ? 'completed' : 'partial');

  return {
    enabled,
    reindex_state: reindexState,
    last_completed_at: lastCompletedAt,
    covered_chunks: covered,
    null_preface_chunks: nulls,
    coverage_pct: coveragePct,
    cache_bytes: cacheBytes,
    model: modelSeen,
    generator: dirEntries.length > 0 ? CONTEXTUAL_PREFACE_GENERATOR : null,
  };
}
