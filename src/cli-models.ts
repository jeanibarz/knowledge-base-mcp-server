import * as fsp from 'fs/promises';
import * as path from 'path';
import { FaissIndexManager } from './FaissIndexManager.js';
import {
  ActiveModelResolutionError,
  addingSentinelPath,
  isRegisteredModel,
  listRegisteredModels,
  modelDir,
  parseModelId,
  resolveActiveModel,
  writeActiveModelAtomic,
} from './active-model.js';
import { deriveModelId, type EmbeddingProvider } from './model-id.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config.js';
import { listKnowledgeBases } from './kb-fs.js';
import { withWriteLock } from './write-lock.js';
import { estimateCostUsd } from './cost-estimates.js';
import { getFilesRecursively } from './file-utils.js';
import { filterIngestablePaths } from './ingest-filter.js';

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
  for (const raw of rest) {
    if (raw === '--yes') { yes = true; continue; }
    if (raw === '--dry-run') { dryRun = true; continue; }
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
  const sentinelExists = await fsp.access(addingSentinelPath(modelId)).then(() => true).catch(() => false);
  if (sentinelExists) {
    process.stderr.write(
      `kb models add: previous \`kb models add ${modelId}\` was interrupted (.adding sentinel present). ` +
      `Run \`kb models remove ${modelId} --force-incomplete\` to clean up, then retry.\n`,
    );
    return 2;
  }

  let totalBytes = 0;
  let fileCount = 0;
  try {
    const kbs = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
    for (const kbName of kbs) {
      const kbDir = path.join(KNOWLEDGE_BASES_ROOT_DIR, kbName);
      const all = await getFilesRecursively(kbDir);
      const ingestable = await filterIngestablePaths(all, kbDir);
      for (const f of ingestable) {
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
  await fsp.writeFile(sentinel, `${process.pid}\n`, 'utf-8');
  let interrupted = false;
  try {
    await withWriteLock(modelDir(modelId), async () => {
      const manager = new FaissIndexManager({
        provider: provider as EmbeddingProvider,
        modelName,
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
  const exists = await fsp.access(dir).then(() => true).catch(() => false);
  if (!exists) {
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

  const sentinelExists = await fsp.access(addingSentinelPath(id)).then(() => true).catch(() => false);
  if (sentinelExists && !forceIncomplete) {
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
