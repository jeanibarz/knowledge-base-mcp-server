// RFC 017 — Contextual Retrieval at Ingest.
//
// Per-chunk LLM-generated preface that situates the chunk in its source
// document, prepended to the chunk text **for embedding only**. The
// caller-visible `pageContent` stays byte-identical.
//
// Three responsibilities live here:
//   1. `embeddingText(doc)` — the single source of truth used by both the
//      dense embedder (`FaissStoreAdapter`) and the BM25 lexical index
//      (`LexicalIndex.refresh`). Returns `"{preface}\n\n{chunk}"` when a
//      preface is present on metadata; otherwise the raw chunk.
//   2. `resolveContextualPrefaces` — cache-then-LLM resolver. Reads the
//      per-source sidecar under `withSidecarLock`, calls the LLM only for
//      misses, and returns `(string | null)[]` aligned to the input
//      `chunks` array. Failures land as `null`; the next reindex retries
//      after a per-error backoff.
//   3. `persistContextualSidecars` — buffered sidecar writes. The CLI
//      (M0b) flushes per-KB at end-of-KB; M0a's `buildChunkDocuments`
//      flushes per-file inline since there's no run-orchestrator yet.
//
// The cache key is `(documentHash, chunkHash, generator, model,
// chunkSize, chunkOverlap)`. A change to any of these forces an LLM call.
// We deliberately do NOT include a splitter-version fingerprint — the
// RFC §2 rationale documents that the defense was incomplete without
// covering the whole pre-splitter pipeline. If a langchain bump silently
// changes boundaries, the regression surfaces in `kb eval` and the
// operator bumps `GENERATOR_VERSION` below to invalidate.

import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { Document } from '@langchain/core/documents';

import {
  CONTEXTUAL_CONSECUTIVE_TIMEOUT_LIMIT,
  CONTEXTUAL_DOCUMENT_TRUNCATION_CHARS,
  CONTEXTUAL_LLM_TIMEOUT_MS,
  CONTEXTUAL_RETRY_AFTER_MS,
  CONTEXTUAL_RETRY_LIMIT,
  ContextualErrorCode,
  isContextualRetrievalEnabled,
  resolveContextualLlmEndpoint,
  resolveContextualMaxTokens,
} from './config/contextual-preface.js';
import { resolveChunkSize } from './config/indexing.js';
import { FAISS_INDEX_PATH } from './config/paths.js';
import { KBError } from './errors.js';
import { callChatCompletion, LlmClientError } from './llm-client.js';
import { logger } from './logger.js';
import { withSidecarLock } from './write-lock.js';

export const GENERATOR_VERSION = 'contextual-preface.v1';
const SIDECAR_SCHEMA_VERSION = 'contextual-preface.sidecar.v1';
const SIDECAR_ROOT_DIRNAME = '.contextual-prefaces';

const SYSTEM_PROMPT =
  'You generate short retrieval-aware context strings. Reply with the context only, no preamble, no markdown.';

// `{preface}\n\n{chunk}` — plain prefix, not XML tags. The RFC v3
// minimalist round chose this default; XML can be revisited via a
// GENERATOR_VERSION bump if measurement shows it's better.
const EMBEDDING_TEMPLATE_SEPARATOR = '\n\n';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Embedder/lexical-index single source of truth: what string actually gets
 * embedded / BM25-tokenized for a given chunk.
 *
 * Returns `"{preface}{sep}{chunk}"` when `metadata.contextual_preface` is
 * a non-empty string; otherwise returns `doc.pageContent` unchanged. This
 * lets feature-gated code paths converge — the gate is on the metadata
 * (only `buildChunkDocuments` writes it when KB_CONTEXTUAL_RETRIEVAL is
 * on), not on a global flag in this helper.
 */
export function embeddingText(doc: Document): string {
  const preface = (doc.metadata as { contextual_preface?: unknown } | undefined)?.contextual_preface;
  if (typeof preface !== 'string' || preface.length === 0) return doc.pageContent;
  return `${preface}${EMBEDDING_TEMPLATE_SEPARATOR}${doc.pageContent}`;
}

export interface PrefaceResolveArgs {
  /** Absolute path of the source file. Used only to derive the sidecar path. */
  source: string;
  knowledgeBaseName: string;
  /**
   * sha256 hex of the document body the splitter saw — computed by the
   * caller from the SAME buffer used to produce `chunks`, so a concurrent
   * edit cannot pair a stale hash with fresh chunks.
   */
  documentHash: string;
  documentBody: string;
  chunks: string[];
}

/**
 * Resolve one preface per chunk. Returns an array aligned to `chunks`;
 * each element is the preface text, or `null` when generation failed
 * (the caller falls back to embedding the chunk verbatim).
 *
 * Side effect: dirty sidecars are persisted to disk under
 * `withSidecarLock` before returning. The M0b CLI may later defer the
 * persist to end-of-KB; M0a's `buildChunkDocuments` call site flushes
 * per-file because there's no run-orchestrator yet.
 */
export async function resolveContextualPrefaces(
  args: PrefaceResolveArgs,
): Promise<(string | null)[]> {
  if (args.chunks.length === 0) return [];

  const endpoint = resolveContextualLlmEndpoint();
  if (endpoint === null) {
    // Feature flag is on but no endpoint configured — log once per call
    // and degrade to non-contextual. Don't throw; ingest must still
    // succeed in environments without a warm LLM.
    logger.warn(
      'RFC 017: KB_CONTEXTUAL_RETRIEVAL=on but KB_LLM_ENDPOINT is unset; ingesting without prefaces',
    );
    return args.chunks.map(() => null);
  }

  const { chunkSize, chunkOverlap } = resolveChunkSize();

  // Read existing sidecar (if any).
  const sidecarPath = sidecarPathFor(args.source, args.knowledgeBaseName);
  const existing = await readSidecar(sidecarPath);

  // Walk chunks: cache-hit, retry-after-not-yet-elapsed, or LLM call.
  const truncatedDoc = args.documentBody.length > CONTEXTUAL_DOCUMENT_TRUNCATION_CHARS
    ? args.documentBody.slice(0, CONTEXTUAL_DOCUMENT_TRUNCATION_CHARS)
    : args.documentBody;
  const docWasTruncated = truncatedDoc !== args.documentBody;

  const nowMs = Date.now();
  const resolved: (string | null)[] = new Array(args.chunks.length);
  const newEntries: SidecarChunkEntry[] = new Array(args.chunks.length);
  let consecutiveTimeouts = 0;
  let modelSeen: string | null = existing?.model ?? null;
  let cacheHits = 0;
  let llmCalls = 0;
  let failures = 0;
  const startedAt = Date.now();

  for (let i = 0; i < args.chunks.length; i += 1) {
    const chunkText = args.chunks[i];
    const chunkHash = sha256(chunkText);

    const cached: SidecarChunkEntry | undefined = existing?.chunks[i];
    const cacheValid =
      existing !== null &&
      cached !== undefined &&
      cached.chunk_index === i &&
      cached.chunk_hash === chunkHash &&
      existing.document_hash === args.documentHash &&
      existing.generator === GENERATOR_VERSION &&
      existing.chunk_size === chunkSize &&
      existing.chunk_overlap === chunkOverlap;

    // Successful cache hit.
    if (cacheValid && cached!.preface !== null && cached!.preface !== undefined) {
      resolved[i] = cached!.preface;
      newEntries[i] = cached!;
      cacheHits += 1;
      continue;
    }

    // Cached failure: respect next_retry_after.
    if (cacheValid && cached!.preface === null && cached!.next_retry_after !== undefined) {
      const retryAtMs = parseIsoToMs(cached!.next_retry_after);
      if (retryAtMs !== null && retryAtMs > nowMs) {
        resolved[i] = null;
        newEntries[i] = cached!;
        cacheHits += 1; // counted as a hit because we skipped the LLM
        continue;
      }
    }

    // Document-truncation case: no point calling the LLM with a chunk that
    // can never be fully situated. Record the failure, schedule no retry,
    // continue.
    if (docWasTruncated) {
      newEntries[i] = makeFailureEntry(i, chunkHash, 'truncated_doc');
      resolved[i] = null;
      failures += 1;
      continue;
    }

    // Cache miss → LLM call (with retry budget).
    let result: LlmCallResult;
    try {
      result = await callPrefaceLlm({
        endpoint,
        documentBody: truncatedDoc,
        chunkText,
      });
    } catch (err) {
      // Consecutive-timeout circuit breaker (per-file scope in M0a). When
      // tripped, mark the current chunk plus all remaining chunks as
      // `llm_unreachable` failures and break out of the loop. The M0b CLI
      // wraps this in a per-run breaker that can also abort the whole
      // reindex; in M0a the per-file degradation is the right blast radius.
      const wasTimeout = isTimeoutError(err);
      if (wasTimeout) {
        consecutiveTimeouts += 1;
      } else {
        consecutiveTimeouts = 0;
      }
      const errorCode = classifyLlmError(err);
      newEntries[i] = makeFailureEntry(i, chunkHash, errorCode);
      resolved[i] = null;
      failures += 1;
      llmCalls += 1;

      if (consecutiveTimeouts >= CONTEXTUAL_CONSECUTIVE_TIMEOUT_LIMIT) {
        logger.warn(
          `RFC 017: circuit breaker tripped for ${args.source} after ${CONTEXTUAL_CONSECUTIVE_TIMEOUT_LIMIT} consecutive LLM timeouts; remaining ${args.chunks.length - i - 1} chunks will be marked failed without LLM calls`,
        );
        for (let j = i + 1; j < args.chunks.length; j += 1) {
          newEntries[j] = makeFailureEntry(j, sha256(args.chunks[j]), 'llm_unreachable');
          resolved[j] = null;
          failures += 1;
        }
        break;
      }

      continue;
    }

    // Success.
    consecutiveTimeouts = 0;
    if (result.model !== null) modelSeen = result.model;
    newEntries[i] = {
      chunk_index: i,
      chunk_hash: chunkHash,
      preface: result.preface,
      generated_at: new Date().toISOString(),
    };
    resolved[i] = result.preface;
    llmCalls += 1;
  }

  // Persist sidecar atomically under withSidecarLock.
  try {
    await persistSidecar(sidecarPath, args, modelSeen, chunkSize, chunkOverlap, newEntries, args.chunks.length);
  } catch (err) {
    // Sidecar write failure is non-fatal: the prefaces are still in
    // memory and will be returned to the caller. The next ingest pass
    // re-resolves; we just don't get the cache benefit.
    logger.warn(`RFC 017: sidecar write failed for ${args.source}: ${(err as Error).message}`);
  }

  logger.debug(
    `RFC 017: contextual-preface.resolve source=${args.source} chunks=${args.chunks.length} cache_hits=${cacheHits} llm_calls=${llmCalls} failures=${failures} took_ms=${Date.now() - startedAt}`,
  );

  return resolved;
}

// ---------------------------------------------------------------------------
// Sidecar IO
// ---------------------------------------------------------------------------

interface SidecarChunkEntry {
  chunk_index: number;
  chunk_hash: string;
  preface: string | null;
  generated_at?: string;
  error_code?: ContextualErrorCode;
  next_retry_after?: string;
}

interface SidecarFile {
  schema_version: typeof SIDECAR_SCHEMA_VERSION;
  source: string;
  knowledge_base: string;
  document_hash: string;
  generator: string;
  model: string | null;
  chunk_size: number;
  chunk_overlap: number;
  chunks: SidecarChunkEntry[];
}

export function sidecarRootDir(): string {
  return path.join(FAISS_INDEX_PATH, SIDECAR_ROOT_DIRNAME);
}

/**
 * The contextual-preface sidecar directory for one KB:
 *
 *   `${FAISS_INDEX_PATH}/.contextual-prefaces/<safe-kb>/`
 *
 * The `<safe-kb>` slug strips characters that aren't filesystem-safe.
 * `sidecarPathFor` and `aggregateContextualSidecarStats` both route
 * through here so the slug is derived in exactly one place.
 */
export function sidecarDirFor(knowledgeBaseName: string): string {
  const safeKb = knowledgeBaseName.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(sidecarRootDir(), safeKb);
}

export function sidecarPathFor(sourceAbsPath: string, knowledgeBaseName: string): string {
  // We use the basename + a content-derived prefix of the absolute path so
  // two source files with the same basename in different subdirs don't
  // collide. The on-disk shape is:
  //
  //   ${FAISS_INDEX_PATH}/.contextual-prefaces/<kb>/<flattened-source>.json
  //
  // where <flattened-source> is the source path with `/` → `__SEP__` so we
  // don't need to mkdir-p deep trees. The KB's own subdirectory structure
  // is preserved in the metadata.source field on disk.
  const flat = sourceAbsPath.replace(/^\/+/, '').replace(/\//g, '__SEP__');
  return path.join(sidecarDirFor(knowledgeBaseName), `${flat}.json`);
}

// ---------------------------------------------------------------------------
// Sidecar aggregation — #409 operator-facing cache / failure diagnostics
// ---------------------------------------------------------------------------

/**
 * Counters scanned from one KB's contextual-preface sidecars. A pure
 * on-disk read: no LLM call, no lock. Backs the `contextual_preface`
 * block in `kb stats` and the contextual summary line in `kb reindex`
 * output, so failure detail stops being debug-log-only (#409).
 */
export interface ContextualSidecarStats {
  /** Number of `*.json` sidecar files scanned for the KB. */
  sidecar_count: number;
  /** Chunks with a non-empty preface persisted (successful generations). */
  covered_chunks: number;
  /** Chunks whose `preface` is `null` — generation failed for them. */
  null_preface_chunks: number;
  /**
   * Subset of `null_preface_chunks` whose `next_retry_after` is still in
   * the future: the next reindex SKIPS these (no LLM call) and keeps
   * embedding the chunk verbatim until the per-error backoff elapses.
   */
  retry_pending_chunks: number;
  /**
   * Failure counts keyed by `ContextualErrorCode`. Sums to at most
   * `null_preface_chunks` — a malformed sidecar entry without a known
   * `error_code` still counts toward `null_preface_chunks` but not here.
   */
  failures_by_error_code: Partial<Record<ContextualErrorCode, number>>;
  /** Total bytes of every sidecar JSON file scanned. */
  cache_bytes: number;
  /** Most recent sidecar file mtime, ISO; `null` when the KB has no sidecars. */
  latest_sidecar_at: string | null;
  /** `model` recorded in the last sidecar read; `null` when none carry one. */
  model: string | null;
}

/**
 * Scan one KB's sidecar directory and tally cache / failure counters.
 * Missing directory (KB never reindexed with contextual retrieval on) and
 * corrupt individual sidecars degrade to zero contributions rather than
 * throwing — `kb stats` and `kb reindex` must stay read-only and robust.
 *
 * `nowMs` is injectable purely so tests can pin `retry_pending_chunks`
 * arithmetic; production callers use the `Date.now()` default.
 */
export async function aggregateContextualSidecarStats(
  knowledgeBaseName: string,
  nowMs: number = Date.now(),
): Promise<ContextualSidecarStats> {
  const stats: ContextualSidecarStats = {
    sidecar_count: 0,
    covered_chunks: 0,
    null_preface_chunks: 0,
    retry_pending_chunks: 0,
    failures_by_error_code: {},
    cache_bytes: 0,
    latest_sidecar_at: null,
    model: null,
  };

  const dir = sidecarDirFor(knowledgeBaseName);
  let dirEntries: Array<import('fs').Dirent>;
  try {
    dirEntries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      logger.debug(`RFC 017: contextual sidecar readdir failed for ${dir}: ${(err as Error).message}`);
    }
    return stats;
  }

  let latestMtime = 0;
  for (const entry of dirEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(dir, entry.name);

    let st: import('fs').Stats;
    try {
      st = await fsp.stat(filePath);
    } catch {
      continue;
    }
    stats.sidecar_count += 1;
    stats.cache_bytes += st.size;
    if (st.mtimeMs > latestMtime) latestMtime = st.mtimeMs;

    let raw: string;
    try {
      raw = await fsp.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }
    let parsed: { chunks?: unknown; model?: unknown };
    try {
      parsed = JSON.parse(raw) as { chunks?: unknown; model?: unknown };
    } catch {
      continue;
    }
    if (typeof parsed.model === 'string') stats.model = parsed.model;
    if (!Array.isArray(parsed.chunks)) continue;

    for (const chunk of parsed.chunks) {
      if (typeof chunk !== 'object' || chunk === null) continue;
      const c = chunk as { preface?: unknown; error_code?: unknown; next_retry_after?: unknown };
      if (typeof c.preface === 'string' && c.preface.length > 0) {
        stats.covered_chunks += 1;
        continue;
      }
      if (c.preface !== null) continue;
      stats.null_preface_chunks += 1;
      if (typeof c.error_code === 'string' && isContextualErrorCode(c.error_code)) {
        stats.failures_by_error_code[c.error_code] =
          (stats.failures_by_error_code[c.error_code] ?? 0) + 1;
      }
      if (typeof c.next_retry_after === 'string') {
        const retryAtMs = parseIsoToMs(c.next_retry_after);
        if (retryAtMs !== null && retryAtMs > nowMs) stats.retry_pending_chunks += 1;
      }
    }
  }

  stats.latest_sidecar_at = latestMtime === 0 ? null : new Date(latestMtime).toISOString();
  return stats;
}

function isContextualErrorCode(value: string): value is ContextualErrorCode {
  return Object.prototype.hasOwnProperty.call(CONTEXTUAL_RETRY_AFTER_MS, value);
}

async function readSidecar(sidecarPath: string): Promise<SidecarFile | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(sidecarPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    logger.warn(`RFC 017: sidecar read failed for ${sidecarPath}: ${(err as Error).message}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON — log and treat as cache miss. The sidecar gets
    // rewritten on the next successful persist.
    logger.warn(`RFC 017: sidecar JSON corrupt at ${sidecarPath}; treating as cache miss`);
    return null;
  }
  if (!isSidecarFile(parsed)) {
    logger.warn(`RFC 017: sidecar schema mismatch at ${sidecarPath}; treating as cache miss`);
    return null;
  }
  return parsed;
}

async function persistSidecar(
  sidecarPath: string,
  args: PrefaceResolveArgs,
  modelSeen: string | null,
  chunkSize: number,
  chunkOverlap: number,
  entries: SidecarChunkEntry[],
  validUpTo: number,
): Promise<void> {
  // Only persist the entries we actually populated this run. A partial
  // run (circuit breaker tripped) writes what it has; the rest will be
  // regenerated next time.
  const chunksToWrite = entries.slice(0, validUpTo).filter((entry): entry is SidecarChunkEntry => entry !== undefined);
  if (chunksToWrite.length === 0) return;

  const payload: SidecarFile = {
    schema_version: SIDECAR_SCHEMA_VERSION,
    source: args.source,
    knowledge_base: args.knowledgeBaseName,
    document_hash: args.documentHash,
    generator: GENERATOR_VERSION,
    model: modelSeen,
    chunk_size: chunkSize,
    chunk_overlap: chunkOverlap,
    chunks: chunksToWrite,
  };

  await withSidecarLock(async () => {
    const dir = path.dirname(sidecarPath);
    await fsp.mkdir(dir, { recursive: true });
    const tmpPath = `${sidecarPath}.tmp`;
    try {
      await fsp.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
      await fsp.rename(tmpPath, sidecarPath);
    } catch (err) {
      try {
        await fsp.unlink(tmpPath);
      } catch {
        // best-effort cleanup
      }
      throw new KBError(
        'INTERNAL',
        `failed to persist contextual-preface sidecar at ${sidecarPath}: ${(err as Error).message}`,
        err,
      );
    }
  });
}

function isSidecarFile(value: unknown): value is SidecarFile {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.schema_version !== SIDECAR_SCHEMA_VERSION) return false;
  if (typeof v.source !== 'string' || typeof v.knowledge_base !== 'string') return false;
  if (typeof v.document_hash !== 'string' || typeof v.generator !== 'string') return false;
  if (typeof v.chunk_size !== 'number' || typeof v.chunk_overlap !== 'number') return false;
  if (!Array.isArray(v.chunks)) return false;
  return v.chunks.every(isSidecarChunkEntry);
}

function isSidecarChunkEntry(value: unknown): value is SidecarChunkEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.chunk_index === 'number' &&
    typeof v.chunk_hash === 'string' &&
    (v.preface === null || typeof v.preface === 'string')
  );
}

function makeFailureEntry(
  chunkIndex: number,
  chunkHash: string,
  errorCode: ContextualErrorCode,
): SidecarChunkEntry {
  const retryAfterMs = CONTEXTUAL_RETRY_AFTER_MS[errorCode];
  const nextRetryAfter = Number.isFinite(retryAfterMs)
    ? new Date(Date.now() + retryAfterMs).toISOString()
    : new Date(8_640_000_000_000_000).toISOString(); // ECMA max date
  return {
    chunk_index: chunkIndex,
    chunk_hash: chunkHash,
    preface: null,
    error_code: errorCode,
    next_retry_after: nextRetryAfter,
  };
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

interface LlmCallResult {
  preface: string;
  model: string | null;
}

async function callPrefaceLlm(args: {
  endpoint: string;
  documentBody: string;
  chunkText: string;
}): Promise<LlmCallResult> {
  const userMessage = buildUserMessage(args.documentBody, args.chunkText);
  const maxTokens = resolveContextualMaxTokens();

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= CONTEXTUAL_RETRY_LIMIT; attempt += 1) {
    try {
      const result = await callChatCompletion({
        endpoint: args.endpoint,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.2,
        timeoutMs: CONTEXTUAL_LLM_TIMEOUT_MS,
      });
      const cleaned = cleanPrefaceText(result.content, maxTokens);
      if (cleaned === null) {
        throw new LlmClientError('preface response failed sanity checks (empty / refusal / oversize)');
      }
      return { preface: cleaned, model: result.model };
    } catch (err) {
      lastError = err;
      if (attempt < CONTEXTUAL_RETRY_LIMIT) {
        // 1s + jitter backoff.
        await delay(1_000 + Math.random() * 500);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new LlmClientError(String(lastError));
}

function buildUserMessage(documentBody: string, chunkText: string): string {
  return [
    '<document>',
    documentBody,
    '</document>',
    '',
    'Here is one chunk from the document above:',
    '<chunk>',
    chunkText,
    '</chunk>',
    '',
    'In ≤ 100 tokens, write a single succinct context paragraph situating this chunk in the overall document. Include the section heading the chunk lives under, the surrounding topic, and any pronouns the chunk relies on. Do not quote the chunk.',
  ].join('\n');
}

// Sanity-check a preface. Returns the trimmed text, or `null` if it
// should be treated as a failure.
function cleanPrefaceText(raw: string, maxTokens: number): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxTokens * 4) return null; // ~4 chars/token ceiling
  if (REFUSAL_PREFIXES.some((p) => trimmed.toLowerCase().startsWith(p))) return null;
  return trimmed;
}

const REFUSAL_PREFIXES = [
  'i cannot',
  "i can't",
  'i am unable',
  "i'm unable",
  'as an ai',
  'as a language model',
  "i'm sorry",
  'i apologize',
];

function classifyLlmError(err: unknown): ContextualErrorCode {
  if (!(err instanceof Error)) return 'llm_unreachable';
  const message = err.message.toLowerCase();
  if (message.includes('refusal') || REFUSAL_PREFIXES.some((p) => message.includes(p))) {
    return 'llm_refusal';
  }
  if (
    message.includes('failed sanity checks') ||
    message.includes('did not contain') ||
    message.includes('non-json') ||
    message.includes('http 4') ||
    message.includes('http 5')
  ) {
    return 'llm_malformed';
  }
  return 'llm_unreachable';
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return (
    message.includes('aborted') ||
    message.includes('timeout') ||
    message.includes('etimedout') ||
    message.includes('abortsignal')
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf-8').digest('hex');
}

function parseIsoToMs(iso: string): number | null {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-exports so callers don't have to import config plus this module.
export { isContextualRetrievalEnabled } from './config/contextual-preface.js';
