// RFC 013 §4.7 — sole owner of the `models/<id>/` directory schema and
// active-model resolution. Encapsulates:
//
//   - Path computation (modelDir, faissIndexBinaryPath, modelNameFile).
//   - Active-model resolution: explicit arg > KB_ACTIVE_MODEL env > active.txt > legacy env-var fallback.
//   - Single-writer atomic writer for active.txt (only callers: bootstrapLayout, cli-models.setActive, cli-models.add (when absent)).
//   - Registration predicate: `isRegisteredModel(modelId)` enforces "models/<id>/ exists, has model_name.txt, no .adding sentinel."
//
// CLI and MCP both import from this module; two implementations of active
// resolution are forbidden (RFC 012 round-2 N5 was that exact drift bug).

import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  FAISS_INDEX_PATH,
} from './config/paths.js';
import {
  EMBEDDING_PROVIDER,
  HUGGINGFACE_MODEL_NAME,
  KB_ACTIVE_MODEL,
  OLLAMA_MODEL,
  OPENAI_MODEL_NAME,
} from './config/provider.js';
import { pathExists, writeFileAtomicDurable } from './file-utils.js';
import { deriveModelId, EmbeddingProvider, isValidModelId, parseModelId } from './model-id.js';
import { logger } from './logger.js';
import {
  parseIndexVersionDirName,
  resolveIndexVersionRetention,
} from './faiss-store-layout.js';
import { resolveIndexType, type SearchIndexType } from './config/indexing.js';

const ACTIVE_FILE = path.join(FAISS_INDEX_PATH, 'active.txt');
const MODELS_DIR = path.join(FAISS_INDEX_PATH, 'models');

// ---------------------------------------------------------------------------
// Path schema — single source of truth for `models/<id>/` layout.
// ---------------------------------------------------------------------------

export function modelsRoot(): string {
  return MODELS_DIR;
}

export function activeModelFilePath(): string {
  return ACTIVE_FILE;
}

export function modelDir(modelId: string): string {
  if (!isValidModelId(modelId)) {
    // Hard fail BEFORE path.join — round-1 failure F12 (path-traversal).
    throw parseModelId.bind(null, modelId).call(null) as never;
  }
  return path.join(MODELS_DIR, modelId);
}

export function faissIndexBinaryPath(modelId: string): string {
  // The inner binary file inside `${PATH}/models/<id>/faiss.index/` — legacy
  // pre-RFC-014 layout. Used for staleness mtime detection on models that
  // have not yet been written under v014. New consumers should prefer
  // `resolveFaissIndexBinaryPath` which handles both layouts.
  return path.join(modelDir(modelId), 'faiss.index', 'faiss.index');
}

/**
 * RFC 014 — return the path to the FAISS binary file for staleness checks,
 * preferring the versioned layout (`index → index.vN/faiss.index`) when
 * present and falling back to the legacy path. Returns null if neither
 * layout has data.
 *
 * Async because we follow the symlink with `realpath` to get a stable path
 * (the returned string is what `fs.stat` should target). A concurrent symlink
 * swap after this call returns is harmless — the caller stat's a path that
 * was valid at resolve time.
 */
export async function resolveFaissIndexBinaryPath(modelId: string): Promise<string | null> {
  const dir = modelDir(modelId);
  const symlinkPath = path.join(dir, 'index');
  // lstat-guard before realpath: if `index` exists as something OTHER than a
  // symlink (operator surgery — replaced symlink with a regular file or
  // directory), realpath would still return its absolute path but the
  // returned faiss.index inside it likely doesn't exist. Fall back to
  // legacy in that case rather than returning a doomed path.
  try {
    const st = await fsp.lstat(symlinkPath);
    if (st.isSymbolicLink()) {
      const resolved = await fsp.realpath(symlinkPath);
      return path.join(resolved, 'faiss.index');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const legacy = path.join(dir, 'faiss.index', 'faiss.index');
  return (await pathExists(legacy)) ? legacy : null;
}

export interface ModelIndexVersionStorage {
  version: string;
  bytes: number;
  active: boolean;
}

export interface ModelIndexStorageSummary {
  active_version: string | null;
  retention_previous_versions: number;
  version_count: number;
  total_version_bytes: number;
  active_version_bytes: number | null;
  inactive_version_count: number;
  inactive_version_bytes: number;
  versions: ModelIndexVersionStorage[];
}

export async function readModelIndexStorage(
  modelId: string,
): Promise<ModelIndexStorageSummary> {
  const dir = modelDir(modelId);
  let activeVersion: string | null = null;
  try {
    const st = await fsp.lstat(path.join(dir, 'index'));
    if (st.isSymbolicLink()) {
      activeVersion = await fsp.readlink(path.join(dir, 'index'));
      if (parseIndexVersionDirName(activeVersion) === null) activeVersion = null;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    entries = [];
  }
  const versions: ModelIndexVersionStorage[] = [];
  for (const entry of entries) {
    if (parseIndexVersionDirName(entry) === null) continue;
    versions.push({
      version: entry,
      bytes: await directorySizeBytes(path.join(dir, entry)),
      active: entry === activeVersion,
    });
  }
  versions.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  const totalVersionBytes = versions.reduce((sum, v) => sum + v.bytes, 0);
  const activeVersionBytes = versions.find((v) => v.active)?.bytes ?? null;
  const inactiveVersionBytes = versions
    .filter((v) => !v.active)
    .reduce((sum, v) => sum + v.bytes, 0);
  return {
    active_version: activeVersion,
    retention_previous_versions: resolveIndexVersionRetention(),
    version_count: versions.length,
    total_version_bytes: totalVersionBytes,
    active_version_bytes: activeVersionBytes,
    inactive_version_count: versions.filter((v) => !v.active).length,
    inactive_version_bytes: inactiveVersionBytes,
    versions,
  };
}

async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: Array<import('fs').Dirent>;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 0;
    throw err;
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(child);
    } else if (entry.isFile()) {
      try {
        total += (await fsp.stat(child)).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  }
  return total;
}

export function modelNameFilePath(modelId: string): string {
  return path.join(modelDir(modelId), 'model_name.txt');
}

export function indexTypeFilePath(modelId: string): string {
  return path.join(modelDir(modelId), 'index-type.txt');
}

export function addingSentinelPath(modelId: string): string {
  return path.join(modelDir(modelId), '.adding');
}

// ---------------------------------------------------------------------------
// `.adding` sentinel — structured metadata with PID-only backward compatibility.
// ---------------------------------------------------------------------------

export const ADDING_SENTINEL_SCHEMA_VERSION = 'kb.model-adding.v1';

export interface AddingSentinelMetadata {
  schema_version: typeof ADDING_SENTINEL_SCHEMA_VERSION;
  model_id: string;
  provider: EmbeddingProvider;
  model_name: string;
  pid: number;
  started_at: string;
}

export type AddingSentinelReadResult =
  | { kind: 'missing' }
  | { kind: 'legacy-pid'; pid: number; raw: string }
  | { kind: 'metadata'; metadata: AddingSentinelMetadata; raw: string }
  | { kind: 'unknown'; raw: string; detail: string };

export type IncompleteModelStatus = 'in_progress' | 'stale_interrupted' | 'unknown';

export interface IncompleteModelState {
  model_id: string;
  status: IncompleteModelStatus;
  detail: string;
  pid: number | null;
  provider: string | null;
  model_name: string | null;
  started_at: string | null;
  recovery_command: string | null;
}

type PidLivenessCheck = (pid: number) => boolean;

export function buildAddingSentinelMetadata(args: {
  modelId: string;
  provider: EmbeddingProvider;
  modelName: string;
  pid?: number;
  startedAt?: Date;
}): AddingSentinelMetadata {
  return {
    schema_version: ADDING_SENTINEL_SCHEMA_VERSION,
    model_id: args.modelId,
    provider: args.provider,
    model_name: args.modelName,
    pid: args.pid ?? process.pid,
    started_at: (args.startedAt ?? new Date()).toISOString(),
  };
}

export async function writeAddingSentinel(metadata: AddingSentinelMetadata): Promise<void> {
  await fsp.writeFile(
    addingSentinelPath(metadata.model_id),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf-8',
  );
}

export async function readAddingSentinel(modelId: string): Promise<AddingSentinelReadResult> {
  let raw: string;
  try {
    raw = await fsp.readFile(addingSentinelPath(modelId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }

  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const pid = Number(trimmed);
    if (Number.isSafeInteger(pid) && pid > 0) {
      return { kind: 'legacy-pid', pid, raw };
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'unknown', raw, detail: 'sentinel is neither PID-only text nor valid JSON metadata' };
  }

  if (!isAddingSentinelMetadata(parsed)) {
    return { kind: 'unknown', raw, detail: 'sentinel JSON does not match kb.model-adding.v1 metadata' };
  }
  if (parsed.model_id !== modelId) {
    return {
      kind: 'unknown',
      raw,
      detail: `sentinel model_id "${parsed.model_id}" does not match directory "${modelId}"`,
    };
  }
  return { kind: 'metadata', metadata: parsed, raw };
}

export async function classifyIncompleteModelState(
  modelId: string,
  pidIsLive: PidLivenessCheck = isPidLive,
): Promise<IncompleteModelState | null> {
  if (!isValidModelId(modelId)) return null;
  const dir = modelDir(modelId);
  try {
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  const sentinel = await readAddingSentinel(modelId);
  if (sentinel.kind === 'metadata' || sentinel.kind === 'legacy-pid') {
    const pid = sentinel.kind === 'metadata' ? sentinel.metadata.pid : sentinel.pid;
    const provider = sentinel.kind === 'metadata' ? sentinel.metadata.provider : parseModelId(modelId).provider;
    const modelName = sentinel.kind === 'metadata' ? sentinel.metadata.model_name : await readStoredModelName(modelId);
    const startedAt = sentinel.kind === 'metadata' ? sentinel.metadata.started_at : null;
    if (pidIsLive(pid)) {
      return {
        model_id: modelId,
        status: 'in_progress',
        detail: `kb models add is still running with pid ${pid}`,
        pid,
        provider,
        model_name: modelName,
        started_at: startedAt,
        recovery_command: null,
      };
    }
    return {
      model_id: modelId,
      status: 'stale_interrupted',
      detail: `previous kb models add writer pid ${pid} is no longer running`,
      pid,
      provider,
      model_name: modelName,
      started_at: startedAt,
      recovery_command: modelName === null ? null : `kb models add ${provider} ${modelName} --recover --yes`,
    };
  }

  if (sentinel.kind === 'unknown') {
    return {
      model_id: modelId,
      status: 'unknown',
      detail: sentinel.detail,
      pid: null,
      provider: null,
      model_name: null,
      started_at: null,
      recovery_command: null,
    };
  }

  if (await isRegisteredModel(modelId)) return null;
  return {
    model_id: modelId,
    status: 'unknown',
    detail: 'model directory is incomplete and has no .adding sentinel',
    pid: null,
    provider: null,
    model_name: await readStoredModelName(modelId),
    started_at: null,
    recovery_command: null,
  };
}

export async function listIncompleteModelStates(): Promise<IncompleteModelState[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(MODELS_DIR);
  } catch {
    return [];
  }
  const states: IncompleteModelState[] = [];
  for (const entry of entries) {
    if (!isValidModelId(entry)) continue;
    const state = await classifyIncompleteModelState(entry);
    if (state !== null) states.push(state);
  }
  return states.sort((a, b) => a.model_id.localeCompare(b.model_id));
}

function isAddingSentinelMetadata(value: unknown): value is AddingSentinelMetadata {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<AddingSentinelMetadata>;
  return candidate.schema_version === ADDING_SENTINEL_SCHEMA_VERSION
    && typeof candidate.model_id === 'string'
    && isValidModelId(candidate.model_id)
    && isEmbeddingProvider(candidate.provider)
    && typeof candidate.model_name === 'string'
    && candidate.model_name.trim().length > 0
    && Number.isSafeInteger(candidate.pid)
    && typeof candidate.pid === 'number'
    && candidate.pid > 0
    && typeof candidate.started_at === 'string'
    && !Number.isNaN(Date.parse(candidate.started_at));
}

function isEmbeddingProvider(value: unknown): value is EmbeddingProvider {
  return value === 'ollama' || value === 'openai' || value === 'huggingface';
}

function isPidLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// Read helpers.
// ---------------------------------------------------------------------------

/** Read the model name recorded for `modelId`. Returns null when absent. */
export async function readStoredModelName(modelId: string): Promise<string | null> {
  try {
    return (await fsp.readFile(modelNameFilePath(modelId), 'utf-8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function readStoredIndexType(modelId: string): Promise<SearchIndexType> {
  try {
    return resolveIndexType(await fsp.readFile(indexTypeFilePath(modelId), 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'flat';
    throw err;
  }
}

export async function writeIndexTypeAtomic(modelId: string, indexType: SearchIndexType): Promise<void> {
  const target = indexTypeFilePath(modelId);
  await writeFileAtomicDurable(target, `${indexType}\n`);
}

/**
 * A model is REGISTERED iff: (1) `models/<id>/` exists, (2) `model_name.txt`
 * is present (proves the directory is not just an empty `mkdir`), (3) NO
 * `.adding` sentinel (prevents adopting a half-built model from an interrupted
 * `kb models add`). Single-source predicate for `kb models list`,
 * `list_models` MCP tool, `resolveActiveModel`, and migration scans.
 */
export async function isRegisteredModel(modelId: string): Promise<boolean> {
  if (!isValidModelId(modelId)) return false;
  const dir = modelDir(modelId);
  try {
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) return false;
  } catch {
    return false;
  }
  // Has model_name.txt?
  if (!(await pathExists(modelNameFilePath(modelId)))) return false;
  // No .adding sentinel? (exists → mid-add → not registered)
  return !(await pathExists(addingSentinelPath(modelId)));
}

export interface RegisteredModel {
  model_id: string;
  provider: string;
  model_name: string;
  /**
   * RFC 014 — true when this model has both the new versioned layout
   * (`index → index.vN/`) AND the legacy `faiss.index/` directory present.
   * Downgrading the npm package would silently ignore embeddings added
   * since the upgrade. Surfaced by `kb models list` and the `list_models`
   * MCP tool. Derived directly from filesystem state on every call (no
   * marker file): operator interventions like `rm -rf faiss.index/` are
   * reflected immediately on the next `kb models list`.
   */
  downgrade_hazard?: boolean;
}

export async function listRegisteredModels(): Promise<RegisteredModel[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(MODELS_DIR);
  } catch {
    return [];
  }
  const models: RegisteredModel[] = [];
  for (const entry of entries) {
    if (!isValidModelId(entry)) continue;
    if (!(await isRegisteredModel(entry))) continue;
    const modelName = (await readStoredModelName(entry)) ?? entry;
    const { provider } = parseModelId(entry);
    const downgradeHazard = await detectDowngradeHazard(modelDir(entry));
    models.push({
      model_id: entry,
      provider,
      model_name: modelName,
      ...(downgradeHazard ? { downgrade_hazard: true } : {}),
    });
  }
  return models.sort((a, b) => a.model_id.localeCompare(b.model_id));
}

/**
 * RFC 014 — derive the downgrade-hazard signal directly from on-disk
 * layout: hazard exists iff the model has BOTH the versioned `index`
 * symlink AND the legacy `faiss.index/` directory. No marker file: the
 * filesystem is the single source of truth, and stale state can't drift.
 */
async function detectDowngradeHazard(dir: string): Promise<boolean> {
  let hasVersioned = false;
  try {
    const st = await fsp.lstat(path.join(dir, 'index'));
    hasVersioned = st.isSymbolicLink();
  } catch {
    // index symlink absent — versioned layout not present yet
  }
  if (!hasVersioned) return false;
  return pathExists(path.join(dir, 'faiss.index'));
}

// ---------------------------------------------------------------------------
// active.txt — atomic writer (single-writer invariant), robust reader.
// ---------------------------------------------------------------------------

/**
 * Atomic write of active.txt via tmp+rename. THREE permitted callers, asserted
 * by a grep-based Jest test:
 *   1. `FaissIndexManager.bootstrapLayout` — when migrating 0.2.x layout.
 *   2. `cli-models.ts:setActive` — explicit operator command.
 *   3. `cli-models.ts:add` — only when active.txt is absent (fresh-install).
 *
 * `updateIndex`, the trigger watcher, and `kb models remove` MUST NOT call.
 */
export async function writeActiveModelAtomic(modelId: string): Promise<void> {
  if (!isValidModelId(modelId)) {
    throw new Error(`Refusing to write invalid model_id "${modelId}" to active.txt`);
  }
  await fsp.mkdir(FAISS_INDEX_PATH, { recursive: true });
  await writeFileAtomicDurable(ACTIVE_FILE, modelId);
}

export async function activeFileExists(): Promise<boolean> {
  return pathExists(ACTIVE_FILE);
}

interface ActiveReadResult {
  kind: 'absent' | 'empty' | 'malformed' | 'valid';
  modelId?: string;
  rawHex?: string;
}

async function readActiveRaw(): Promise<ActiveReadResult> {
  let raw: string;
  try {
    raw = await fsp.readFile(ACTIVE_FILE, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    throw err;
  }
  // Strip BOM (round-1 failure F3) — Windows editors prepend EF BB BF.
  let bytes = raw;
  if (bytes.charCodeAt(0) === 0xfeff) bytes = bytes.slice(1);
  // Strip CRLF artifacts (round-1 failure F2/F3).
  const trimmed = bytes.replace(/\r/g, '').trim();
  if (trimmed === '') return { kind: 'empty' };
  if (!isValidModelId(trimmed)) {
    // Hex-dump the original bytes (length-bounded) for the operator's debug.
    const buf = Buffer.from(raw, 'utf-8').subarray(0, 256);
    return { kind: 'malformed', rawHex: buf.toString('hex') };
  }
  return { kind: 'valid', modelId: trimmed };
}

// ---------------------------------------------------------------------------
// Active-model resolution.
// ---------------------------------------------------------------------------

export class ActiveModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActiveModelResolutionError';
  }
}

export interface ResolveOptions {
  /** Explicit per-call override: CLI `--model=<id>` or MCP `args.model_name`. */
  explicitOverride?: string;
}

/**
 * Resolve the active model_id. Precedence (RFC 013 §4.7):
 *   1. opts.explicitOverride (validate slug + registered).
 *   2. KB_ACTIVE_MODEL env (validate slug + registered).
 *   3. active.txt (robust read; HARD-FAIL on regex-fail per round-2 failure N3).
 *   4. Legacy env-var fallback (EMBEDDING_PROVIDER + model env).
 *
 * Throws ActiveModelResolutionError with a clear, operator-actionable message
 * on any failure path. Callers convert to exit-2 (CLI) or `isError: true` (MCP).
 */
export async function resolveActiveModel(opts: ResolveOptions = {}): Promise<string> {
  // Step 1: explicit per-call override.
  if (opts.explicitOverride !== undefined && opts.explicitOverride !== '') {
    const id = opts.explicitOverride;
    if (!isValidModelId(id)) {
      throw new ActiveModelResolutionError(
        `Invalid --model / model_name argument "${id}". ` +
        `Expected a model_id matching ^[a-z]+__[A-Za-z0-9._-]+$ (e.g. ollama__nomic-embed-text-latest).`,
      );
    }
    if (!(await isRegisteredModel(id))) {
      const available = (await listRegisteredModels()).map((m) => m.model_id).join(', ') || '<none>';
      throw new ActiveModelResolutionError(
        `Model "${id}" is not registered. Registered: ${available}. ` +
        (await unregisteredModelHint(id)),
      );
    }
    return id;
  }

  // Step 2: KB_ACTIVE_MODEL env.
  if (KB_ACTIVE_MODEL && KB_ACTIVE_MODEL !== '') {
    const id = KB_ACTIVE_MODEL;
    if (!isValidModelId(id)) {
      throw new ActiveModelResolutionError(
        `KB_ACTIVE_MODEL env value "${id}" is not a valid model_id. ` +
        `Expected ^[a-z]+__[A-Za-z0-9._-]+$.`,
      );
    }
    if (!(await isRegisteredModel(id))) {
      const available = (await listRegisteredModels()).map((m) => m.model_id).join(', ') || '<none>';
      throw new ActiveModelResolutionError(
        `KB_ACTIVE_MODEL="${id}" is not registered. Registered: ${available}. ` +
        (await unregisteredModelHint(id)),
      );
    }
    return id;
  }

  // Step 3: active.txt (HARD-FAIL on regex-fail; fall through on absent/empty).
  const r = await readActiveRaw();
  if (r.kind === 'malformed') {
    const envFallback = computeLegacyEnvDerivedId();
    throw new ActiveModelResolutionError(
      `active.txt is malformed. Found bytes (hex): ${r.rawHex}. ` +
      `Either edit it to a registered model_id (run \`kb models list\`), ` +
      `or delete it to fall back to env-var resolution (would resolve to "${envFallback}").`,
    );
  }
  if (r.kind === 'valid') {
    if (!(await isRegisteredModel(r.modelId!))) {
      throw new ActiveModelResolutionError(
        `active.txt names model "${r.modelId}" but it is not registered on disk. ` +
        `Run \`kb models set-active <other>\` to point at a registered model. ` +
        (await unregisteredModelHint(r.modelId!)),
      );
    }
    return r.modelId!;
  }

  // Step 4: legacy env-var fallback.
  const envId = computeLegacyEnvDerivedId();
  if (!(await isRegisteredModel(envId))) {
    const available = (await listRegisteredModels()).map((m) => m.model_id).join(', ') || '<none>';
    throw new ActiveModelResolutionError(
      `No model registered. Run \`kb models add <provider> <model>\` first. ` +
      `Env-derived candidate: "${envId}". Registered: ${available}.`,
    );
  }
  return envId;
}

async function unregisteredModelHint(modelId: string): Promise<string> {
  const incomplete = await classifyIncompleteModelState(modelId);
  if (incomplete === null) {
    return 'Run `kb models add <provider> <model>` to register it first.';
  }
  if (incomplete.status === 'in_progress') {
    return `A \`kb models add\` is still in progress for this model (${incomplete.detail}); wait for it to finish.`;
  }
  if (incomplete.status === 'stale_interrupted' && incomplete.recovery_command !== null) {
    return `A previous \`kb models add\` appears stale/interrupted (${incomplete.detail}); run \`${incomplete.recovery_command}\` to clean up and retry.`;
  }
  return `Incomplete model state exists but is not safe to recover automatically (${incomplete.detail}); inspect ${modelDir(modelId)}.`;
}

export interface LegacyEnvModelSpec {
  provider: EmbeddingProvider;
  modelName: string;
  modelId: string;
}

/**
 * Resolve the env-var-derived legacy model without registration check.
 *
 * This is the sole owner for the legacy env fallback mapping. Keep it here so
 * `computeLegacyEnvDerivedId()` and backwards-compatible no-arg manager
 * construction cannot drift.
 */
export function computeLegacyEnvModelSpec(): LegacyEnvModelSpec {
  const provider = (EMBEDDING_PROVIDER as EmbeddingProvider) ?? 'huggingface';
  let modelName: string;
  switch (provider) {
    case 'ollama':
      modelName = OLLAMA_MODEL;
      break;
    case 'openai':
      modelName = OPENAI_MODEL_NAME;
      break;
    default:
      modelName = HUGGINGFACE_MODEL_NAME;
      break;
  }
  const modelId = deriveModelId(provider, modelName);
  const parsed = parseModelId(modelId);
  return {
    provider: parsed.provider as EmbeddingProvider,
    modelName,
    modelId,
  };
}

/** Resolve the env-var-derived candidate id without registration check. */
export function computeLegacyEnvDerivedId(): string {
  return computeLegacyEnvModelSpec().modelId;
}

// Re-export for callers that need it from one place.
export { deriveModelId, parseModelId, isValidModelId } from './model-id.js';
