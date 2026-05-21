import * as fsp from 'fs/promises';
import { FaissIndexManager } from './FaissIndexManager.js';
import {
  ActiveModelResolutionError,
  addingSentinelPath,
  buildAddingSentinelMetadata,
  classifyIncompleteModelState,
  isRegisteredModel,
  listRegisteredModels,
  modelDir,
  parseModelId,
  resolveActiveModel,
  writeAddingSentinel,
  writeActiveModelAtomic,
} from './active-model.js';
import { resolveFaissIndexType, type FaissIndexType } from './config/indexing.js';
import { deriveModelId, type EmbeddingProvider } from './model-id.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { enumerateIngestableKbFiles, listKnowledgeBases } from './kb-fs.js';
import { withWriteLock } from './write-lock.js';
import { estimateCostUsd } from './cost-estimates.js';
import { pathExists } from './file-utils.js';

export const MODELS_HELP = `kb models — manage embedding models (RFC 013)

Usage:
  kb models list
  kb models add <provider> <model> [--index-type=flat|sq8] [--yes] [--dry-run] [--recover]
  kb models set-active <id>
  kb models remove <id>

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

Options for \`add\`:
  --yes                 Skip the cost-estimate confirmation prompt.
  --dry-run             Print the cost estimate; don't embed.
  --recover             When a previous add left a stale .adding sentinel
                        whose writer PID is dead, delete that incomplete
                        model directory before retrying. Requires --yes.
  --index-type=flat|sq8 Select the FAISS index type for this model. Default
                        is KB_INDEX_TYPE when set, otherwise flat.

Global:
  --help, -h            Show this help.

Examples:
  kb models list
  kb models add ollama nomic-embed-text
  kb models add openai text-embedding-3-small --dry-run
  kb models set-active openai__text-embedding-3-small
  kb models remove ollama__nomic-embed-text
`;

export async function runModels(rest: string[]): Promise<number> {
  const verb = rest[0];
  if (!verb) {
    process.stderr.write('kb models: missing subcommand (list, add, set-active, remove)\n');
    return 2;
  }
  try {
    await FaissIndexManager.bootstrapLayout();
  } catch (err) {
    process.stderr.write(`kb models: layout bootstrap failed: ${(err as Error).message}\n`);
    return 1;
  }

  if (verb === 'list') return runModelsList();
  if (verb === 'add') return runModelsAdd(rest.slice(1));
  if (verb === 'set-active') return runModelsSetActive(rest.slice(1));
  if (verb === 'remove') return runModelsRemove(rest.slice(1));

  process.stderr.write(`kb models: unknown verb '${verb}'\n`);
  return 2;
}

async function runModelsList(): Promise<number> {
  const models = await listRegisteredModels();
  let activeId: string | null = null;
  try {
    activeId = await resolveActiveModel();
  } catch {
    // No active resolvable; just don't mark any.
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

async function runModelsAdd(rest: string[]): Promise<number> {
  const positionals: string[] = [];
  let yes = false;
  let dryRun = false;
  let recover = false;
  let indexType: FaissIndexType = resolveFaissIndexType();
  for (const raw of rest) {
    if (raw === '--yes') { yes = true; continue; }
    if (raw === '--dry-run') { dryRun = true; continue; }
    if (raw === '--recover') { recover = true; continue; }
    if (raw.startsWith('--index-type=')) {
      const value = raw.slice('--index-type='.length);
      const normalized = value.trim().toLowerCase();
      const parsed = resolveFaissIndexType(value);
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
