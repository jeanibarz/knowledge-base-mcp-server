import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  isChunkManifest,
  type ChunkManifest,
  type PendingChunkManifestWrite,
  type PendingSidecarWrite,
} from './file-ingest.js';
import { isPidAlive } from './process-liveness.js';

export const PENDING_SIDECAR_COMMIT_FILENAME = 'pending-manifest.json';
export const PENDING_SIDECAR_COMMIT_LEGACY_SCHEMA_VERSION = 'kb.pending-sidecar-commit.v1';
export const PENDING_SIDECAR_COMMIT_SCHEMA_VERSION = 'kb.pending-sidecar-commit.v2';

export type PendingSidecarCommitPhase = 'save-started' | 'save-complete';

export interface PendingSidecarCommitOwner {
  pid: number;
  hostname: string;
  started_at: string;
}

export interface PendingSidecarCommitManifest {
  schema_version:
    | typeof PENDING_SIDECAR_COMMIT_LEGACY_SCHEMA_VERSION
    | typeof PENDING_SIDECAR_COMMIT_SCHEMA_VERSION;
  /** Absent on v1 manifests written by older builds. */
  owner?: PendingSidecarCommitOwner;
  phase: PendingSidecarCommitPhase;
  pending_hash_writes: PendingSidecarWrite[];
  pending_chunk_manifest_writes: PendingChunkManifestWrite[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value);
}

function parsePendingHashWrite(value: unknown): PendingSidecarWrite | null {
  if (!isRecord(value)) return null;
  if (!isAbsolutePath(value.path) || !isSha256(value.hash)) return null;
  return { path: value.path, hash: value.hash };
}

function parseChunkManifest(value: unknown): ChunkManifest | null {
  return isChunkManifest(value) ? value : null;
}

function parsePendingChunkManifestWrite(value: unknown): PendingChunkManifestWrite | null {
  if (!isRecord(value)) return null;
  if (!isAbsolutePath(value.path)) return null;
  const manifest = parseChunkManifest(value.manifest);
  if (manifest === null) return null;
  return { path: value.path, manifest };
}

function parsePhase(value: unknown): PendingSidecarCommitPhase | null {
  if (value === 'save-started' || value === 'save-complete') return value;
  return null;
}

function parseOwner(value: unknown): PendingSidecarCommitOwner | null {
  if (!isRecord(value)) return null;
  if (!Number.isInteger(value.pid) || (value.pid as number) <= 0) return null;
  if (typeof value.hostname !== 'string' || value.hostname.length === 0) return null;
  if (typeof value.started_at !== 'string' || value.started_at.length === 0) return null;
  return {
    pid: value.pid as number,
    hostname: value.hostname,
    started_at: value.started_at,
  };
}

export function pendingSidecarCommitManifestPath(modelDir: string): string {
  return path.join(modelDir, PENDING_SIDECAR_COMMIT_FILENAME);
}

export async function readPendingSidecarCommitManifest(
  modelDir: string,
): Promise<PendingSidecarCommitManifest | null> {
  const manifestPath = pendingSidecarCommitManifestPath(modelDir);
  let raw: string;
  try {
    raw = await fsp.readFile(manifestPath, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const isLegacySchema = parsed.schema_version === PENDING_SIDECAR_COMMIT_LEGACY_SCHEMA_VERSION;
  const isCurrentSchema = parsed.schema_version === PENDING_SIDECAR_COMMIT_SCHEMA_VERSION;
  if (!isLegacySchema && !isCurrentSchema) return null;
  const phase = parsePhase(parsed.phase);
  if (phase === null) return null;
  if (!Array.isArray(parsed.pending_hash_writes)) return null;
  if (!Array.isArray(parsed.pending_chunk_manifest_writes)) return null;

  const pendingHashWrites = parsed.pending_hash_writes.map(parsePendingHashWrite);
  const pendingChunkManifestWrites =
    parsed.pending_chunk_manifest_writes.map(parsePendingChunkManifestWrite);
  if (
    pendingHashWrites.some((entry) => entry === null) ||
    pendingChunkManifestWrites.some((entry) => entry === null)
  ) {
    return null;
  }

  const owner = isCurrentSchema ? parseOwner(parsed.owner) ?? undefined : undefined;
  const schemaVersion = isLegacySchema
    ? PENDING_SIDECAR_COMMIT_LEGACY_SCHEMA_VERSION
    : PENDING_SIDECAR_COMMIT_SCHEMA_VERSION;
  return {
    schema_version: schemaVersion,
    ...(owner === undefined ? {} : { owner }),
    phase,
    pending_hash_writes: pendingHashWrites as PendingSidecarWrite[],
    pending_chunk_manifest_writes: pendingChunkManifestWrites as PendingChunkManifestWrite[],
  };
}

export function createPendingSidecarCommitOwner(): PendingSidecarCommitOwner {
  return {
    pid: process.pid,
    hostname: os.hostname(),
    started_at: new Date().toISOString(),
  };
}

export function isPendingSidecarCommitOwnerAlive(
  owner: PendingSidecarCommitOwner,
): boolean {
  return owner.hostname === os.hostname() && isPidAlive(owner.pid);
}

export async function writePendingSidecarCommitManifest(options: {
  modelDir: string;
  phase: PendingSidecarCommitPhase;
  pendingHashWrites: ReadonlyArray<PendingSidecarWrite>;
  pendingChunkManifestWrites: ReadonlyArray<PendingChunkManifestWrite>;
  owner?: PendingSidecarCommitOwner;
}): Promise<void> {
  const {
    modelDir,
    phase,
    pendingHashWrites,
    pendingChunkManifestWrites,
    owner = createPendingSidecarCommitOwner(),
  } = options;
  await fsp.mkdir(modelDir, { recursive: true });
  const manifestPath = pendingSidecarCommitManifestPath(modelDir);
  const tmpPath = path.join(
    modelDir,
    `.${PENDING_SIDECAR_COMMIT_FILENAME}.${process.pid}.${process.hrtime.bigint()}.tmp`,
  );
  const payload: PendingSidecarCommitManifest = {
    schema_version: PENDING_SIDECAR_COMMIT_SCHEMA_VERSION,
    owner,
    phase,
    pending_hash_writes: pendingHashWrites.map((entry) => ({ ...entry })),
    pending_chunk_manifest_writes: pendingChunkManifestWrites.map((entry) => ({
      path: entry.path,
      manifest: entry.manifest,
    })),
  };

  try {
    await fsp.writeFile(tmpPath, JSON.stringify(payload), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await fsp.rename(tmpPath, manifestPath);
  } catch (error) {
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function clearPendingSidecarCommitManifest(modelDir: string): Promise<void> {
  await fsp.rm(pendingSidecarCommitManifestPath(modelDir), { force: true });
}
