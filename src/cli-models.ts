import * as fsp from 'fs/promises';
import * as path from 'path';
import { FaissIndexManager } from './FaissIndexManager.js';
import {
  ActiveModelResolutionError,
  activeModelFilePath,
  addingSentinelPath,
  buildAddingSentinelMetadata,
  classifyIncompleteModelState,
  computeLegacyEnvDerivedId,
  isRegisteredModel,
  isValidModelId,
  listRegisteredModels,
  modelDir,
  modelsRoot,
  parseModelId,
  readStoredModelName,
  resolveActiveModel,
  writeAddingSentinel,
  writeActiveModelAtomic,
} from './active-model.js';
import { resolveIndexType, type SearchIndexType } from './config/indexing.js';
import { KB_ACTIVE_MODEL } from './config/provider.js';
import { deriveModelId, type EmbeddingProvider } from './model-id.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { enumerateIngestableKbFiles, listKnowledgeBases } from './kb-fs.js';
import { withWriteLock } from './write-lock.js';
import { estimateCostUsd } from './cost-estimates.js';
import { pathExists } from './file-utils.js';
import { type DelimitedOutputFormat, renderRecords } from './cli-shared.js';

export const MODELS_HELP = `kb models — manage embedding models (RFC 013)

Usage:
  kb models list [--format=md|json|csv|tsv|ndjson]
  kb models add <provider> <model> [--index-type=flat|sq8|hnsw] [--yes] [--dry-run] [--recover]
  kb models set-active <id>
  kb models remove <id>
  kb models gc --dry-run [--format=json]

Each model gets its own per-model FAISS index under
\`\${FAISS_INDEX_PATH}/models/<id>/\`. The active model is the default for
both the MCP server and the CLI; explicit \`--model=<id>\` overrides that
per-call (RFC 013 §4.7).

Verbs:
  list                  Print one row per registered model. The active
                        model is marked with \`*\`. Models with both the
                        RFC-014 versioned layout AND a legacy \`faiss.index/\`
                        directory get a trailing \`[downgrade-hazard]\` flag.
  add <provider> <model>
                        Register a new model and run an initial ingest pass
                        under the per-model write lock. \`<provider>\` is one
                        of \`ollama\`, \`openai\`, \`huggingface\`. \`<model>\` is
                        the provider-specific name (e.g. \`nomic-embed-text\`,
                        \`text-embedding-3-small\`). The CLI computes a model
                        id of the form \`<provider>__<slug>\`.
  set-active <id>       Change the default model. Atomically rewrites
                        \`\${FAISS_INDEX_PATH}/active.txt\`. Subsequent calls
                        without an explicit \`--model=\` use the new active id.
  remove <id>           Delete the per-model index directory. Forces a
                        rebuild on the next \`kb models add <same id>\`.
  gc --dry-run          Plan inactive model directory cleanup without
                        deleting anything. Reports active-by-file/env
                        protection, incomplete state, byte size, downgrade
                        hazards, and the proposed action.

Options for \`add\`:
  --yes                 Skip the cost-estimate confirmation prompt.
  --dry-run             Print the cost estimate; don't embed.
  --recover             When a previous add left a stale .adding sentinel
                        whose writer PID is dead, delete that incomplete
                        model directory before retrying. Requires --yes.
  --index-type=flat|sq8|hnsw
                        Select the search index type for this model. Default is
                        KB_INDEX_TYPE when set, otherwise flat.

Options for \`gc\`:
  --dry-run             Required. Print the cleanup plan; never delete.
  --format=json         Emit a stable JSON payload instead of text.

Options for \`list\`:
  --format=md|json|csv|tsv|ndjson
                        Output format (default: md). Delimited formats emit
                        one row per registered model.

Global:
  --help, -h            Show this help.

Examples:
  kb models list
  kb models list --format=csv
  kb models add ollama nomic-embed-text
  kb models add openai text-embedding-3-small --dry-run
  kb models set-active openai__text-embedding-3-small
  kb models gc --dry-run
  kb models gc --dry-run --format=json
  kb models remove ollama__nomic-embed-text
`;

export async function runModels(rest: string[]): Promise<number> {
  const verb = rest[0];
  if (!verb) {
    process.stderr.write('kb models: missing subcommand (list, add, set-active, remove, gc)\n');
    return 2;
  }
  try {
    await FaissIndexManager.bootstrapLayout();
  } catch (err) {
    process.stderr.write(`kb models: layout bootstrap failed: ${(err as Error).message}\n`);
    return 1;
  }

  if (verb === 'list') return runModelsList(rest.slice(1));
  if (verb === 'add') return runModelsAdd(rest.slice(1));
  if (verb === 'set-active') return runModelsSetActive(rest.slice(1));
  if (verb === 'remove') return runModelsRemove(rest.slice(1));
  if (verb === 'gc') return runModelsGc(rest.slice(1));

  process.stderr.write(`kb models: unknown verb '${verb}'\n`);
  return 2;
}

type ModelsListFormat = 'md' | 'json' | DelimitedOutputFormat;

const MODELS_LIST_SCHEMA_VERSION = 'kb.models.list.v1';
const MODELS_LIST_COLUMNS = [
  'model_id',
  'provider',
  'model_name',
  'active',
  'downgrade_hazard',
] as const;

interface ModelsListPayload {
  schema_version: typeof MODELS_LIST_SCHEMA_VERSION;
  active_model_id: string | null;
  models: Array<Record<string, unknown>>;
}

async function runModelsList(rest: string[]): Promise<number> {
  let format: ModelsListFormat = 'md';
  for (const raw of rest) {
    if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length);
      if (!isModelsListFormat(value)) {
        process.stderr.write(`kb models list: invalid --format: ${raw}\n`);
        return 2;
      }
      format = value;
      continue;
    }
    if (raw.startsWith('--')) {
      process.stderr.write(`kb models list: unknown flag: ${raw}\n`);
      return 2;
    }
    process.stderr.write(`kb models list: unexpected argument: ${JSON.stringify(raw)}\n`);
    return 2;
  }

  const models = await listRegisteredModels();
  let activeId: string | null = null;
  try {
    activeId = await resolveActiveModel();
  } catch {
    // No active resolvable; just don't mark any.
  }
  const rows = models.map((model) => modelListRow(model, activeId));
  if (format === 'json') {
    const payload: ModelsListPayload = {
      schema_version: MODELS_LIST_SCHEMA_VERSION,
      active_model_id: activeId,
      models: rows,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  if (format !== 'md') {
    process.stdout.write(renderRecords(rows, format, { columns: MODELS_LIST_COLUMNS }));
    return 0;
  }
  if (models.length === 0) {
    process.stdout.write('(no models registered — run `kb models add <provider> <model>`)\n');
    return 0;
  }
  const idWidth = Math.max(8, ...models.map((m) => m.model_id.length));
  for (const m of models) {
    const marker = m.model_id === activeId ? '*' : ' ';
    const hazard = m.downgrade_hazard ? '  [downgrade-hazard]' : '';
    process.stdout.write(
      `${marker} ${m.model_id.padEnd(idWidth)}  ${m.provider.padEnd(11)}  ${m.model_name}${hazard}\n`,
    );
  }
  if (models.some((m) => m.downgrade_hazard)) {
    process.stdout.write(
      `\n[downgrade-hazard] models have BOTH the RFC-014 versioned layout and the legacy\n` +
        `faiss.index/ directory. Downgrading will silently ignore any embeddings added\n` +
        `since the upgrade. Run \`rm -rf \${FAISS_INDEX_PATH}/models/<id>/faiss.index\` to\n` +
        `reclaim disk and clear the hazard once you're confident in the new layout.\n`,
    );
  }
  return 0;
}

function isModelsListFormat(value: string): value is ModelsListFormat {
  return value === 'md' || value === 'json' || value === 'csv' || value === 'tsv' || value === 'ndjson';
}

function modelListRow(
  model: Awaited<ReturnType<typeof listRegisteredModels>>[number],
  activeId: string | null,
): Record<string, unknown> {
  return {
    model_id: model.model_id,
    provider: model.provider,
    model_name: model.model_name,
    active: model.model_id === activeId,
    downgrade_hazard: model.downgrade_hazard === true,
  };
}

async function runModelsAdd(rest: string[]): Promise<number> {
  const positionals: string[] = [];
  let yes = false;
  let dryRun = false;
  let recover = false;
  let indexType: SearchIndexType = resolveIndexType();
  for (const raw of rest) {
    if (raw === '--yes') { yes = true; continue; }
    if (raw === '--dry-run') { dryRun = true; continue; }
    if (raw === '--recover') { recover = true; continue; }
    if (raw.startsWith('--index-type=')) {
      const value = raw.slice('--index-type='.length);
      const normalized = value.trim().toLowerCase();
      const parsed = resolveIndexType(value);
      if (normalized !== parsed) {
        process.stderr.write(`kb models add: invalid --index-type: ${raw}\n`);
        return 2;
      }
      indexType = parsed;
      continue;
    }
    if (raw.startsWith('--')) {
      process.stderr.write(`kb models add: unknown flag: ${raw}\n`);
      return 2;
    }
    positionals.push(raw);
  }
  if (positionals.length !== 2) {
    process.stderr.write('kb models add: expected <provider> <model>\n');
    return 2;
  }
  const [provider, modelName] = positionals;
  if (provider !== 'ollama' && provider !== 'openai' && provider !== 'huggingface') {
    process.stderr.write(`kb models add: invalid provider "${provider}" (expected ollama|openai|huggingface)\n`);
    return 2;
  }

  let modelId: string;
  try {
    modelId = deriveModelId(provider as EmbeddingProvider, modelName);
  } catch (err) {
    process.stderr.write(`kb models add: ${(err as Error).message}\n`);
    return 2;
  }

  if (await isRegisteredModel(modelId)) {
    process.stderr.write(
      `kb models add: model "${modelId}" is already registered. ` +
      `Use \`kb search --model=${modelId} --refresh\` to re-embed, or ` +
      `\`kb models remove ${modelId}\` first.\n`,
    );
    return 2;
  }
  const incomplete = await classifyIncompleteModelState(modelId);
  if (incomplete !== null) {
    if (incomplete.status === 'stale_interrupted' && recover) {
      if (dryRun) {
        process.stderr.write('kb models add: --recover cannot be combined with --dry-run because recovery deletes incomplete state.\n');
        return 2;
      }
      if (!yes) {
        process.stderr.write(
          `kb models add: stale incomplete model "${modelId}" found, but recovery deletes ${modelDir(modelId)}. ` +
          `Pass both --recover and --yes to clean up and retry.\n`,
        );
        return 2;
      }
      await fsp.rm(modelDir(modelId), { recursive: true, force: true });
      process.stderr.write(`Recovered stale incomplete model "${modelId}" (${incomplete.detail}); retrying add.\n`);
    } else {
      process.stderr.write(formatIncompleteAddBlock(modelId, incomplete.status, incomplete.detail));
      return 2;
    }
  }

  let totalBytes = 0;
  let fileCount = 0;
  try {
    const kbs = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
    const enumerations = await enumerateIngestableKbFiles(KNOWLEDGE_BASES_ROOT_DIR, kbs);
    for (const { filePaths } of enumerations) {
      for (const f of filePaths) {
        try {
          const st = await fsp.stat(f);
          totalBytes += st.size;
          fileCount += 1;
        } catch { /* file vanished; skip */ }
      }
    }
  } catch (err) {
    process.stderr.write(`kb models add: failed to walk KBs: ${(err as Error).message}\n`);
    return 1;
  }

  const estChunks = Math.ceil(totalBytes / 800);
  const estTokens = Math.ceil(totalBytes / 4);
  let costLine = '';
  if (provider === 'openai') {
    const breakdown = estimateCostUsd('openai', modelName, estTokens);
    costLine = `Estimated cost: ~$${breakdown.usd.toFixed(4)} (OpenAI ${modelName} at $${breakdown.per_million_tokens_usd}/1M tokens)\n` +
               `See provider pricing: https://openai.com/api/pricing\n`;
  } else if (provider === 'huggingface') {
    costLine = 'Cost: free tier (rate-limited). See https://huggingface.co/docs/inference-providers/pricing\n';
  } else {
    costLine = 'Cost: free (Ollama is local).\n';
  }
  const wallSec = provider === 'ollama' ? estChunks * 0.05
                : provider === 'openai' ? estChunks * 0.2
                : estChunks * 0.3;
  process.stderr.write(
    `Adding model: ${modelId} (provider=${provider}, model=${modelName})\n` +
    `Index type: ${indexType}\n` +
    `Will embed: ${fileCount} files (~${estChunks} chunks, ~${(totalBytes / 1024).toFixed(0)} KB of text, ~${(estTokens / 1000).toFixed(0)}k tokens)\n` +
    costLine +
    `Estimated wall time: ~${wallSec < 60 ? wallSec.toFixed(0) + ' s' : (wallSec / 60).toFixed(1) + ' min'} (HTTP latency dominated)\n`,
  );
  if (dryRun) {
    process.stderr.write('(--dry-run; no embedding work done)\n');
    return 0;
  }

  if (!yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write('kb models add: not a TTY; pass --yes for non-interactive use, or --dry-run to preview.\n');
      return 2;
    }
    process.stderr.write('Continue? [y/N]: ');
    const answer = await readConfirmation();
    if (answer !== 'y' && answer !== 'yes') {
      process.stderr.write('Aborted.\n');
      return 0;
    }
  }

  await fsp.mkdir(modelDir(modelId), { recursive: true });
  const sentinel = addingSentinelPath(modelId);
  await writeAddingSentinel(buildAddingSentinelMetadata({
    modelId,
    provider: provider as EmbeddingProvider,
    modelName,
  }));
  let interrupted = false;
  try {
    await withWriteLock(modelDir(modelId), async () => {
      const manager = new FaissIndexManager({
        provider: provider as EmbeddingProvider,
        modelName,
        indexType,
      });
      await manager.initialize();
      await manager.updateIndex();
    });
  } catch (err) {
    interrupted = true;
    process.stderr.write(`kb models add: embedding failed: ${(err as Error).message}\n`);
    process.stderr.write(`Run \`kb models remove ${modelId} --force-incomplete\` to clean up, then retry.\n`);
    return 1;
  } finally {
    if (!interrupted) {
      await fsp.unlink(sentinel).catch(() => {});
    }
  }

  try {
    await resolveActiveModel();
  } catch (err) {
    if (err instanceof ActiveModelResolutionError) {
      await writeActiveModelAtomic(modelId);
      process.stderr.write(`Marked ${modelId} as active (first registered model).\n`);
    } else {
      throw err;
    }
  }

  process.stderr.write(`Successfully added ${modelId}.\n`);
  return 0;
}

function formatIncompleteAddBlock(modelId: string, status: string, detail: string): string {
  if (status === 'in_progress') {
    return `kb models add: model "${modelId}" is already being added (${detail}). Wait for it to finish before retrying.\n`;
  }
  if (status === 'stale_interrupted') {
    return (
      `kb models add: previous add for "${modelId}" appears stale/interrupted (${detail}). ` +
      `Pass --recover --yes to delete the incomplete model directory and retry, or run ` +
      `\`kb models remove ${modelId} --force-incomplete --yes\` to clean up manually.\n`
    );
  }
  return (
    `kb models add: model "${modelId}" has incomplete state that cannot be recovered automatically (${detail}). ` +
    `Inspect ${modelDir(modelId)} or run \`kb models remove ${modelId} --force-incomplete --yes\` if you intend to delete it.\n`
  );
}

async function runModelsSetActive(rest: string[]): Promise<number> {
  if (rest.length !== 1) {
    process.stderr.write('kb models set-active: expected exactly one model_id\n');
    return 2;
  }
  const id = rest[0];
  if (!(await isRegisteredModel(id))) {
    const available = (await listRegisteredModels()).map((m) => m.model_id).join(', ') || '<none>';
    process.stderr.write(`kb models set-active: "${id}" is not registered. Registered: ${available}\n`);
    return 2;
  }
  await writeActiveModelAtomic(id);
  process.stderr.write(`Active model set to ${id}.\n`);
  if (process.env.KB_ACTIVE_MODEL && process.env.KB_ACTIVE_MODEL !== '') {
    process.stderr.write(
      `Note: KB_ACTIVE_MODEL=${process.env.KB_ACTIVE_MODEL} is set in your environment; this will continue to override active.txt for processes inheriting it. Unset KB_ACTIVE_MODEL to use the new active model.\n`,
    );
  }
  return 0;
}

async function runModelsRemove(rest: string[]): Promise<number> {
  const positionals: string[] = [];
  let yes = false;
  let forceIncomplete = false;
  for (const raw of rest) {
    if (raw === '--yes') { yes = true; continue; }
    if (raw === '--force-incomplete') { forceIncomplete = true; continue; }
    if (raw.startsWith('--')) {
      process.stderr.write(`kb models remove: unknown flag: ${raw}\n`);
      return 2;
    }
    positionals.push(raw);
  }
  if (positionals.length !== 1) {
    process.stderr.write('kb models remove: expected exactly one model_id\n');
    return 2;
  }
  const id = positionals[0];
  try {
    parseModelId(id);
  } catch (err) {
    process.stderr.write(`kb models remove: ${(err as Error).message}\n`);
    return 2;
  }

  const dir = modelDir(id);
  if (!(await pathExists(dir))) {
    process.stderr.write(`kb models remove: "${id}" does not exist on disk.\n`);
    return 2;
  }

  let activeId: string | null = null;
  try {
    activeId = await resolveActiveModel();
  } catch { /* no active; remove freely */ }
  if (activeId === id) {
    const others = (await listRegisteredModels()).filter((m) => m.model_id !== id).map((m) => m.model_id).join(', ') || '<none>';
    process.stderr.write(
      `kb models remove: refusing to remove the active model. ` +
      `Run \`kb models set-active <other>\` first. Other registered: ${others}\n`,
    );
    return 2;
  }

  if ((await pathExists(addingSentinelPath(id))) && !forceIncomplete) {
    process.stderr.write(
      'kb models remove: ".adding" sentinel present (interrupted add). Pass --force-incomplete to confirm.\n',
    );
    return 2;
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write('kb models remove: not a TTY; pass --yes for non-interactive use.\n');
      return 2;
    }
    process.stderr.write(`Remove ${id} (delete ${dir})? [y/N]: `);
    const answer = await readConfirmation();
    if (answer !== 'y' && answer !== 'yes') {
      process.stderr.write('Aborted.\n');
      return 0;
    }
  }
  await fsp.rm(dir, { recursive: true, force: true });
  process.stderr.write(`Removed ${id}.\n`);
  return 0;
}

type ModelsGcFormat = 'text' | 'json';

const MODELS_GC_SCHEMA_VERSION = 'kb.models.gc.v1';

interface ActiveFileSnapshot {
  model_id: string | null;
  status: 'absent' | 'empty' | 'malformed' | 'valid';
}

interface ModelsGcPlanEntry {
  model_id: string;
  provider: string | null;
  model_name: string | null;
  registered: boolean;
  active_by_file: boolean;
  active_by_env: boolean;
  incomplete_status: string | null;
  incomplete_detail: string | null;
  bytes: number;
  hazards: string[];
  proposed_action: 'keep-active' | 'keep-in-progress' | 'review-incomplete' | 'inspect-incomplete' | 'would-remove';
}

interface ModelsGcPlan {
  schema_version: typeof MODELS_GC_SCHEMA_VERSION;
  dry_run: true;
  models_root: string;
  active_file: ActiveFileSnapshot;
  active_env_model_id: string | null;
  total_bytes: number;
  reclaimable_bytes: number;
  models: ModelsGcPlanEntry[];
}

async function runModelsGc(rest: string[]): Promise<number> {
  let dryRun = false;
  let format: ModelsGcFormat = 'text';
  for (const raw of rest) {
    if (raw === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (raw === '--format=json') {
      format = 'json';
      continue;
    }
    if (raw === '--format=text') {
      format = 'text';
      continue;
    }
    if (raw.startsWith('--format=')) {
      process.stderr.write(`kb models gc: invalid --format: ${raw}\n`);
      return 2;
    }
    if (raw.startsWith('--')) {
      process.stderr.write(`kb models gc: unknown flag: ${raw}\n`);
      return 2;
    }
    process.stderr.write('kb models gc: does not accept positional arguments\n');
    return 2;
  }

  if (!dryRun) {
    process.stderr.write('kb models gc: v1 is dry-run only; pass --dry-run to print the cleanup plan.\n');
    return 2;
  }

  const plan = await buildModelsGcPlan();
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else {
    process.stdout.write(formatModelsGcPlan(plan));
  }
  return 0;
}

async function buildModelsGcPlan(): Promise<ModelsGcPlan> {
  const activeFile = await readActiveFileSnapshot();
  const activeEnvModelId = resolveActiveEnvCandidate(activeFile);
  const registeredModels = new Map((await listRegisteredModels()).map((m) => [m.model_id, m]));
  const entries = await listValidModelDirectoryNames();
  const models: ModelsGcPlanEntry[] = [];

  for (const modelId of entries) {
    const registered = registeredModels.get(modelId) ?? null;
    const incomplete = await classifyIncompleteModelState(modelId);
    const storedName = registered?.model_name ?? incomplete?.model_name ?? await readStoredModelName(modelId);
    const provider = registered?.provider ?? incomplete?.provider ?? parseModelId(modelId).provider;
    const bytes = await directorySizeBytes(modelDir(modelId));
    const activeByFile = activeFile.model_id === modelId;
    const activeByEnv = activeEnvModelId === modelId;
    const hazards: string[] = [];
    if (registered?.downgrade_hazard) hazards.push('downgrade-hazard');
    if (incomplete !== null) hazards.push(`incomplete-${incomplete.status}`);
    if (activeByFile) hazards.push('active-by-file');
    if (activeByEnv) hazards.push('active-by-env');

    models.push({
      model_id: modelId,
      provider,
      model_name: storedName,
      registered: registered !== null,
      active_by_file: activeByFile,
      active_by_env: activeByEnv,
      incomplete_status: incomplete?.status ?? null,
      incomplete_detail: incomplete?.detail ?? null,
      bytes,
      hazards,
      proposed_action: proposeModelsGcAction({ activeByFile, activeByEnv, incompleteStatus: incomplete?.status ?? null }),
    });
  }

  models.sort((a, b) => a.model_id.localeCompare(b.model_id));
  return {
    schema_version: MODELS_GC_SCHEMA_VERSION,
    dry_run: true,
    models_root: modelsRoot(),
    active_file: activeFile,
    active_env_model_id: activeEnvModelId,
    total_bytes: models.reduce((sum, m) => sum + m.bytes, 0),
    reclaimable_bytes: models
      .filter((m) => m.proposed_action === 'would-remove')
      .reduce((sum, m) => sum + m.bytes, 0),
    models,
  };
}

function resolveActiveEnvCandidate(activeFile: ActiveFileSnapshot): string | null {
  if (KB_ACTIVE_MODEL !== '') return KB_ACTIVE_MODEL;
  if (activeFile.status === 'absent' || activeFile.status === 'empty') {
    return computeLegacyEnvDerivedId();
  }
  return null;
}

async function listValidModelDirectoryNames(): Promise<string[]> {
  let entries: Array<import('fs').Dirent>;
  try {
    entries = await fsp.readdir(modelsRoot(), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isDirectory() && isValidModelId(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function readActiveFileSnapshot(): Promise<ActiveFileSnapshot> {
  let raw: string;
  try {
    raw = await fsp.readFile(activeModelFilePath(), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent', model_id: null };
    throw err;
  }
  const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const trimmed = normalized.replace(/\r/g, '').trim();
  if (trimmed === '') return { status: 'empty', model_id: null };
  if (!isValidModelId(trimmed)) return { status: 'malformed', model_id: null };
  return { status: 'valid', model_id: trimmed };
}

function proposeModelsGcAction(args: {
  activeByFile: boolean;
  activeByEnv: boolean;
  incompleteStatus: string | null;
}): ModelsGcPlanEntry['proposed_action'] {
  if (args.activeByFile || args.activeByEnv) return 'keep-active';
  if (args.incompleteStatus === 'in_progress') return 'keep-in-progress';
  if (args.incompleteStatus === 'stale_interrupted') return 'review-incomplete';
  if (args.incompleteStatus !== null) return 'inspect-incomplete';
  return 'would-remove';
}

function formatModelsGcPlan(plan: ModelsGcPlan): string {
  const lines: string[] = [];
  lines.push(`Model cleanup dry-run (${plan.models.length} model director${plan.models.length === 1 ? 'y' : 'ies'})`);
  lines.push(`Models root: ${plan.models_root}`);
  lines.push(`Active by file: ${plan.active_file.model_id ?? `<${plan.active_file.status}>`}`);
  lines.push(`Active by env: ${plan.active_env_model_id ?? '<unset>'}`);
  lines.push(`Total size: ${formatBytes(plan.total_bytes)}; would reclaim: ${formatBytes(plan.reclaimable_bytes)}`);
  if (plan.models.length === 0) {
    lines.push('(no model directories found)');
    return `${lines.join('\n')}\n`;
  }
  const idWidth = Math.max(8, ...plan.models.map((m) => m.model_id.length));
  const actionWidth = Math.max(14, ...plan.models.map((m) => m.proposed_action.length));
  for (const model of plan.models) {
    const flags = model.hazards.length > 0 ? ` [${model.hazards.join(',')}]` : '';
    lines.push(
      `${model.model_id.padEnd(idWidth)}  ${model.proposed_action.padEnd(actionWidth)}  ${formatBytes(model.bytes).padStart(9)}${flags}`,
    );
    if (model.incomplete_detail !== null) {
      lines.push(`  incomplete: ${model.incomplete_detail}`);
    }
  }
  lines.push('Dry run only: no files were deleted.');
  return `${lines.join('\n')}\n`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
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

async function readConfirmation(): Promise<string> {
  return new Promise<string>((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    const onData = (chunk: string) => {
      buf += chunk;
      if (buf.includes('\n')) {
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        resolve(buf.trim().toLowerCase());
      }
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}
