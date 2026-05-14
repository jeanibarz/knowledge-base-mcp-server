import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  INGEST_EXCLUDE_PATHS,
  INGEST_EXTRA_EXTENSIONS,
  KNOWLEDGE_BASES_ROOT_DIR,
} from './config.js';
import { INGEST_BASE_EXTENSIONS } from './ingest-filter.js';
import { enumerateIngestableKbFiles, listKnowledgeBases } from './kb-fs.js';

export const FRESHNESS_MANIFEST_SCHEMA_VERSION = 'kb.freshness-manifest.v1';
export const FRESHNESS_MANIFEST_FILE = 'freshness.json';

export interface FreshnessManifestFilterConfig {
  baseExtensions?: readonly string[];
  extraExtensions: readonly string[];
  excludePaths: readonly string[];
}

export interface FreshnessManifestKbEntry {
  file_count: number;
  sidecar_count: number;
  modified_files: number;
  new_files: number;
  last_scan_at: string;
}

export interface FreshnessManifest {
  schema_version: typeof FRESHNESS_MANIFEST_SCHEMA_VERSION;
  model_id: string;
  kb_root: string;
  index_mtime: string;
  index_mtime_ms: number;
  filter_hash: string;
  filter: {
    base_extensions: string[];
    extra_extensions: string[];
    exclude_paths: string[];
  };
  complete: boolean;
  kbs: Record<string, FreshnessManifestKbEntry>;
}

export interface WriteFreshnessManifestInput {
  modelId: string;
  modelDir: string;
  indexMtimeMs: number;
  kbRootDir?: string;
  filterConfig?: FreshnessManifestFilterConfig;
  now?: Date;
}

export interface ReadFreshnessManifestInput {
  modelId: string;
  modelDir: string;
  indexMtimeMs: number;
  kbRootDir?: string;
  filterConfig?: FreshnessManifestFilterConfig;
}

export function freshnessManifestPath(modelDir: string): string {
  return path.join(modelDir, FRESHNESS_MANIFEST_FILE);
}

export function computeFreshnessManifestFilterHash(
  config: FreshnessManifestFilterConfig = defaultFilterConfig(),
): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(normalizeFilterConfig(config)))
    .digest('hex');
}

export async function writeFreshnessManifest(
  input: WriteFreshnessManifestInput,
): Promise<FreshnessManifest> {
  const kbRootDir = input.kbRootDir ?? KNOWLEDGE_BASES_ROOT_DIR;
  const filterConfig = input.filterConfig ?? defaultFilterConfig();
  const normalizedFilter = normalizeFilterConfig(filterConfig);
  const filterHash = computeFreshnessManifestFilterHash(filterConfig);
  const indexMtime = new Date(input.indexMtimeMs).toISOString();
  const scanTime = (input.now ?? new Date()).toISOString();
  const kbs = await listKnowledgeBases(kbRootDir);
  const enumerations = await enumerateIngestableKbFiles(kbRootDir, kbs, {
    extraExtensions: normalizedFilter.extraExtensions,
    excludePaths: normalizedFilter.excludePaths,
  });
  const entries: Record<string, FreshnessManifestKbEntry> = {};

  for (const { kbName, kbPath, filePaths } of enumerations) {
    let modifiedFiles = 0;
    for (const filePath of filePaths) {
      try {
        const st = await fsp.stat(filePath);
        if (st.mtimeMs > input.indexMtimeMs) modifiedFiles += 1;
      } catch {
        // File vanished between enumeration and stat; ignore it.
      }
    }
    const sidecarCount = await countSidecarFiles(path.join(kbPath, '.index'));
    entries[kbName] = {
      file_count: filePaths.length,
      sidecar_count: sidecarCount,
      modified_files: modifiedFiles,
      new_files: Math.max(0, filePaths.length - sidecarCount),
      last_scan_at: scanTime,
    };
  }

  const manifest: FreshnessManifest = {
    schema_version: FRESHNESS_MANIFEST_SCHEMA_VERSION,
    model_id: input.modelId,
    kb_root: kbRootDir,
    index_mtime: indexMtime,
    index_mtime_ms: input.indexMtimeMs,
    filter_hash: filterHash,
    filter: {
      base_extensions: [...normalizedFilter.baseExtensions],
      extra_extensions: [...normalizedFilter.extraExtensions],
      exclude_paths: [...normalizedFilter.excludePaths],
    },
    complete: true,
    kbs: entries,
  };

  await writeJsonAtomic(freshnessManifestPath(input.modelDir), manifest);
  return manifest;
}

export async function readFreshnessManifest(
  input: ReadFreshnessManifestInput,
): Promise<FreshnessManifest | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(freshnessManifestPath(input.modelDir), 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isFreshnessManifest(parsed)) return null;

  const kbRootDir = input.kbRootDir ?? KNOWLEDGE_BASES_ROOT_DIR;
  const expectedFilterHash = computeFreshnessManifestFilterHash(
    input.filterConfig ?? defaultFilterConfig(),
  );
  if (parsed.model_id !== input.modelId) return null;
  if (parsed.kb_root !== kbRootDir) return null;
  if (parsed.filter_hash !== expectedFilterHash) return null;
  if (Math.abs(parsed.index_mtime_ms - input.indexMtimeMs) >= 1) return null;
  return parsed;
}

export async function countSidecarFiles(dir: string): Promise<number> {
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

function defaultFilterConfig(): FreshnessManifestFilterConfig {
  return {
    baseExtensions: INGEST_BASE_EXTENSIONS,
    extraExtensions: INGEST_EXTRA_EXTENSIONS,
    excludePaths: INGEST_EXCLUDE_PATHS,
  };
}

function normalizeFilterConfig(
  config: FreshnessManifestFilterConfig,
): { baseExtensions: string[]; extraExtensions: string[]; excludePaths: string[] } {
  return {
    baseExtensions: [...(config.baseExtensions ?? INGEST_BASE_EXTENSIONS)],
    extraExtensions: [...config.extraExtensions],
    excludePaths: [...config.excludePaths],
  };
}

function isFreshnessManifest(value: unknown): value is FreshnessManifest {
  if (!isRecord(value)) return false;
  if (value.schema_version !== FRESHNESS_MANIFEST_SCHEMA_VERSION) return false;
  if (typeof value.model_id !== 'string') return false;
  if (typeof value.kb_root !== 'string') return false;
  if (typeof value.index_mtime !== 'string') return false;
  if (typeof value.index_mtime_ms !== 'number') return false;
  if (typeof value.filter_hash !== 'string') return false;
  if (!isRecord(value.filter)) return false;
  if (!isStringArray(value.filter.base_extensions)) return false;
  if (!isStringArray(value.filter.extra_extensions)) return false;
  if (!isStringArray(value.filter.exclude_paths)) return false;
  if (value.complete !== true) return false;
  if (!isRecord(value.kbs)) return false;
  return Object.values(value.kbs).every(isFreshnessManifestKbEntry);
}

function isFreshnessManifestKbEntry(value: unknown): value is FreshnessManifestKbEntry {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInteger(value.file_count) &&
    isNonNegativeInteger(value.sidecar_count) &&
    isNonNegativeInteger(value.modified_files) &&
    isNonNegativeInteger(value.new_files) &&
    typeof value.last_scan_at === 'string'
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  await fsp.rename(tmpPath, targetPath);
}
