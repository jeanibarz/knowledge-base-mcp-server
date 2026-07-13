// RFC 017 #407 — durable per-file progress ledger for contextual reindex.
//
// `kb reindex --with-context` delegates the rebuild to
// `updateIndex(undefined, { force: true })` and exposes no per-file
// progress: after a SIGINT, crash, or host reboot an operator has no
// way to see which files finished their (expensive, LLM-bound) preface
// work and which still need it.
//
// This module derives that progress *from durable state that already
// exists*: the per-source contextual-preface sidecars under
// `${FAISS_INDEX_PATH}/.contextual-prefaces/`. Each sidecar is written
// atomically (tmp + rename) per source file as the reindex walks it, so
// the sidecar tree IS the per-file ledger — it survives any abrupt
// stop. `computeReindexProgress` rolls that tree up into a snapshot;
// `kb reindex status` prints it and materializes it to
// `.reindex.progress.json` for post-hoc inspection.
//
// Deliberately NOT in scope (RFC 017 §5 accepts bounded kill-loss; #407
// is a visibility layer, not a rewrite): checkpointing the in-memory
// FAISS rebuild. A resumed `kb reindex --with-context` re-walks every
// file, but completed files hit the sidecar cache and skip the LLM —
// the only resume mechanism #407 needs, and it already exists.

import * as fsp from 'fs/promises';
import * as path from 'path';

import { FAISS_INDEX_PATH, KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import {
  readContextualSidecarStatuses,
  type ContextualSidecarStatus,
} from './contextual-preface.js';
import { writeFileAtomicDurable } from './file-utils.js';
import { logger } from './logger.js';
import { checkReindexRunState } from './reindex-runner.js';
import { readLlmContextPolicy } from './sensitivity-policy.js';

// Filename of the progress ledger under FAISS_INDEX_PATH. Unlike
// `.reindex.run.json`, this file is never deleted — it is the durable
// rollup of the most recent `kb reindex status` query.
export const REINDEX_PROGRESS_FILENAME = '.reindex.progress.json';
export const REINDEX_PROGRESS_SCHEMA_VERSION = 'reindex-progress.v1';

/** `complete` when every chunk has a preface; `incomplete` otherwise. */
export type ReindexFileStatus = 'complete' | 'incomplete';

export interface ReindexProgressFile {
  /** Absolute source-file path recorded in the sidecar. */
  source: string;
  status: ReindexFileStatus;
  chunks_total: number;
  chunks_resolved: number;
  chunks_failed: number;
  /** Distinct contextual error codes across failed chunks, sorted. */
  error_codes: string[];
}

export interface ReindexProgressKb {
  knowledge_base: string;
  /**
   * Eligible files with a chunk manifest under `<kb>/.index/` — the
   * denominator the contextual-preface work walks. Sources explicitly marked
   * `kb_policy.no_llm_context` are not pending LLM work.
   */
  files_indexed: number;
  /** Eligible files that have a contextual-preface sidecar. */
  files_with_sidecar: number;
  files_complete: number;
  files_incomplete: number;
  /** `max(0, files_indexed - files_with_sidecar)` — eligible files not yet started. */
  files_pending: number;
  chunks_resolved: number;
  chunks_failed: number;
  files: ReindexProgressFile[];
}

export interface ReindexProgressTotals {
  knowledge_bases: number;
  files_indexed: number;
  files_with_sidecar: number;
  files_complete: number;
  files_incomplete: number;
  files_pending: number;
  chunks_resolved: number;
  chunks_failed: number;
}

export interface ReindexRunSnapshot {
  pid: number;
  started_at: string;
  kbs_in_scope: string[];
}

export interface ReindexProgress {
  schema_version: typeof REINDEX_PROGRESS_SCHEMA_VERSION;
  /** ISO timestamp this snapshot was computed. */
  computed_at: string;
  /** True when `.reindex.run.json` names a live PID. */
  run_active: boolean;
  /** The run-state file contents, or null when no reindex is registered. */
  run: ReindexRunSnapshot | null;
  kbs: ReindexProgressKb[];
  totals: ReindexProgressTotals;
}

export interface ComputeReindexProgressOptions {
  /**
   * Restrict the report to these KB names. An empty / omitted list
   * reports every KB that has at least one contextual sidecar. A named
   * KB with no sidecars is still reported (with zero counts) so a
   * resume check on a specific KB is never silently empty.
   */
  knowledgeBases?: readonly string[];
}

export function reindexProgressFilePath(): string {
  return path.join(FAISS_INDEX_PATH, REINDEX_PROGRESS_FILENAME);
}

/** Count eligible chunk manifests under `<kb>/.index/` — one per indexed file. */
async function countIndexedFiles(kb: string): Promise<number> {
  const indexDir = path.join(KNOWLEDGE_BASES_ROOT_DIR, kb, '.index');
  let entries: Array<import('fs').Dirent>;
  try {
    entries = await fsp.readdir(indexDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const manifests = entries.filter((e) => e.isFile() && e.name.endsWith('.chunks.json'));
  let eligible = 0;
  for (const manifest of manifests) {
    const source = path.join(
      KNOWLEDGE_BASES_ROOT_DIR,
      kb,
      manifest.name.replace(/\.chunks\.json$/, ''),
    );
    if (!(await isPolicyExcludedSource(source))) eligible += 1;
  }
  return eligible;
}

async function isPolicyExcludedSource(source: string): Promise<boolean> {
  const snapshot = await readLlmContextPolicy(source);
  return snapshot.readable && snapshot.valid && snapshot.policy?.no_llm_context === true;
}

function fileStatusOf(status: ContextualSidecarStatus): ReindexFileStatus {
  return status.chunksTotal > 0 &&
    status.chunksFailed === 0 &&
    status.chunksResolved === status.chunksTotal
    ? 'complete'
    : 'incomplete';
}

/**
 * Roll the contextual-preface sidecar tree up into a progress snapshot.
 * Pure read: walks sidecars + chunk manifests + `.reindex.run.json` and
 * returns the snapshot. (`checkReindexRunState` may zombie-clean a dead
 * run-state file as a documented side effect — RFC 017 §5 step 4.)
 */
export async function computeReindexProgress(
  options: ComputeReindexProgressOptions = {},
): Promise<ReindexProgress> {
  const statuses = await readContextualSidecarStatuses();
  const runState = await checkReindexRunState();

  const byKb = new Map<string, ContextualSidecarStatus[]>();
  for (const status of statuses) {
    const list = byKb.get(status.knowledgeBase);
    if (list) list.push(status);
    else byKb.set(status.knowledgeBase, [status]);
  }

  const filter =
    options.knowledgeBases && options.knowledgeBases.length > 0
      ? new Set(options.knowledgeBases)
      : null;

  const names = new Set<string>(byKb.keys());
  if (filter) for (const name of filter) names.add(name);

  const kbs: ReindexProgressKb[] = [];
  for (const name of [...names].sort()) {
    if (filter && !filter.has(name)) continue;
    const eligibleStatuses: ContextualSidecarStatus[] = [];
    for (const status of byKb.get(name) ?? []) {
      if (!(await isPolicyExcludedSource(status.source))) eligibleStatuses.push(status);
    }
    const files: ReindexProgressFile[] = eligibleStatuses
      .map((status) => ({
        source: status.source,
        status: fileStatusOf(status),
        chunks_total: status.chunksTotal,
        chunks_resolved: status.chunksResolved,
        chunks_failed: status.chunksFailed,
        error_codes: status.errorCodes.slice(),
      }))
      .sort((a, b) => a.source.localeCompare(b.source));

    const filesIndexed = await countIndexedFiles(name);
    const filesWithSidecar = files.length;
    const filesComplete = files.filter((f) => f.status === 'complete').length;
    kbs.push({
      knowledge_base: name,
      files_indexed: filesIndexed,
      files_with_sidecar: filesWithSidecar,
      files_complete: filesComplete,
      files_incomplete: filesWithSidecar - filesComplete,
      files_pending: Math.max(0, filesIndexed - filesWithSidecar),
      chunks_resolved: files.reduce((n, f) => n + f.chunks_resolved, 0),
      chunks_failed: files.reduce((n, f) => n + f.chunks_failed, 0),
      files,
    });
  }

  const totals: ReindexProgressTotals = {
    knowledge_bases: kbs.length,
    files_indexed: kbs.reduce((n, k) => n + k.files_indexed, 0),
    files_with_sidecar: kbs.reduce((n, k) => n + k.files_with_sidecar, 0),
    files_complete: kbs.reduce((n, k) => n + k.files_complete, 0),
    files_incomplete: kbs.reduce((n, k) => n + k.files_incomplete, 0),
    files_pending: kbs.reduce((n, k) => n + k.files_pending, 0),
    chunks_resolved: kbs.reduce((n, k) => n + k.chunks_resolved, 0),
    chunks_failed: kbs.reduce((n, k) => n + k.chunks_failed, 0),
  };

  return {
    schema_version: REINDEX_PROGRESS_SCHEMA_VERSION,
    computed_at: new Date().toISOString(),
    run_active: runState.alive,
    run:
      runState.state === null
        ? null
        : {
            pid: runState.state.pid,
            started_at: runState.state.started_at,
            kbs_in_scope: [...runState.state.kbs_in_scope],
          },
    kbs,
    totals,
  };
}

/**
 * Materialize a progress snapshot to `.reindex.progress.json` under
 * `FAISS_INDEX_PATH`, atomically (tmp + rename).
 */
export async function writeReindexProgress(progress: ReindexProgress): Promise<void> {
  const target = reindexProgressFilePath();
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await writeFileAtomicDurable(target, `${JSON.stringify(progress, null, 2)}\n`);
}

/** Read a previously-written ledger, or null when absent / unreadable. */
export async function readReindexProgress(): Promise<ReindexProgress | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(reindexProgressFilePath(), 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      logger.warn(`#407: failed to read reindex progress ledger: ${(err as Error).message}`);
    }
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ReindexProgress>;
    if (parsed?.schema_version !== REINDEX_PROGRESS_SCHEMA_VERSION) return null;
    return parsed as ReindexProgress;
  } catch {
    logger.warn('#407: reindex progress ledger is corrupt JSON; ignoring');
    return null;
  }
}
