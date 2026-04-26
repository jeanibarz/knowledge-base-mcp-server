#!/usr/bin/env node
// RFC 012 — `kb` CLI alongside the MCP server.
//
// Two subcommands:
//   - `kb list`               → list ingested knowledge bases (one per line)
//   - `kb search <query>`     → similarity search; default read-only
//                               (skips updateIndex, no write lock)
//   - `kb search --refresh`   → also runs updateIndex under the write lock
//
// Both subcommands check `model_name.txt` against the configured embedding
// model on every invocation and exit non-zero on mismatch (RFC §4.7) so a
// shell-launched CLI with different env from the MCP server's mcp.json
// can't silently return wrong-vector-space results.

import * as fsp from 'fs/promises';
import { FaissIndexManager } from './FaissIndexManager.js';
import {
  ActiveModelResolutionError,
  faissIndexBinaryPath,
  resolveFaissIndexBinaryPath,
  isRegisteredModel,
  listRegisteredModels,
  modelDir,
  parseModelId,
  readStoredModelName,
  resolveActiveModel,
  writeActiveModelAtomic,
} from './active-model.js';
import { deriveModelId, EmbeddingProvider } from './model-id.js';
import { addingSentinelPath } from './active-model.js';
import {
  FRONTMATTER_EXTRAS_WIRE_VISIBLE,
  KNOWLEDGE_BASES_ROOT_DIR,
} from './config.js';
import { formatRetrievalAsJson, formatRetrievalAsMarkdown } from './formatter.js';
import { listKnowledgeBases } from './kb-fs.js';
import { withWriteLock } from './write-lock.js';
import { logger } from './logger.js';
import { estimateCostUsd } from './cost-estimates.js';
import { filterIngestablePaths, getFilesRecursively } from './utils.js';
import { readFileSync, realpathSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ----- Argv types ------------------------------------------------------------

interface SearchArgs {
  query: string | null; // null when --stdin and stdin not yet read
  kb?: string;
  model?: string; // RFC 013 §4.4 — per-call active-model override
  threshold?: number;
  k: number;
  format: 'md' | 'json';
  refresh: boolean;
  stdin: boolean;
}

// ----- Entry point -----------------------------------------------------------

const HELP = `kb — knowledge-base CLI (RFC 012 + RFC 013)

Usage:
  kb list                                 List available knowledge bases.
  kb search <query> [opts]                Semantic search (read-only).
  kb search <query> --refresh             Also re-scan KB files (write path).
  kb search --stdin                       Read query from stdin.
  kb compare <query> <a> <b>              Side-by-side rank/score table.
  kb models list                          List registered embedding models.
  kb models add <provider> <model>        Register a new model + ingest.
  kb models set-active <id>               Change the default model.
  kb models remove <id>                   Delete a model's index.
  kb --version
  kb --help

Search options:
  --kb=<name>           Scope to one knowledge base.
  --model=<id>          Override active model for this call (RFC 013).
  --threshold=<float>   Max similarity score (default 2).
  --k=<int>             Top-K results (default 10).
  --format=md|json      Output format (default md).
  --refresh             Re-scan KB files; acquires per-model write lock.
  --stdin               Read query from stdin (multi-line safe).

Models add options:
  --yes                 Skip the cost-estimate confirmation prompt.
  --dry-run             Print the estimate; don't embed.

Env vars: KNOWLEDGE_BASES_ROOT_DIR, FAISS_INDEX_PATH, EMBEDDING_PROVIDER,
KB_ACTIVE_MODEL (RFC 013 §4.7), OLLAMA_*, OPENAI_*, HUGGINGFACE_*.

Exit codes:
  0  success (results found or empty)
  1  runtime / index error
  2  argv / env / model-resolution error
`;

export async function main(argv: string[]): Promise<number> {
  // Strip the conventional argv[0]/argv[1] before delegating.
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  if (args[0] === '--version' || args[0] === '-v') {
    process.stdout.write(`${getPackageVersion()}\n`);
    return 0;
  }

  const sub = args[0];
  const rest = args.slice(1);

  if (sub === 'list') {
    return runList();
  }
  if (sub === 'search') {
    return runSearch(rest);
  }
  if (sub === 'models') {
    return runModels(rest);
  }
  if (sub === 'compare') {
    return runCompare(rest);
  }

  process.stderr.write(`kb: unknown subcommand '${sub}'\n${HELP}`);
  return 2;
}

// ----- compare (RFC 013 §4.4 G11) -------------------------------------------

async function runCompare(rest: string[]): Promise<number> {
  // Parse: <query> <model_a> <model_b> [--k=<int>] [--kb=<name>]
  const positionals: string[] = [];
  let k = 10;
  let kb: string | undefined;
  for (const raw of rest) {
    if (raw.startsWith('--k=')) {
      const n = Number(raw.slice('--k='.length));
      if (!Number.isInteger(n) || n <= 0) {
        process.stderr.write(`kb compare: invalid --k: ${raw}\n`);
        return 2;
      }
      k = n;
      continue;
    }
    if (raw.startsWith('--kb=')) { kb = raw.slice('--kb='.length); continue; }
    if (raw.startsWith('--')) {
      process.stderr.write(`kb compare: unknown flag: ${raw}\n`);
      return 2;
    }
    positionals.push(raw);
  }
  if (positionals.length !== 3) {
    process.stderr.write('kb compare: expected <query> <model_a> <model_b>\n');
    return 2;
  }
  const [query, modelA, modelB] = positionals;

  // Bootstrap layout once for both models.
  try {
    await FaissIndexManager.bootstrapLayout();
  } catch (err) {
    process.stderr.write(`kb compare: layout bootstrap failed: ${(err as Error).message}\n`);
    return 1;
  }

  // Resolve both models. Either being unresolvable fails-fast (round-2 failure N5
  // — never render a half-table).
  let resolvedA: string;
  let resolvedB: string;
  try {
    resolvedA = await resolveActiveModel({ explicitOverride: modelA });
    resolvedB = await resolveActiveModel({ explicitOverride: modelB });
  } catch (err) {
    if (err instanceof ActiveModelResolutionError) {
      process.stderr.write(`kb compare: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`kb compare: ${(err as Error).message}\n`);
    return 1;
  }
  if (resolvedA === resolvedB) {
    process.stderr.write(`kb compare: model_a and model_b resolve to the same id "${resolvedA}". Pick two different models.\n`);
    return 2;
  }

  // Load both managers and run similarity search against each.
  let resultsA, resultsB;
  try {
    const managerA = await loadManagerForModel(resolvedA);
    await loadWithJsonRetry(managerA);
    resultsA = await managerA.similaritySearch(query, k, undefined, kb);

    const managerB = await loadManagerForModel(resolvedB);
    await loadWithJsonRetry(managerB);
    resultsB = await managerB.similaritySearch(query, k, undefined, kb);
  } catch (err) {
    process.stderr.write(`kb compare: ${(err as Error).message}\n`);
    return 1;
  }

  // Build unified table by chunk text hash (treat the source path + chunk
  // index as the join key — chunks with identical content from the same
  // file should align across models).
  interface Row {
    rank_a?: number;
    rank_b?: number;
    score_a?: number;
    score_b?: number;
    source: string;
  }
  const rows = new Map<string, Row>();
  resultsA.forEach((doc: any, i: number) => {
    const key = `${(doc.metadata?.source ?? 'unknown')}#${doc.metadata?.chunkIndex ?? 0}`;
    rows.set(key, { rank_a: i + 1, score_a: doc.score, source: doc.metadata?.source ?? 'unknown' });
  });
  resultsB.forEach((doc: any, i: number) => {
    const key = `${(doc.metadata?.source ?? 'unknown')}#${doc.metadata?.chunkIndex ?? 0}`;
    const existing = rows.get(key);
    if (existing) {
      existing.rank_b = i + 1;
      existing.score_b = doc.score;
    } else {
      rows.set(key, { rank_b: i + 1, score_b: doc.score, source: doc.metadata?.source ?? 'unknown' });
    }
  });

  // Sort by min(rank_a, rank_b).
  const sorted = Array.from(rows.entries()).map(([key, r]) => ({ key, ...r }));
  sorted.sort((a, b) => {
    const ra = a.rank_a ?? Number.POSITIVE_INFINITY;
    const rb = a.rank_b ?? Number.POSITIVE_INFINITY;
    const minA = Math.min(ra, rb);
    const ra2 = b.rank_a ?? Number.POSITIVE_INFINITY;
    const rb2 = b.rank_b ?? Number.POSITIVE_INFINITY;
    const minB = Math.min(ra2, rb2);
    return minA - minB;
  });

  // Header note: scores not directly comparable if dim/distance differ — we
  // can't tell from here; print a generic caveat.
  process.stdout.write(`# kb compare\n\n`);
  process.stdout.write(`Query: ${query}\n`);
  process.stdout.write(`Model A: ${resolvedA}\n`);
  process.stdout.write(`Model B: ${resolvedB}\n`);
  process.stdout.write(`(Scores are per-model L2 distances; not directly comparable across models.)\n\n`);
  process.stdout.write(`rank_a  rank_b  score_a  score_b  in_both  source\n`);
  for (const r of sorted) {
    const ra = r.rank_a !== undefined ? String(r.rank_a).padStart(6) : '     —';
    const rb = r.rank_b !== undefined ? String(r.rank_b).padStart(6) : '     —';
    const sa = r.score_a !== undefined ? r.score_a.toFixed(2).padStart(7) : '      —';
    const sb = r.score_b !== undefined ? r.score_b.toFixed(2).padStart(7) : '      —';
    const both = r.rank_a !== undefined && r.rank_b !== undefined ? '  yes  ' : '  no   ';
    process.stdout.write(`${ra}  ${rb}  ${sa}  ${sb}  ${both}  ${r.source}\n`);
  }
  return 0;
}

// ----- models (RFC 013 §4.4) -------------------------------------------------

async function runModels(rest: string[]): Promise<number> {
  const verb = rest[0];
  if (!verb) {
    process.stderr.write('kb models: missing subcommand (list, add, set-active, remove)\n');
    return 2;
  }
  // Bootstrap layout for any models subcommand.
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
  // Compute padding from data.
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
  // Parse args: <provider> <model> [--yes] [--dry-run]
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

  // Already registered (or .adding present)?
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

  // Cost estimate (RFC 013 §4.10) — simple bytes/4 token rule.
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

  // TTY check (round-1 failure F9) — never block on stdin.
  if (!yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write('kb models add: not a TTY; pass --yes for non-interactive use, or --dry-run to preview.\n');
      return 2;
    }
    process.stderr.write('Continue? [y/N]: ');
    const answer = await new Promise<string>((resolve) => {
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
    if (answer !== 'y' && answer !== 'yes') {
      process.stderr.write('Aborted.\n');
      return 0;
    }
  }

  // Mkdir + sentinel + lock + embed.
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

  // Auto-promote to active if no active.txt yet (round-2 failure N2).
  try {
    await resolveActiveModel();
  } catch (err) {
    if (err instanceof ActiveModelResolutionError) {
      // No active resolvable → write this one.
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
  // Parse: <id> [--yes] [--force-incomplete]
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
  // Validate id format before touching paths.
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
  // Refuse if active.
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
  // Refuse if .adding present (unless --force-incomplete).
  const sentinelExists = await fsp.access(addingSentinelPath(id)).then(() => true).catch(() => false);
  if (sentinelExists && !forceIncomplete) {
    process.stderr.write(
      `kb models remove: ".adding" sentinel present (interrupted add). Pass --force-incomplete to confirm.\n`,
    );
    return 2;
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      process.stderr.write('kb models remove: not a TTY; pass --yes for non-interactive use.\n');
      return 2;
    }
    process.stderr.write(`Remove ${id} (delete ${dir})? [y/N]: `);
    const answer = await new Promise<string>((resolve) => {
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
    if (answer !== 'y' && answer !== 'yes') {
      process.stderr.write('Aborted.\n');
      return 0;
    }
  }
  await fsp.rm(dir, { recursive: true, force: true });
  process.stderr.write(`Removed ${id}.\n`);
  return 0;
}

// ----- list ------------------------------------------------------------------

async function runList(): Promise<number> {
  try {
    const kbs = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
    for (const name of kbs) {
      process.stdout.write(`${name}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`kb list: ${(err as Error).message}\n`);
    return 1;
  }
}

// ----- search ----------------------------------------------------------------

async function runSearch(rest: string[]): Promise<number> {
  let parsed: SearchArgs;
  try {
    parsed = parseSearchArgs(rest);
  } catch (err) {
    process.stderr.write(`kb search: ${(err as Error).message}\n`);
    return 2;
  }

  // Stdin path: if --stdin and no positional query, read from stdin.
  if (parsed.stdin && parsed.query === null) {
    parsed.query = await readAllStdin();
    if (parsed.query.trim() === '') {
      process.stderr.write('kb search: empty query from stdin\n');
      return 2;
    }
  } else if (parsed.query === null) {
    process.stderr.write('kb search: missing <query> (or use --stdin)\n');
    return 2;
  }

  // RFC 013 §4.8 — bootstrap layout (one-shot migration from 0.2.x).
  try {
    await FaissIndexManager.bootstrapLayout();
  } catch (err) {
    process.stderr.write(`kb search: layout bootstrap failed: ${(err as Error).message}\n`);
    return 1;
  }

  // RFC 013 §4.7 — resolve active model (precedence: --model > KB_ACTIVE_MODEL > active.txt > legacy env).
  let activeModelId: string;
  try {
    activeModelId = await resolveActiveModel({ explicitOverride: parsed.model });
  } catch (err) {
    if (err instanceof ActiveModelResolutionError) {
      process.stderr.write(`kb search: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`kb search: ${(err as Error).message}\n`);
    return 1;
  }

  let manager: FaissIndexManager;
  try {
    manager = await loadManagerForModel(activeModelId);
  } catch (err) {
    process.stderr.write(`kb search: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    if (parsed.refresh) {
      // RFC 013 §4.6 — write lock is per-model directory.
      await withWriteLock(manager.modelDir, async () => {
        await manager.initialize();
        await manager.updateIndex(parsed.kb);
      });
    } else {
      await loadWithJsonRetry(manager);
    }
  } catch (err) {
    process.stderr.write(`kb search: ${(err as Error).message}\n`);
    return 1;
  }

  let results;
  try {
    results = await manager.similaritySearch(
      parsed.query!,
      parsed.k,
      parsed.threshold,
      parsed.kb,
    );
  } catch (err) {
    process.stderr.write(`kb search: ${(err as Error).message}\n`);
    return 1;
  }

  // Staleness pre-check (RFC §4.10). Cheap stat-only walk; computes
  // modified + new file counts vs. the inner FAISS binary's mtime.
  const staleness = await computeStaleness(activeModelId);

  if (parsed.format === 'json') {
    const body = formatRetrievalAsJson(results, FRONTMATTER_EXTRAS_WIRE_VISIBLE);
    const payload = {
      results: body,
      index_mtime: staleness.indexMtime,
      stale: parsed.refresh ? false : staleness.modifiedFiles + staleness.newFiles > 0,
      modified_files: parsed.refresh ? 0 : staleness.modifiedFiles,
      new_files: parsed.refresh ? 0 : staleness.newFiles,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const md = formatRetrievalAsMarkdown(results, FRONTMATTER_EXTRAS_WIRE_VISIBLE);
    process.stdout.write(md);
    process.stdout.write('\n\n');
    process.stdout.write(formatFreshnessFooter(staleness, parsed.refresh));
    process.stdout.write('\n');
  }

  return 0;
}

// ----- argv parsing ----------------------------------------------------------

function parseSearchArgs(rest: string[]): SearchArgs {
  const out: SearchArgs = {
    query: null,
    k: 10,
    format: 'md',
    refresh: false,
    stdin: false,
  };
  for (const raw of rest) {
    if (raw === '--refresh') { out.refresh = true; continue; }
    if (raw === '--stdin')   { out.stdin = true; continue; }
    if (raw.startsWith('--kb=')) { out.kb = raw.slice('--kb='.length); continue; }
    if (raw.startsWith('--model=')) { out.model = raw.slice('--model='.length); continue; }
    if (raw.startsWith('--threshold=')) {
      const n = Number(raw.slice('--threshold='.length));
      if (!Number.isFinite(n)) throw new Error(`invalid --threshold: ${raw}`);
      out.threshold = n; continue;
    }
    if (raw.startsWith('--k=')) {
      const n = Number(raw.slice('--k='.length));
      if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid --k: ${raw}`);
      out.k = n; continue;
    }
    if (raw.startsWith('--format=')) {
      const v = raw.slice('--format='.length);
      if (v !== 'md' && v !== 'json') throw new Error(`invalid --format: ${raw}`);
      out.format = v; continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    // First positional becomes the query.
    if (out.query === null) { out.query = raw; continue; }
    throw new Error(`unexpected argument: ${raw}`);
  }
  return out;
}

// ----- manager construction --------------------------------------------------

/**
 * RFC 013: load a FaissIndexManager for the given model_id. Resolves the
 * (provider, modelName) pair from the model's `model_name.txt` so the
 * manager can instantiate the right embeddings client. The 0.2.x model-
 * mismatch check is obsolete under multi-model — each model has its own
 * dir, and the active resolver fails-fast on missing/malformed state.
 */
async function loadManagerForModel(modelId: string): Promise<FaissIndexManager> {
  const { provider } = parseModelId(modelId);
  const modelName = await readStoredModelName(modelId);
  if (modelName === null) {
    throw new Error(`model_name.txt missing for "${modelId}" — corrupt model directory`);
  }
  return new FaissIndexManager({
    provider: provider as EmbeddingProvider,
    modelName,
  });
}

// ----- staleness pre-check (RFC §4.10) --------------------------------------

interface Staleness {
  indexMtime: string | null;
  modifiedFiles: number;
  newFiles: number;
}

async function computeStaleness(modelId: string): Promise<Staleness> {
  // Index mtime — target the inner binary file (NOT the directory; round-3
  // mtime correction). RFC 014: prefer the versioned layout if present,
  // fall back to the legacy faiss.index/.
  const binaryPath = await resolveFaissIndexBinaryPath(modelId);
  if (binaryPath === null) {
    return { indexMtime: null, modifiedFiles: 0, newFiles: 0 };
  }
  let indexStat;
  try {
    indexStat = await fsp.stat(binaryPath);
  } catch {
    return { indexMtime: null, modifiedFiles: 0, newFiles: 0 };
  }
  const indexMtimeMs = indexStat.mtimeMs;
  const indexMtime = new Date(indexMtimeMs).toISOString();

  // Walk KBs; count modified (mtime > index mtime) and new (file count vs
  // sidecar count). Pure stat — no SHA256.
  let modified = 0;
  let added = 0;
  let kbs: string[];
  try {
    kbs = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
  } catch {
    return { indexMtime, modifiedFiles: 0, newFiles: 0 };
  }

  for (const kbName of kbs) {
    const kbDir = path.join(KNOWLEDGE_BASES_ROOT_DIR, kbName);
    let allFiles: string[];
    try {
      allFiles = await getFilesRecursively(kbDir);
    } catch {
      continue;
    }
    const ingestable = await filterIngestablePaths(allFiles, kbDir);

    // Modified files: mtime advanced past index mtime.
    for (const f of ingestable) {
      try {
        const st = await fsp.stat(f);
        if (st.mtimeMs > indexMtimeMs) modified += 1;
      } catch {
        // file vanished between getFilesRecursively and stat — ignore
      }
    }

    // New files: count vs hash sidecars.
    const sidecarDir = path.join(kbDir, '.index');
    let sidecarCount = 0;
    try {
      const sidecars = await fsp.readdir(sidecarDir);
      sidecarCount = sidecars.length;
    } catch {
      // .index missing — every file is "new" relative to nothing-indexed.
      // But that case is handled by indexMtime===null above; if we got
      // here with a present index but no sidecar dir, treat as count diff.
    }
    if (ingestable.length > sidecarCount) {
      added += ingestable.length - sidecarCount;
    }
  }

  return { indexMtime, modifiedFiles: modified, newFiles: added };
}

function formatFreshnessFooter(s: Staleness, refreshed: boolean): string {
  if (s.indexMtime === null) {
    return `> _Index not yet built. Run \`kb search --refresh\` to create it._`;
  }
  if (refreshed) {
    return `> _Index refreshed at ${s.indexMtime}._`;
  }
  if (s.modifiedFiles === 0 && s.newFiles === 0) {
    return `> _Index up-to-date as of ${s.indexMtime}._`;
  }
  return (
    `> _Index may be stale: ${s.modifiedFiles} modified, ${s.newFiles} new ` +
    `file(s) since ${s.indexMtime}. Run \`kb search --refresh\` to update._`
  );
}

// ----- JSON-parse retry (pre-RFC-014 defensive belt) -------------------------

async function loadWithJsonRetry(manager: FaissIndexManager): Promise<void> {
  // Pre-RFC-014 defensive belt for the LEGACY `faiss.index/` load path only.
  // The versioned `index → index.vN/` layout (RFC 014) pre-resolves the
  // symlink before any file open, so torn JSON is structurally impossible
  // there. Legacy reads still go through `FaissStore.load(legacyPath)`
  // directly and CAN race with a concurrent legacy writer (extremely rare
  // since v014 code never writes to the legacy path). Slated for removal
  // in the same follow-up PR that drops the single-instance advisory,
  // after the legacy-cleanup task confirms no remaining users on legacy
  // layout.
  //
  // Retry once after 100 ms; if the second attempt also fails with a
  // SyntaxError, surface the documented "index appears mid-write"
  // message so the operator knows to retry.
  const isJsonParseError = (err: unknown): boolean =>
    err instanceof SyntaxError ||
    /JSON|unexpected|parse/i.test((err as Error)?.message ?? '');

  try {
    await manager.initialize({ readOnly: true });
    return;
  } catch (err) {
    if (!isJsonParseError(err)) throw err;
    logger.warn(`kb search: JSON parse error on FAISS load (likely concurrent writer); retrying in 100ms`);
  }
  await new Promise((r) => setTimeout(r, 100));
  try {
    await manager.initialize({ readOnly: true });
  } catch (err) {
    if (isJsonParseError(err)) {
      throw new Error(
        `Index appears to be mid-write (concurrent writer is updating it). ` +
        `Please retry in a moment. Underlying error: ${(err as Error).message}`,
      );
    }
    throw err;
  }
}

// ----- stdin reader ---------------------------------------------------------

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

// ----- version --------------------------------------------------------------

function getPackageVersion(): string {
  // package.json sits two levels above this file in build/ (build/cli.js
  // → ../package.json). Cheap synchronous read; runs once per CLI start.
  try {
    const here = fileURLToPath(import.meta.url);
    const pkgPath = path.join(path.dirname(here), '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// ----- driver ---------------------------------------------------------------
//
// Detect whether this module is being run as a script or imported. Naive
// string comparison of `import.meta.url` against `process.argv[1]` fails
// when invoked through the npm-install-g symlink: argv[1] is the symlink
// path (e.g. `~/.nvm/.../bin/kb`) while import.meta.url resolves to the
// canonical `build/cli.js`. realpathSync collapses the symlink so the
// comparison works in all four cases:
//   - `node build/cli.js`              (direct, dev)
//   - `./build/cli.js`                 (direct via shebang)
//   - `kb` (npm install -g symlink)    (the production case)
//   - `import { main } from './cli.js'` (test imports — driver does NOT run)
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    const resolved = realpathSync(process.argv[1]);
    return resolved === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main(process.argv).then((code) => {
    process.exit(code);
  }).catch((err) => {
    // Catastrophic top-level (transitive import failure, etc.). Emit a
    // hint about half-installed npm i -g (RFC §7 F11).
    const msg = (err as Error)?.message ?? String(err);
    if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(msg)) {
      process.stderr.write(
        `kb: ${msg}\nThis can happen mid-\`npm install -g\`. ` +
        `Wait a moment and retry.\n`,
      );
    } else {
      process.stderr.write(`kb: fatal: ${msg}\n`);
    }
    process.exit(1);
  });
}
