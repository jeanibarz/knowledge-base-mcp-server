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
  EMBEDDING_PROVIDER,
  FAISS_INDEX_PATH,
  HUGGINGFACE_MODEL_NAME,
  KB_ACTIVE_MODEL,
  OLLAMA_MODEL,
  OPENAI_MODEL_NAME,
} from './config.js';
import { deriveModelId, EmbeddingProvider, isValidModelId, parseModelId } from './model-id.js';
import { logger } from './logger.js';

const ACTIVE_FILE = path.join(FAISS_INDEX_PATH, 'active.txt');
const MODELS_DIR = path.join(FAISS_INDEX_PATH, 'models');

// ---------------------------------------------------------------------------
// Path schema — single source of truth for `models/<id>/` layout.
// ---------------------------------------------------------------------------

export function modelsRoot(): string {
  return MODELS_DIR;
}

export function modelDir(modelId: string): string {
  if (!isValidModelId(modelId)) {
    // Hard fail BEFORE path.join — round-1 failure F12 (path-traversal).
    throw parseModelId.bind(null, modelId).call(null) as never;
  }
  return path.join(MODELS_DIR, modelId);
}

export function faissIndexBinaryPath(modelId: string): string {
  // The inner binary file inside `${PATH}/models/<id>/faiss.index/` — used
  // for staleness mtime detection (round-3 of RFC 012 §4.10 — directory
  // mtime doesn't update on file overwrites).
  return path.join(modelDir(modelId), 'faiss.index', 'faiss.index');
}

export function modelNameFilePath(modelId: string): string {
  return path.join(modelDir(modelId), 'model_name.txt');
}

export function addingSentinelPath(modelId: string): string {
  return path.join(modelDir(modelId), '.adding');
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
  try {
    await fsp.access(modelNameFilePath(modelId));
  } catch {
    return false;
  }
  // No .adding sentinel?
  try {
    await fsp.access(addingSentinelPath(modelId));
    return false; // exists → mid-add → not registered
  } catch {
    return true;
  }
}

export interface RegisteredModel {
  model_id: string;
  provider: string;
  model_name: string;
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
    models.push({ model_id: entry, provider, model_name: modelName });
  }
  return models.sort((a, b) => a.model_id.localeCompare(b.model_id));
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
  const tmp = `${ACTIVE_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, modelId, 'utf-8');
  await fsp.rename(tmp, ACTIVE_FILE);
}

export async function activeFileExists(): Promise<boolean> {
  try {
    await fsp.access(ACTIVE_FILE);
    return true;
  } catch {
    return false;
  }
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
        `Run \`kb models add <provider> <model>\` to register it first.`,
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
        `KB_ACTIVE_MODEL="${id}" is not registered. Registered: ${available}.`,
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
        `Run \`kb models set-active <other>\` to point at a registered model, or remove the .adding sentinel ` +
        `if a previous \`kb models add\` was interrupted.`,
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

/** Resolve the env-var-derived candidate id without registration check. */
export function computeLegacyEnvDerivedId(): string {
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
  return deriveModelId(provider, modelName);
}

// Re-export for callers that need it from one place.
export { deriveModelId, parseModelId, isValidModelId } from './model-id.js';
