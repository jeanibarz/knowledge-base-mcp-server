// RFC 017 M0b — orchestration for `kb reindex --with-context`.
//
// The initial contextual backfill is delegated to the existing
// `FaissIndexManager.updateIndex(undefined, { force: true })` path —
// that walks every KB, re-embeds every chunk through the adapter
// (patched by M0a to apply contextual prefaces upstream of the
// embedder), and atomically swaps the FAISS index per RFC 014. Once the
// contextual-preface sidecar cache is warm, follow-up runs delegate to
// the normal incremental `updateIndex()` path so unchanged files do not
// get re-embedded every day. M0b's job is the orchestration around it:
//
//  1. Resolve in-scope KBs (default: every registered KB). Count total
//     chunks from existing chunk manifests and estimate cold-preface plus
//     possible whole-index embedding-rebuild work.
//  2. Refuse to start inside the LRA cron window (06:00-10:30 UTC) or
//     when the estimated runtime would cross it, unless `--force`.
//  3. Check for a peer reindex via `.reindex.run.json` + PID liveness;
//     refuse if alive; clean up the stale file (zombie) otherwise.
//  4. Write `.reindex.run.json` with this process's PID + scope. The
//     trigger watcher consults this file before grabbing the per-model
//     write lock, deferring its update until we finish (M0b §5 step 5).
//  5. Run `updateIndex(undefined, { force })`, where `force` is true
//     only while the contextual-preface estimate still has cold chunks.
//  6. Delete `.reindex.run.json` on success or failure.
//
// What this file does NOT do:
//  - Acquire the per-model write lock directly. `updateIndex` already
//    acquires `withWriteLock(modelDir, ...)` internally per RFC 013.
//    M0b's pre-flight check via `.reindex.run.json` is the *cooperative*
//    coordination signal for the trigger watcher; the strict
//    serialization remains the same lock the watcher already respects.

import * as fsp from 'fs/promises';
import * as path from 'path';

import {
  FAISS_INDEX_PATH,
  KNOWLEDGE_BASES_ROOT_DIR,
} from './config/paths.js';
import { emitCanonicalLog } from './canonical-log.js';
import {
  isContextualRetrievalEnabled,
  type ContextualErrorCode,
} from './config/contextual-preface.js';
import {
  aggregateContextualSidecarStats,
  classifyContextualSidecarChunks,
} from './contextual-preface.js';
import { KBError } from './errors.js';
import { FaissIndexManager, type IndexUpdateSummary } from './FaissIndexManager.js';
import { writeFileAtomicDurable } from './file-utils.js';
import { listKnowledgeBases } from './kb-fs.js';
import { logger } from './logger.js';

// RFC 017 §5 step 1 — cold-case per-chunk cost upper bound. Used by the
// self-runtime estimator. Tuned to 8s based on cold KV-cache miss
// latency observed against Qwen3.6-35B-A3B at the deployed context;
// warm tenancy lands closer to 1-2s but the guard uses the ceiling.
export const REINDEX_PER_CHUNK_ESTIMATE_MS = 8_000;

// A changed file can make the incremental FAISS path rebuild the whole
// index because individual vectors cannot be deleted. Price that possible
// rebuild at the observed steady-state throughput (~30ms/chunk) so a warm
// contextual-preface cache does not reduce a non-trivial run to 0 seconds.
export const REINDEX_EMBEDDING_PER_CHUNK_ESTIMATE_MS = 30;

// RFC 017 §5 step 2 — LRA cron guard window in UTC. Hard-coded rather
// than env-tunable: there is exactly one operator and one downstream
// consumer (the local-research-agent cron), and `--force` is the
// documented escape hatch.
export const REINDEX_GUARD_WINDOW_START_UTC = { hour: 6, minute: 0 };
export const REINDEX_GUARD_WINDOW_END_UTC = { hour: 10, minute: 30 };

// Filename of the run-status file under FAISS_INDEX_PATH.
export const REINDEX_RUN_FILENAME = '.reindex.run.json';
export const REINDEX_RUN_SCHEMA_VERSION = 'reindex-run.v1';

export interface ReindexOptions {
  /**
   * KB names used for the chunk-count estimate and the cron-window guard
   * arithmetic — NOT a scoped rebuild. `updateIndex` is always invoked
   * with an `undefined` (whole-corpus) scope; see `runManagerUpdateIndex`.
   * A partial rebuild would orphan the other shelves' vectors in the
   * single-index-per-model FAISS layout. Empty array means "every
   * registered KB".
   */
  knowledgeBases: readonly string[];
  /**
   * Skip the LRA-cron guard AND the self-runtime-budget guard. Operators
   * pass `--force` from the CLI; tests pass `force: true` directly.
   */
  force: boolean;
  /**
   * Test seam: the manager whose model directory and embeddings will be
   * the target. Production callers omit this and the orchestrator
   * constructs a default manager from env vars.
   */
  manager?: FaissIndexManager;
  /**
   * Test seam: current wall-clock UTC date for guard arithmetic. Used
   * for deterministic boundary tests.
   */
  now?: Date;
  /** Test seam: bypass disk listing for KB resolution. */
  resolveKbs?: () => Promise<string[]>;
  /**
   * Test seam: bypass the actual updateIndex call (which requires a
   * working embedding provider). Returns a synthetic IndexUpdateSummary.
   */
  runUpdateIndex?: (args: { force: boolean }) => Promise<IndexUpdateSummary>;
}

/**
 * RFC 017 §5 step 1 (cache-aware refinement, #408) — breakdown of the
 * contextual-preface work the runtime estimate is built from. `cold_chunks`
 * is the count priced at the 8s cold-LLM ceiling; every `total_chunks` entry
 * is also priced at the embedding rebuild rate because the incremental FAISS
 * path may rebuild the whole index.
 */
export interface ContextualReindexEstimate {
  /** Total chunks across all in-scope KBs, summed from chunk manifests. */
  total_chunks: number;
  /** Chunks with a valid cached preface — no LLM call. */
  cache_hits: number;
  /** Chunks with a recorded failure whose retry-after has not elapsed. */
  retry_skips: number;
  /** Chunks needing a cold LLM call: misses, expired failures, no sidecar. */
  cold_chunks: number;
}

export interface ReindexResult {
  outcome: 'completed' | 'partial' | 'failed' | 'guard_blocked' | 'lock_held';
  kbs_attempted: number;
  total_chunks_estimate: number;
  estimated_seconds: number;
  /** Cache-aware breakdown behind `estimated_seconds` (#408). */
  contextual_estimate: ContextualReindexEstimate;
  took_ms: number;
  reason: string | null;
  summary: IndexUpdateSummary | null;
  /**
   * #409 — post-run contextual-preface diagnostics, aggregated from the
   * sidecars of the in-scope KBs after `updateIndex` finishes. `null` when
   * contextual retrieval is disabled or the run never reached the rebuild
   * (`guard_blocked` / `lock_held` / pre-flight `failed`). Surfacing this
   * keeps preface cache / failure detail out of debug-only logs.
   */
  contextual: ContextualReindexSummary | null;
}

/**
 * #409 — contextual-preface cache / failure counters summed across the
 * in-scope KBs, read back from the sidecars the just-completed reindex
 * persisted. `covered_chunks` are successful prefaces; `null_preface_chunks`
 * failed; `retry_pending_chunks` are the failed subset still inside their
 * per-error backoff (the next reindex skips them).
 */
export interface ContextualReindexSummary {
  kbs: number;
  covered_chunks: number;
  null_preface_chunks: number;
  retry_pending_chunks: number;
  failures_by_error_code: Partial<Record<ContextualErrorCode, number>>;
}

interface RunStateFile {
  schema_version: typeof REINDEX_RUN_SCHEMA_VERSION;
  pid: number;
  started_at: string;
  kbs_in_scope: string[];
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function isInsideGuardWindow(now: Date): boolean {
  const totalMins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const startMins = REINDEX_GUARD_WINDOW_START_UTC.hour * 60 + REINDEX_GUARD_WINDOW_START_UTC.minute;
  const endMins = REINDEX_GUARD_WINDOW_END_UTC.hour * 60 + REINDEX_GUARD_WINDOW_END_UTC.minute;
  return totalMins >= startMins && totalMins < endMins;
}

/**
 * Returns true when an `estimated_seconds`-long run that starts at
 * `now` would still be running when the next LRA cron window opens
 * (06:00 UTC, possibly tomorrow if `now` is already past it).
 */
export function wouldCrossLraWindow(now: Date, estimatedSeconds: number): boolean {
  if (estimatedSeconds <= 0) return false;
  const endMs = now.getTime() + estimatedSeconds * 1_000;

  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    REINDEX_GUARD_WINDOW_START_UTC.hour,
    REINDEX_GUARD_WINDOW_START_UTC.minute,
    0,
    0,
  ));
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return endMs >= next.getTime();
}

// ---------------------------------------------------------------------------
// Run-state file (.reindex.run.json) + PID liveness
// ---------------------------------------------------------------------------

export function runStateFilePath(): string {
  return path.join(FAISS_INDEX_PATH, REINDEX_RUN_FILENAME);
}

async function writeRunState(state: RunStateFile): Promise<void> {
  const target = runStateFilePath();
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await writeFileAtomicDurable(target, JSON.stringify(state, null, 2));
}

async function readRunState(): Promise<RunStateFile | null> {
  try {
    const raw = await fsp.readFile(runStateFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<RunStateFile>;
    if (parsed?.schema_version !== REINDEX_RUN_SCHEMA_VERSION) return null;
    if (typeof parsed.pid !== 'number' || typeof parsed.started_at !== 'string') return null;
    if (!Array.isArray(parsed.kbs_in_scope)) return null;
    return parsed as RunStateFile;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      logger.warn(`RFC 017 M0b: failed to read run-state file: ${(err as Error).message}`);
    }
    return null;
  }
}

async function deleteRunState(): Promise<void> {
  try {
    await fsp.unlink(runStateFilePath());
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      logger.warn(`RFC 017 M0b: failed to remove run-state file: ${(err as Error).message}`);
    }
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // `process.kill(pid, 0)` does not deliver a signal — it returns
    // normally if the PID exists and the caller may signal it, throws
    // ESRCH if absent.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we don't have permission to
    // signal it (e.g. owned by another user). Still alive.
    return code === 'EPERM';
  }
}

/**
 * RFC 017 §5 — read the run-state file and decide whether a reindex is
 * currently active. Cleans up zombie state files (PID is dead) as a
 * side effect; returns `{alive: false, state: null}` after cleanup.
 * Called by both the reindex CLI (refuses to start when alive) and the
 * trigger watcher (defers updateIndex when alive).
 */
export async function checkReindexRunState(): Promise<{
  alive: boolean;
  state: RunStateFile | null;
}> {
  const state = await readRunState();
  if (state === null) return { alive: false, state: null };
  if (isPidAlive(state.pid)) return { alive: true, state };

  emitCanonicalLog({
    process: 'cli',
    cmd: 'reindex.zombie-cleanup',
    took_ms: 0,
    top_sources: [String(state.pid), state.started_at],
  });
  await deleteRunState();
  return { alive: false, state: null };
}

// ---------------------------------------------------------------------------
// KB enumeration / chunk-count estimate
// ---------------------------------------------------------------------------

async function resolveKbsInScope(opts: ReindexOptions): Promise<string[]> {
  if (opts.resolveKbs) return opts.resolveKbs();
  if (opts.knowledgeBases.length > 0) {
    const registered = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
    const missing = opts.knowledgeBases.filter((kb) => !registered.includes(kb));
    if (missing.length > 0) {
      throw new KBError(
        'KB_NOT_FOUND',
        `Unknown knowledge base(s): ${missing.join(', ')}. Run \`kb list\` to see registered KBs.`,
      );
    }
    return [...opts.knowledgeBases];
  }
  return listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
}

/**
 * Approximate the chunk count by reading existing chunk manifests under
 * `<kb>/.index/`. Fast: each manifest is a small JSON file and we only
 * read its `chunks.length`. If no manifest exists (KB never indexed),
 * we contribute 0 — a first-time reindex can't be estimated meaningfully
 * and the operator should pass `--force` or schedule outside the window.
 */
export async function estimateChunkCountForKbs(kbs: readonly string[]): Promise<number> {
  let total = 0;
  for (const kb of kbs) {
    const indexDir = path.join(KNOWLEDGE_BASES_ROOT_DIR, kb, '.index');
    let entries: Array<import('fs').Dirent> = [];
    try {
      entries = await fsp.readdir(indexDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.chunks.json')) continue;
      try {
        const raw = await fsp.readFile(path.join(indexDir, entry.name), 'utf-8');
        const parsed = JSON.parse(raw) as { chunks?: unknown };
        if (Array.isArray(parsed.chunks)) total += parsed.chunks.length;
      } catch {
        // best-effort
      }
    }
  }
  return total;
}

/**
 * Recursively collect every `*.chunks.json` manifest path under a KB's
 * `.index/` directory. The manifest tree mirrors the KB's own directory
 * layout (`FaissIndexManager` writes `<kb>/.index/<rel-dir>/<file>.chunks.json`),
 * so a non-recursive `readdir` would miss manifests for nested sources.
 */
async function collectChunkManifestPaths(indexDir: string): Promise<string[]> {
  let entries: Array<import('fs').Dirent>;
  try {
    entries = await fsp.readdir(indexDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(indexDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectChunkManifestPaths(full)));
    } else if (entry.isFile() && entry.name.endsWith('.chunks.json')) {
      out.push(full);
    }
  }
  return out;
}

/** Read a chunk manifest's chunk count; best-effort, 0 on any failure. */
async function readManifestChunkCount(manifestPath: string): Promise<number> {
  try {
    const raw = await fsp.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as { chunks?: unknown };
    return Array.isArray(parsed.chunks) ? parsed.chunks.length : 0;
  } catch {
    return 0;
  }
}

/**
 * RFC 017 §5 step 1 (cache-aware refinement, #408) — estimate how much
 * *cold* contextual-preface LLM work a `kb reindex` would actually incur,
 * instead of pricing every chunk at the 8s cold-case ceiling.
 *
 * The original estimator multiplied the total chunk count by 8s. After a
 * partial or successful contextual run, the per-source sidecars under
 * `$FAISS_INDEX_PATH/.contextual-prefaces/` already hold valid prefaces for
 * many chunks; the rebuild reuses them with no LLM call. This walks both
 * read-only inputs and returns the breakdown:
 *
 *   - chunk manifests under `<kb>/.index/**.chunks.json` give the
 *     authoritative count of chunks the rebuild will process.
 *   - contextual-preface sidecars classify each chunk as a cache hit, a
 *     not-yet-due retry skip, or a cold LLM call (see
 *     `classifyContextualSidecarChunks`).
 *
 * The cache-aware runtime estimate adds cold-preface work to the possible
 * whole-index embedding rebuild. A first-ever reindex (no sidecars) yields
 * `cold_chunks === total_chunks`; a warm cache still retains embedding cost.
 */
export async function estimateContextualReindexWork(
  kbs: readonly string[],
  now: Date = new Date(),
): Promise<ContextualReindexEstimate> {
  const nowMs = now.getTime();
  let totalChunks = 0;
  let cacheHits = 0;
  let retrySkips = 0;
  let coldChunks = 0;

  for (const kb of kbs) {
    const indexDir = path.join(KNOWLEDGE_BASES_ROOT_DIR, kb, '.index');
    for (const manifestPath of await collectChunkManifestPaths(indexDir)) {
      const chunkCount = await readManifestChunkCount(manifestPath);
      if (chunkCount <= 0) continue;
      totalChunks += chunkCount;
      // The manifest path mirrors the source layout:
      // `<kb>/.index/<rel>.chunks.json` → source `<kb>/<rel>`.
      const rel = path.relative(indexDir, manifestPath).replace(/\.chunks\.json$/, '');
      const source = path.join(KNOWLEDGE_BASES_ROOT_DIR, kb, rel);
      const tally = await classifyContextualSidecarChunks(source, kb, chunkCount, nowMs);
      cacheHits += tally.cache_hits;
      retrySkips += tally.retry_skips;
      coldChunks += tally.cold_chunks;
    }
  }

  return {
    total_chunks: totalChunks,
    cache_hits: cacheHits,
    retry_skips: retrySkips,
    cold_chunks: coldChunks,
  };
}

/**
 * #409 — after a reindex actually runs, sum the contextual-preface
 * sidecar counters across the in-scope KBs so `kb reindex` can report
 * preface cache / failure detail instead of leaving it in debug logs.
 * Returns `null` when contextual retrieval is disabled (the reindex
 * embedded chunks verbatim, so any stale sidecars would be misleading).
 */
export async function summarizeContextualOutcome(
  kbs: readonly string[],
): Promise<ContextualReindexSummary | null> {
  if (!isContextualRetrievalEnabled()) return null;
  const summary: ContextualReindexSummary = {
    kbs: kbs.length,
    covered_chunks: 0,
    null_preface_chunks: 0,
    retry_pending_chunks: 0,
    failures_by_error_code: {},
  };
  for (const kb of kbs) {
    const stats = await aggregateContextualSidecarStats(kb);
    summary.covered_chunks += stats.covered_chunks;
    summary.null_preface_chunks += stats.null_preface_chunks;
    summary.retry_pending_chunks += stats.retry_pending_chunks;
    for (const [code, count] of Object.entries(stats.failures_by_error_code)) {
      const key = code as ContextualErrorCode;
      summary.failures_by_error_code[key] =
        (summary.failures_by_error_code[key] ?? 0) + (count ?? 0);
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runReindex(options: ReindexOptions): Promise<ReindexResult> {
  const startedAtMs = Date.now();
  const now = options.now ?? new Date();

  // 1. Resolve scope + estimate runtime. The estimate is cache-aware
  //    (#408): only chunks without a valid contextual-preface sidecar are
  //    priced at the 8s cold-LLM ceiling. Every chunk is additionally priced
  //    at the observed embedding rebuild rate because an incremental update
  //    can escalate to a whole-index FAISS rebuild.
  const kbs = await resolveKbsInScope(options);
  const estimate = await estimateContextualReindexWork(kbs, now);
  const totalChunks = estimate.total_chunks;
  const estimatedSeconds = Math.ceil(
    (
      estimate.cold_chunks * REINDEX_PER_CHUNK_ESTIMATE_MS
      + estimate.total_chunks * REINDEX_EMBEDDING_PER_CHUNK_ESTIMATE_MS
    ) / 1_000,
  );

  emitCanonicalLog({
    process: 'cli',
    cmd: 'reindex.start',
    took_ms: 0,
    kb_scope: kbs.length === 1 ? kbs[0] : null,
    top_sources: kbs.slice(0, 3),
    k: totalChunks,
    result_count: estimate.cold_chunks,
    threshold: estimatedSeconds,
  });

  // 2. Guards.
  if (!options.force) {
    if (isInsideGuardWindow(now)) {
      return finalizeGuardBlocked(
        kbs.length,
        estimate,
        estimatedSeconds,
        startedAtMs,
        `Inside LRA cron window (${formatWindow()} UTC). Pass --force to override.`,
      );
    }
    if (wouldCrossLraWindow(now, estimatedSeconds)) {
      return finalizeGuardBlocked(
        kbs.length,
        estimate,
        estimatedSeconds,
        startedAtMs,
        `Estimated runtime ${estimatedSeconds}s would cross the next LRA cron window (${formatWindow()} UTC). Pass --force to override or schedule for a longer window.`,
      );
    }
  }

  // 3. Refuse if a peer reindex is already running (and clean up zombies).
  const runState = await checkReindexRunState();
  if (runState.alive && runState.state !== null) {
    const reason = `Another reindex is in progress (PID ${runState.state.pid}, started at ${runState.state.started_at}).`;
    logger.warn(`RFC 017 M0b: ${reason}`);
    emitCanonicalLog({
      process: 'cli',
      cmd: 'reindex.exit',
      took_ms: Date.now() - startedAtMs,
      result_count: 0,
      k: kbs.length,
      error: { code: 'REINDEX_LOCK_HELD', category: 'lock' },
    });
    return {
      outcome: 'lock_held',
      kbs_attempted: kbs.length,
      total_chunks_estimate: totalChunks,
      estimated_seconds: estimatedSeconds,
      contextual_estimate: estimate,
      took_ms: Date.now() - startedAtMs,
      reason,
      summary: null,
      contextual: null,
    };
  }

  // 4. Write the run-state file. The trigger watcher consults this
  //    before attempting `updateIndex`, deferring its own work.
  const state: RunStateFile = {
    schema_version: REINDEX_RUN_SCHEMA_VERSION,
    pid: process.pid,
    started_at: new Date().toISOString(),
    kbs_in_scope: [...kbs],
  };
  await writeRunState(state);

  // 5. Run the actual refresh via `updateIndex`. Cold contextual-preface
  //    chunks mean this is still a backfill: force a global rebuild so
  //    all existing vectors are rewritten with contextual embedding
  //    inputs. Once the sidecar cache is warm, use the normal
  //    incremental path; it embeds only changed/appended chunks and
  //    falls back to a full rebuild when FAISS deletion limits require it.
  const shouldForceRebuild = estimate.cold_chunks > 0;
  let summary: IndexUpdateSummary;
  try {
    if (options.runUpdateIndex) {
      // Test seam (or an injecting caller): bypass manager construction
      // entirely. `createManagerForReindex()` calls `initialize()`, which
      // resolves the embedding provider and throws when no provider key
      // is configured (e.g. in CI) — even though the real `updateIndex`
      // is being mocked here. The manager is only consumed by the
      // non-seam path below, so construct it lazily there.
      summary = await options.runUpdateIndex({ force: shouldForceRebuild });
    } else {
      const manager = options.manager ?? (await createManagerForReindex());
      summary = await runManagerUpdateIndex(manager, { force: shouldForceRebuild });
    }
  } catch (err) {
    await deleteRunState();
    emitCanonicalLog({
      process: 'cli',
      cmd: 'reindex.exit',
      took_ms: Date.now() - startedAtMs,
      result_count: 0,
      k: kbs.length,
      error: { code: 'INTERNAL', category: 'unknown' },
    });
    return {
      outcome: 'failed',
      kbs_attempted: kbs.length,
      total_chunks_estimate: totalChunks,
      estimated_seconds: estimatedSeconds,
      contextual_estimate: estimate,
      took_ms: Date.now() - startedAtMs,
      reason: (err as Error).message,
      summary: null,
      contextual: null,
    };
  } finally {
    // Always remove the run-state file on exit. The trigger watcher's
    // `checkReindexRunState` would also clean it up via PID-liveness
    // detection later, but clearing it here is the happy-path signal
    // that no work remains in flight.
    await deleteRunState();
  }

  const outcome: ReindexResult['outcome'] = summary.status === 'success'
    ? 'completed'
    : summary.status === 'partial'
      ? 'partial'
      : 'failed';

  emitCanonicalLog({
    process: 'cli',
    cmd: 'reindex.exit',
    took_ms: Date.now() - startedAtMs,
    result_count: kbs.length,
    k: summary.files_changed ?? 0,
  });

  return {
    outcome,
    kbs_attempted: kbs.length,
    total_chunks_estimate: totalChunks,
    estimated_seconds: estimatedSeconds,
    contextual_estimate: estimate,
    took_ms: Date.now() - startedAtMs,
    reason: outcome === 'completed' ? null : 'updateIndex reported non-success status',
    summary,
    contextual: await summarizeContextualOutcome(kbs),
  };
}

async function createManagerForReindex(): Promise<FaissIndexManager> {
  const manager = new FaissIndexManager();
  await manager.initialize();
  return manager;
}

async function runManagerUpdateIndex(
  manager: FaissIndexManager,
  options: { force: boolean },
): Promise<IndexUpdateSummary> {
  // Forced mode is for the initial contextual backfill. Non-forced mode
  // keeps daily follow-up runs incremental while preserving
  // FaissIndexManager's full-rebuild fallback for unsafe deltas.
  await manager.updateIndex(undefined, { force: options.force });
  return manager.getLastIndexUpdateSummary();
}

function formatWindow(): string {
  const s = (n: number) => n.toString().padStart(2, '0');
  return `${s(REINDEX_GUARD_WINDOW_START_UTC.hour)}:${s(REINDEX_GUARD_WINDOW_START_UTC.minute)}-${s(REINDEX_GUARD_WINDOW_END_UTC.hour)}:${s(REINDEX_GUARD_WINDOW_END_UTC.minute)}`;
}

function finalizeGuardBlocked(
  kbCount: number,
  estimate: ContextualReindexEstimate,
  estimatedSeconds: number,
  startedAtMs: number,
  reason: string,
): ReindexResult {
  logger.warn(`RFC 017 M0b: ${reason}`);
  emitCanonicalLog({
    process: 'cli',
    cmd: 'reindex.exit',
    took_ms: Date.now() - startedAtMs,
    result_count: 0,
    k: kbCount,
    error: { code: 'REINDEX_BUDGET_EXCEEDED', category: 'input' },
  });
  return {
    outcome: 'guard_blocked',
    kbs_attempted: kbCount,
    total_chunks_estimate: estimate.total_chunks,
    estimated_seconds: estimatedSeconds,
    contextual_estimate: estimate,
    took_ms: Date.now() - startedAtMs,
    reason,
    summary: null,
    contextual: null,
  };
}

/** Test seams — exposed for unit tests. */
export const _testing = {
  isInsideGuardWindow,
  wouldCrossLraWindow,
  readRunState,
  writeRunState,
  deleteRunState,
};
