// RFC 013 §4.7 / issue #1008 — sole owner of active-model resolution:
//
//   - Active-model resolution: explicit arg > KB_ACTIVE_MODEL env > active.txt > legacy env-var fallback.
//   - Registered-model listing, built on the `isRegisteredModel` storage
//     predicate (re-exported here from `./model-storage-layout.js` — the
//     predicate itself is a pure filesystem check with no resolution
//     concerns, so it lives there; `classifyIncompleteModelState` in that
//     module needs it too, and the dependency direction only runs this way:
//     this module may import from `./model-storage-layout.js`, never the
//     reverse).
//
// CLI and MCP both import from this module; two implementations of active
// resolution are forbidden (RFC 012 round-2 N5 was that exact drift bug).

import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  EMBEDDING_PROVIDER,
  HUGGINGFACE_MODEL_NAME,
  KB_ACTIVE_MODEL,
  OLLAMA_MODEL,
  OPENAI_MODEL_NAME,
} from './config/provider.js';
import { pathExists } from './file-utils.js';
import { deriveModelId, EmbeddingProvider, isValidModelId, parseModelId } from './model-id.js';
import {
  classifyIncompleteModelState,
  isRegisteredModel,
  modelDir,
  modelsRoot,
  readActiveRaw,
  readStoredModelName,
} from './model-storage-layout.js';

export { isRegisteredModel };

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
    entries = await fsp.readdir(modelsRoot());
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
