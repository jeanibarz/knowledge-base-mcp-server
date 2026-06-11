// Issue #339 — shared hybrid (dense ⨁ lexical via RRF) retrieval policy.
//
// Why this module exists. Before this extraction, hybrid retrieval lived in
// three places: the MCP `retrieve_knowledge` handler, the CLI
// `kb search --mode=hybrid` command, and the offline `retrieval-eval` runner.
// Each owned its own copies of the fetch-sizing constants, the RRF wiring,
// the identity-mapping pass, and the final assembly. The MCP copy already
// drifted from the other two: MCP fetched a fixed `HYBRID_FETCH_K = 40`
// regardless of the requested top-k, while CLI/eval scaled fetch as
// `k * HYBRID_FETCH_MULTIPLIER`. That divergence makes ranking changes hard
// to validate — a fix landed against the eval runner does not necessarily
// land against the MCP surface, and vice versa.
//
// Scope. This module owns:
//
//   1. The fetch-sizing policy (`hybridFetchK`). One formula across surfaces.
//   2. The RRF fusion + identity mapping + final result assembly
//      (`fuseHybridResults`). Pure function — no I/O, no clock.
//   3. The per-KB lexical leg orchestration (`runLexicalLeg`). Iterates a
//      caller-supplied KB list, runs `LexicalIndex.load → (refresh? →) query`,
//      surfaces per-KB failures through an `onError` hook, and returns the
//      merged + score-sorted top-`fetchK`. The lexical index itself is still
//      owned by `lexical-index.ts`; this module just removes the boilerplate.
//
// Out of scope (kept in the adapters):
//
//   - The dense leg invocation. Each surface calls
//     `FaissIndexManager.similaritySearch` with surface-specific filters,
//     timing sinks, and cache options. Centralizing that signature would
//     leak adapter detail back into this module without removing duplication.
//   - Telemetry capture (canonical-log fields, `TimingPayload`). Adapters
//     own those.
//   - Output formatting (markdown header, JSON envelope, ScoredDocument
//     reshaping). Adapters own those too — that is the whole point of the
//     "policy outside adapter" framing in #339.
//
// Unified fetch policy. `fetchK = max(min(k * HYBRID_FETCH_MULTIPLIER, HYBRID_FETCH_CAP), k)`
// with `HYBRID_FETCH_MULTIPLIER = 4` and `HYBRID_FETCH_CAP = 200`.
//
//   - `× 4` matches the CLI/eval formula byte-for-byte at the typical
//     `k ≤ 25` operating point. It also keeps MCP's behaviour at its
//     hard-coded `k = 10`: 10 × 4 = 40, the same as the prior fixed
//     `HYBRID_FETCH_K = 40`. So there is no behavioural change for any
//     existing caller against today's defaults.
//   - The `200` cap protects against pathological `k` (e.g. an eval fixture
//     bumping `k` to 1000 would otherwise issue a 4000-fetch FAISS call and
//     materialize 4000 BM25 hits per KB). It sits well above any production
//     `k` we have observed (`kb search` defaults `k = 10`; the MCP surface
//     is fixed at `k = 10`; eval fixtures top out around `k = 25`). When a
//     caller asks for `k > HYBRID_FETCH_CAP / HYBRID_FETCH_MULTIPLIER = 50`,
//     we still return at least `k` items by clamping fetch to `k` — the
//     guard is `Math.max(..., k)` — so a `k = 100` caller gets `fetchK = 100`
//     rather than `200`, which keeps the post-fusion slice well-formed.
//
// RRF constant. `c = 60` per Cormack 2009; same value the standalone `rrf.ts`
// module uses as its default and the same value the prior duplicated copies
// hard-coded. Centralizing here means one place to change if the constant
// ever moves.

import * as path from 'path';
import { LexicalIndex, type LexicalRankingUnit, type LexicalSearchResult } from './lexical-index.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { listKnowledgeBases } from './kb-fs.js';
import { chunkIdFromMetadata, reciprocalRankFusion, type RankedList } from './rrf.js';
import type { RetrievalViewKind } from './retrieval-views.js';

export const HYBRID_FETCH_MULTIPLIER = 4;
export const HYBRID_FETCH_CAP = 200;
export const HYBRID_RRF_C = 60;

/**
 * Compute the per-leg fetch size for a given requested output `k`.
 *
 * Returns `max(min(k * HYBRID_FETCH_MULTIPLIER, HYBRID_FETCH_CAP), k)` so that
 * the fetch always overshoots the output (giving RRF room to re-order),
 * never exceeds `HYBRID_FETCH_CAP` for moderate `k`, but also never drops
 * below `k` itself for `k > HYBRID_FETCH_CAP`. The outer `max(..., k)`
 * guarantees the post-fusion `slice(0, k)` is always well-formed. See the
 * module-level comment for the policy justification.
 *
 * Throws on non-finite or non-positive `k` — these are caller bugs.
 */
export function hybridFetchK(k: number): number {
  if (!Number.isFinite(k) || k < 1 || !Number.isInteger(k)) {
    throw new Error(`hybridFetchK: invalid k=${k}; expected a positive integer`);
  }
  return Math.max(Math.min(k * HYBRID_FETCH_MULTIPLIER, HYBRID_FETCH_CAP), k);
}

/**
 * Generic score-bearing chunk shape suitable for fusion. `score` is optional
 * because fusion only consumes the position of each chunk in its input list
 * (RRF math is rank-based) and overwrites the field on output with the fused
 * RRF score. Accepting an optional score lets the dense leg pass
 * `ScoredDocument`-shaped objects (whose `score` is also optional) through
 * without a coercion at the adapter boundary.
 */
export interface HybridChunk {
  pageContent: string;
  metadata: Record<string, unknown>;
  score?: number;
}

export interface FuseHybridResultsArgs {
  denseResults: ReadonlyArray<HybridChunk>;
  lexicalResults: ReadonlyArray<HybridChunk>;
  /** Number of fused results to return. Must be ≥ 1. */
  k: number;
  /** Override the RRF smoothing constant. Defaults to `HYBRID_RRF_C` (60). */
  c?: number;
}

export interface FuseHybridResultsOutput {
  results: HybridChunk[];
  denseDistanceById: Map<string, number>;
  lexicalHitIds: Set<string>;
}

/**
 * Pure fusion + identity mapping + result assembly.
 *
 *   1. Build per-leg `RankedList` views over `(id, rank)` pairs using the
 *      stable `chunkIdFromMetadata` identity from `rrf.ts`.
 *   2. Fuse with Reciprocal Rank Fusion at `c = HYBRID_RRF_C` (or the caller
 *      override). All fusion math is delegated to `reciprocalRankFusion`.
 *   3. Build a `byId` map keyed on the same chunk id. Lexical entries are
 *      written first, dense entries second — when both legs return the same
 *      chunk, the dense entry wins, mirroring the prior CLI/MCP/eval
 *      precedence (dense metadata is generally more complete after
 *      similarity-search shaping).
 *   4. Walk the fused list in fused order, look the chunk up in `byId`, and
 *      replace `score` with the RRF `fusedScore`. Chunks the fusion produced
 *      that do not exist in either input map (impossible given the construct,
 *      but guarded for caller safety) are filtered out.
 *
 * Returns a fresh array of length ≤ `k`. Inputs are not mutated.
 */
export function fuseHybridResultsWithDiagnostics(args: FuseHybridResultsArgs): FuseHybridResultsOutput {
  const { denseResults, lexicalResults, k } = args;
  if (!Number.isFinite(k) || k < 1 || !Number.isInteger(k)) {
    throw new Error(`fuseHybridResultsWithDiagnostics: invalid k=${k}; expected a positive integer`);
  }
  const c = args.c ?? HYBRID_RRF_C;

  const denseList: RankedList = {
    retriever: 'dense',
    results: denseResults.map((r, i) => ({ id: chunkIdFromMetadata(r.metadata), rank: i + 1 })),
  };
  const lexicalList: RankedList = {
    retriever: 'lexical',
    results: lexicalResults.map((r, i) => ({ id: chunkIdFromMetadata(r.metadata), rank: i + 1 })),
  };
  const fused = reciprocalRankFusion([denseList, lexicalList], { c });

  const byId = new Map<string, HybridChunk>();
  for (const r of lexicalResults) byId.set(chunkIdFromMetadata(r.metadata), r);
  for (const r of denseResults) byId.set(chunkIdFromMetadata(r.metadata), r);

  const denseDistanceById = new Map<string, number>();
  for (const r of denseResults) {
    if (typeof r.score === 'number') {
      denseDistanceById.set(chunkIdFromMetadata(r.metadata), r.score);
    }
  }
  const lexicalHitIds = new Set<string>();
  for (const r of lexicalResults) {
    lexicalHitIds.add(chunkIdFromMetadata(r.metadata));
  }

  const results: HybridChunk[] = [];
  for (const f of fused.slice(0, k)) {
    const chunk = byId.get(f.id);
    if (chunk) results.push({ ...chunk, score: f.fusedScore });
  }
  return { results, denseDistanceById, lexicalHitIds };
}

export function fuseHybridResults(args: FuseHybridResultsArgs): HybridChunk[] {
  return fuseHybridResultsWithDiagnostics(args).results;
}

export interface LexicalKb {
  kbName: string;
  kbPath: string;
}

/**
 * List the lexical KBs to scan for a hybrid query.
 *
 * Enumerate every KB under `KNOWLEDGE_BASES_ROOT_DIR`, optionally filter to
 * `scopedKb`, and hand back `(kbName, kbPath)` pairs. The pre-extraction
 * copies of this helper disagreed on the missing-KB policy: the CLI returned
 * an empty array silently, the eval runner threw `KB not found`. We
 * centralize the silent-empty behaviour here — it matches the more
 * permissive surface (CLI, MCP) — and let strict callers (the eval runner)
 * do their own existence check before calling. Concretely, `listLexicalKbs`
 * never throws for a missing scope: callers see `[]` and can decide.
 */
export async function listLexicalKbs(scopedKb?: string): Promise<LexicalKb[]> {
  const all = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
  const filtered = scopedKb ? all.filter((name) => name === scopedKb) : all;
  return filtered.map((kbName) => ({
    kbName,
    kbPath: path.join(KNOWLEDGE_BASES_ROOT_DIR, kbName),
  }));
}

export type LexicalRefreshPolicy = 'always' | 'when-empty';

export interface LexicalLegOptions {
  kbs: ReadonlyArray<LexicalKb>;
  query: string;
  /** Per-KB top-k handed to `LexicalIndex.query`, then merged + clipped. */
  fetchK: number;
  /**
   * `'always'` mirrors `kb search --refresh` — refresh + save before every
   * query. `'when-empty'` matches MCP and eval — refresh only when the index
   * has zero files (first-use bootstrap). Either way, refreshes are counted
   * in the returned `refreshed`.
   */
  refresh: LexicalRefreshPolicy;
  rankingUnit?: LexicalRankingUnit;
  retrievalViews?: RetrievalViewKind[];
  /**
   * Called when a per-KB load/refresh/query throws. Per-KB failures are not
   * fatal — the leg continues with the remaining KBs. The hook lets each
   * surface log to its preferred channel (logger.warn for MCP, stderr for
   * CLI, throw for eval).
   */
  onError?: (kbName: string, err: Error) => void;
  /**
   * Optional injection point for tests so they can avoid touching disk. The
   * default loads via `LexicalIndex.load`.
   */
  loadIndex?: (kbName: string, kbPath: string) => Promise<LexicalIndex>;
}

export interface LexicalLegResult {
  hits: LexicalSearchResult[];
  /** Number of KBs whose index was refreshed during this call. */
  refreshed: number;
  /** Number of KBs whose load/refresh/query failed (and were swallowed). */
  failed: number;
}

/**
 * Run the lexical leg of a hybrid query over a KB list.
 *
 * For each `LexicalKb`:
 *
 *   1. Load the per-KB index.
 *   2. Refresh + save when policy says so (always, or when the index is empty).
 *   3. Query the top-`fetchK` hits and accumulate them.
 *
 * After the iteration, the merged hits are score-sorted descending and
 * clipped to `fetchK`. Per-KB failures are routed to `onError` (if provided)
 * and counted in the returned `failed`; the leg never throws on a per-KB
 * error.
 */
export async function runLexicalLeg(opts: LexicalLegOptions): Promise<LexicalLegResult> {
  const load = opts.loadIndex ?? LexicalIndex.load.bind(LexicalIndex);
  let refreshed = 0;
  let failed = 0;
  const all: LexicalSearchResult[] = [];
  for (const { kbName, kbPath } of opts.kbs) {
    try {
      const idx = await load(kbName, kbPath);
      const shouldRefresh = opts.refresh === 'always' || idx.numFiles() === 0;
      if (shouldRefresh) {
        await idx.refresh();
        await idx.save();
        refreshed += 1;
      }
      const hits = await idx.query(opts.query, opts.fetchK, {
        unit: opts.rankingUnit ?? 'chunk',
        retrievalViews: opts.retrievalViews,
      });
      for (const h of hits) all.push(h);
    } catch (err) {
      failed += 1;
      opts.onError?.(kbName, err as Error);
    }
  }
  all.sort((a, b) => b.score - a.score);
  return { hits: all.slice(0, opts.fetchK), refreshed, failed };
}
