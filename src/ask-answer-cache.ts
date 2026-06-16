import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as properLockfile from 'proper-lockfile';
import { FAISS_INDEX_PATH } from './config/paths.js';
import {
  KB_ASK_CACHE_DISK_MAX_BYTES,
  KB_ASK_CACHE_ENABLED,
} from './config/cache.js';
import { pathExists } from './file-utils.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// `kb ask` / `ask_knowledge` answer cache (#656).
//
// An opt-in, read-through cache for generated LLM answers. A repeated ask with
// the same normalized question, the same retrieved context, the same embedding
// model, and the same LLM profile returns the stored answer instead of
// re-invoking the (slow, sometimes paid) LLM. Invalidation is implicit: any
// change to the retrieved context (index change, re-rank, re-pack) yields a new
// fingerprint and therefore a cache miss.
//
// Storage and pruning follow the query-embedding-cache idioms (see
// src/query-cache.ts): atomic temp-file writes under a per-root lock, a JSON
// record validated by schema version, and an oldest-first disk-size cap.
// ---------------------------------------------------------------------------

export const ANSWER_CACHE_SCHEMA_VERSION = 'kb-answer-cache.v1';

export type AnswerCacheStatus = 'hit' | 'miss' | 'disabled';

/** One packed-context chunk reduced to its stable fingerprint inputs. */
export interface AnswerContextChunk {
  /** Stable chunk id when available, otherwise null. */
  chunk_id: string | null;
  /** sha256 of the exact snippet text sent to the LLM (captures truncation). */
  content_sha256: string;
}

export interface AnswerCacheKeyInput {
  /** Raw user question (normalized internally). */
  query: string;
  /** Active embedding model id used for retrieval. */
  embeddingModel: string;
  /** Resolved LLM profile name. */
  llmProfile: string;
  /** Resolved LLM endpoint. */
  llmEndpoint: string;
  /** Generation temperature passed to the LLM. */
  temperature: number;
  /** System prompt content sent to the LLM. */
  systemPrompt: string;
  /** Optional task-context block woven into the prompt. */
  taskContext?: string;
  /** Fingerprint of the packed retrieved context, in send order. */
  context: AnswerContextChunk[];
}

export interface AnswerCacheRecord {
  answer: string;
  model: string | null;
}

interface StoredAnswerRecord extends AnswerCacheRecord {
  schema_version: typeof ANSWER_CACHE_SCHEMA_VERSION;
  key: string;
  created_at: string;
}

export interface AnswerCacheOptions {
  indexPath?: string;
  enabled?: boolean;
  diskMaxBytes?: number;
}

export interface AnswerCacheStats {
  hits: number;
  misses: number;
  writes: number;
  corruptions: number;
  disk_size_bytes: number;
}

const ANSWER_CACHE_FILE_RE = /^[a-f0-9]{64}\.json$/;

export function normalizeAnswerCacheQuery(query: string): string {
  return query.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Reduce the packed snippets actually sent to the LLM to a stable, order-aware
 * fingerprint of (chunk id, content hash) pairs. Hashing the exact snippet text
 * captures truncation and injection-guard wrapping, so any change to what the
 * model sees forces a cache miss.
 */
export function fingerprintPackedSnippets(
  snippets: Array<{ chunkId: string | null; text: string }>,
): AnswerContextChunk[] {
  return snippets.map((snippet) => ({
    chunk_id: snippet.chunkId,
    content_sha256: sha256Hex(snippet.text),
  }));
}

/**
 * Compute the deterministic cache key. The key is a sha256 over a canonical
 * JSON encoding of every input that can change the answer: normalized query,
 * retrieved-context fingerprint, embedding model, LLM profile + endpoint,
 * temperature, system prompt, and task context. Conservative by design — when
 * in doubt the key changes and the cache simply misses.
 */
export function computeAnswerCacheKey(input: AnswerCacheKeyInput): string {
  const canonical = JSON.stringify({
    schema_version: ANSWER_CACHE_SCHEMA_VERSION,
    query: normalizeAnswerCacheQuery(input.query),
    embedding_model: input.embeddingModel,
    llm_profile: input.llmProfile,
    llm_endpoint: input.llmEndpoint,
    temperature: input.temperature,
    system_prompt: input.systemPrompt,
    task_context: input.taskContext?.trim() ?? null,
    context: input.context,
  });
  return sha256Hex(canonical);
}

export class AnswerCache {
  private readonly indexPath: string;
  readonly enabled: boolean;
  private readonly diskMaxBytes: number;
  private hits = 0;
  private misses = 0;
  private writes = 0;
  private corruptions = 0;

  constructor(options: AnswerCacheOptions = {}) {
    this.indexPath = options.indexPath ?? FAISS_INDEX_PATH;
    this.enabled = options.enabled ?? KB_ASK_CACHE_ENABLED;
    this.diskMaxBytes = options.diskMaxBytes ?? KB_ASK_CACHE_DISK_MAX_BYTES;
  }

  async get(key: string): Promise<AnswerCacheRecord | null> {
    if (!this.enabled) return null;
    const file = this.entryPath(key);
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        await this.recordCorrupt(file);
      }
      this.misses += 1;
      return null;
    }
    let record: StoredAnswerRecord;
    try {
      record = JSON.parse(raw) as StoredAnswerRecord;
    } catch {
      await this.recordCorrupt(file);
      this.misses += 1;
      return null;
    }
    if (
      record.schema_version !== ANSWER_CACHE_SCHEMA_VERSION ||
      record.key !== key ||
      typeof record.answer !== 'string'
    ) {
      await this.recordCorrupt(file);
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    // Best-effort LRU: touch mtime so the disk cap evicts least-recently-used.
    await fsp.utimes(file, new Date(), new Date()).catch(() => undefined);
    return {
      answer: record.answer,
      model: typeof record.model === 'string' ? record.model : null,
    };
  }

  async set(key: string, record: AnswerCacheRecord): Promise<void> {
    if (!this.enabled) return;
    const dir = this.cacheDir();
    let release: (() => Promise<void>) | null = null;
    const file = this.entryPath(key);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fsp.mkdir(dir, { recursive: true });
      release = await properLockfile.lock(dir, {
        lockfilePath: path.join(dir, '.kb-answer-cache.lock'),
        stale: 30_000,
        retries: { retries: 5, factor: 1.5, minTimeout: 25, maxTimeout: 250 },
      });
      const stored: StoredAnswerRecord = {
        schema_version: ANSWER_CACHE_SCHEMA_VERSION,
        key,
        answer: record.answer,
        model: record.model,
        created_at: new Date().toISOString(),
      };
      await fsp.writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`, 'utf-8');
      await fsp.rename(tmp, file);
      this.writes += 1;
      await this.enforceDiskLimit();
    } catch (err) {
      logger.warn(`answer cache write skipped: ${(err as Error).message}`);
    } finally {
      await fsp.unlink(tmp).catch(() => undefined);
      if (release !== null) {
        await release().catch((err) => {
          logger.warn(`answer cache lock release failed: ${(err as Error).message}`);
        });
      }
    }
  }

  async stats(): Promise<AnswerCacheStats> {
    return {
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
      corruptions: this.corruptions,
      disk_size_bytes: await answerCacheDiskSizeBytes(this.indexPath),
    };
  }

  private cacheDir(): string {
    return answerCacheDir(this.indexPath);
  }

  private entryPath(key: string): string {
    return path.join(this.cacheDir(), `${key}.json`);
  }

  private async recordCorrupt(file: string): Promise<void> {
    this.corruptions += 1;
    await fsp.unlink(file).catch(() => undefined);
  }

  private async enforceDiskLimit(): Promise<void> {
    if (this.diskMaxBytes <= 0) return;
    const files = await listAnswerCacheFiles(this.cacheDir());
    let total = files.reduce((sum, file) => sum + file.size, 0);
    if (total <= this.diskMaxBytes) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of files) {
      if (total <= this.diskMaxBytes) break;
      await fsp.unlink(file.path).catch(() => undefined);
      total -= file.size;
    }
  }
}

export function answerCacheDir(indexPath: string = FAISS_INDEX_PATH): string {
  return path.join(indexPath, 'cache', 'answers');
}

export async function answerCacheDiskSizeBytes(indexPath: string = FAISS_INDEX_PATH): Promise<number> {
  const files = await listAnswerCacheFiles(answerCacheDir(indexPath));
  return files.reduce((sum, file) => sum + file.size, 0);
}

export const defaultAnswerCache = new AnswerCache();

async function listAnswerCacheFiles(
  dir: string,
): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  if (!(await pathExists(dir))) return [];
  let entries: Array<import('fs').Dirent>;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !ANSWER_CACHE_FILE_RE.test(entry.name)) return;
    const child = path.join(dir, entry.name);
    try {
      const st = await fsp.stat(child);
      out.push({ path: child, size: st.size, mtimeMs: st.mtimeMs });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }));
  return out;
}
