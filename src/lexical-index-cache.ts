import * as fsp from 'fs/promises';
import { LexicalIndex, lexicalIndexFilePath } from './lexical-index.js';

interface LexicalIndexMetadata {
  exists: boolean;
  mtimeMs: number;
  size: number;
}

interface CacheEntry {
  index: LexicalIndex;
  metadata: LexicalIndexMetadata;
}

interface InFlightLoad {
  metadata: LexicalIndexMetadata;
  promise: Promise<LexicalIndex>;
  token: { valid: boolean };
}

export interface LexicalIndexCacheOptions {
  maxEntries?: number;
  loadIndex?: (kbName: string, kbPath: string) => Promise<LexicalIndex>;
}

type FsError = NodeJS.ErrnoException & { code?: string };

const DEFAULT_MAX_ENTRIES = 64;

export class LexicalIndexCache {
  private readonly maxEntries: number;
  private readonly loadIndex: (kbName: string, kbPath: string) => Promise<LexicalIndex>;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlightLoad>();

  constructor(options: LexicalIndexCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.loadIndex = options.loadIndex ?? LexicalIndex.load.bind(LexicalIndex);
  }

  async load(kbName: string, kbPath: string): Promise<LexicalIndex> {
    const key = this.cacheKey(kbName, kbPath);
    const metadata = await this.readMetadata(kbName);
    const cached = this.entries.get(key);
    if (cached && sameMetadata(cached.metadata, metadata)) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.index;
    }

    const pending = this.inFlight.get(key);
    if (pending && sameMetadata(pending.metadata, metadata)) {
      return pending.promise;
    }

    const token = { valid: true };
    const promise = this.loadStable(kbName, kbPath, key, metadata, token);
    this.inFlight.set(key, { metadata, promise, token });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(key)?.promise === promise) {
        this.inFlight.delete(key);
      }
    }
  }

  /** Load an uncached snapshot for refresh work that may mutate the index. */
  async loadFresh(kbName: string, kbPath: string): Promise<LexicalIndex> {
    return this.loadIndex(kbName, kbPath);
  }

  /** Drop a cached snapshot after a successful refresh has replaced its file. */
  invalidate(kbName: string, kbPath: string): void {
    const key = this.cacheKey(kbName, kbPath);
    this.entries.delete(key);
    const pending = this.inFlight.get(key);
    if (pending) {
      pending.token.valid = false;
      this.inFlight.delete(key);
    }
  }

  private async loadStable(
    kbName: string,
    kbPath: string,
    key: string,
    initialMetadata: LexicalIndexMetadata,
    token: { valid: boolean },
  ): Promise<LexicalIndex> {
    let metadata = initialMetadata;
    // Require the index file metadata to stay stable across parse. If a writer
    // swaps the file mid-load, retry against the new metadata and avoid
    // remembering an object whose parsed contents may not match the cache key.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const index = await this.loadIndex(kbName, kbPath);
      const afterLoad = await this.readMetadata(kbName);
      if (!token.valid) return this.load(kbName, kbPath);
      if (sameMetadata(metadata, afterLoad)) {
        this.remember(key, index, afterLoad);
        return index;
      }
      metadata = afterLoad;
    }

    const index = await this.loadIndex(kbName, kbPath);
    const finalMetadata = await this.readMetadata(kbName);
    if (!token.valid) return this.load(kbName, kbPath);
    if (sameMetadata(metadata, finalMetadata)) {
      this.remember(key, index, finalMetadata);
    }
    return index;
  }

  private remember(key: string, index: LexicalIndex, metadata: LexicalIndexMetadata): void {
    if (!metadata.exists || index.numFiles() === 0) return;
    this.entries.delete(key);
    this.entries.set(key, { index, metadata });
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  private async readMetadata(kbName: string): Promise<LexicalIndexMetadata> {
    try {
      const stat = await fsp.stat(lexicalIndexFilePath(kbName));
      return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch (error) {
      const code = (error as FsError | undefined)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { exists: false, mtimeMs: 0, size: 0 };
      }
      throw error;
    }
  }

  private cacheKey(kbName: string, kbPath: string): string {
    return `${kbName}\0${kbPath}`;
  }
}

function sameMetadata(a: LexicalIndexMetadata, b: LexicalIndexMetadata): boolean {
  return a.exists === b.exists && a.mtimeMs === b.mtimeMs && a.size === b.size;
}
