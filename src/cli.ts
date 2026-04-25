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
import { FaissIndexManager, faissIndexBinaryPath, readStoredModelName } from './FaissIndexManager.js';
import {
  EMBEDDING_PROVIDER,
  FAISS_INDEX_PATH,
  FRONTMATTER_EXTRAS_WIRE_VISIBLE,
  HUGGINGFACE_MODEL_NAME,
  KNOWLEDGE_BASES_ROOT_DIR,
  OLLAMA_MODEL,
  OPENAI_MODEL_NAME,
} from './config.js';
import { formatRetrievalAsJson, formatRetrievalAsMarkdown } from './formatter.js';
import { listKnowledgeBases } from './kb-fs.js';
import { withWriteLock } from './lock.js';
import { logger } from './logger.js';
import { filterIngestablePaths, getFilesRecursively } from './utils.js';
import { readFileSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ----- Argv types ------------------------------------------------------------

interface SearchArgs {
  query: string | null; // null when --stdin and stdin not yet read
  kb?: string;
  threshold?: number;
  k: number;
  format: 'md' | 'json';
  refresh: boolean;
  stdin: boolean;
}

// ----- Entry point -----------------------------------------------------------

const HELP = `kb — knowledge-base CLI (RFC 012)

Usage:
  kb list                         List available knowledge bases.
  kb search <query> [opts]        Semantic search (read-only).
  kb search <query> --refresh     Also re-scan KB files (write path).
  kb search --stdin               Read query from stdin.
  kb --version
  kb --help

Search options:
  --kb=<name>           Scope to one knowledge base.
  --threshold=<float>   Max similarity score (default 2).
  --k=<int>             Top-K results (default 10).
  --format=md|json      Output format (default md).
  --refresh             Re-scan KB files; acquires write lock briefly.
  --stdin               Read query from stdin (multi-line safe).

Env vars (same as MCP server): KNOWLEDGE_BASES_ROOT_DIR, FAISS_INDEX_PATH,
EMBEDDING_PROVIDER, OLLAMA_*, OPENAI_*, HUGGINGFACE_*.

Exit codes:
  0  success (results found or empty)
  1  runtime / index error
  2  argv / env / model-mismatch error
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

  process.stderr.write(`kb: unknown subcommand '${sub}'\n${HELP}`);
  return 2;
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

  // Model-mismatch check (RFC §4.7). Both default and --refresh paths.
  // --refresh handles the recreate; default exits with a clear error.
  const mismatch = await checkModelMismatch();
  if (mismatch) {
    if (!parsed.refresh) {
      process.stderr.write(mismatch.errorMessage);
      return 2;
    }
    // --refresh: emit warning, let updateIndex trigger the recreate path.
    process.stderr.write(mismatch.warningMessage);
  }

  // Suppress logger noise on stdout; everything goes to stderr but the
  // existing logger already only writes to stderr. Reading the env-driven
  // LOG_LEVEL is the operator's control.

  let manager: FaissIndexManager;
  try {
    manager = new FaissIndexManager();
  } catch (err) {
    process.stderr.write(`kb search: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    if (parsed.refresh) {
      await withWriteLock(async () => {
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
  const staleness = await computeStaleness();

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

// ----- model-mismatch check (RFC §4.7) --------------------------------------

interface ModelMismatch {
  errorMessage: string;
  warningMessage: string;
}

function configuredModelName(): string {
  switch (EMBEDDING_PROVIDER) {
    case 'openai': return OPENAI_MODEL_NAME;
    case 'ollama': return OLLAMA_MODEL;
    default: return HUGGINGFACE_MODEL_NAME;
  }
}

async function checkModelMismatch(): Promise<ModelMismatch | null> {
  const stored = await readStoredModelName().catch(() => null);
  if (stored === null) return null; // fresh index — no mismatch possible
  const configured = configuredModelName();
  if (stored === configured) return null;

  const errorMessage =
    `Error: Embedding model mismatch.\n` +
    `  Index built with: ${stored}\n` +
    `  Current config:   ${configured}\n` +
    `These produce different vector spaces; query results would be meaningless.\n` +
    `Options:\n` +
    `  1. Set EMBEDDING_PROVIDER / model env vars to match the index, or\n` +
    `  2. Run \`kb search --refresh\` to rebuild the index with the current model\n` +
    `     (multi-minute on first call).\n`;
  const warningMessage =
    `Warning: Embedding model mismatch (index: ${stored}, configured: ${configured}). ` +
    `--refresh will trigger a full re-embed.\n`;
  return { errorMessage, warningMessage };
}

// ----- staleness pre-check (RFC §4.10) --------------------------------------

interface Staleness {
  indexMtime: string | null;
  modifiedFiles: number;
  newFiles: number;
}

async function computeStaleness(): Promise<Staleness> {
  // Index mtime — target the inner binary file (NOT the directory; round-3
  // mtime correction).
  const binaryPath = faissIndexBinaryPath();
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

// ----- JSON-parse retry (RFC §7 N4 mitigation) -------------------------------

async function loadWithJsonRetry(manager: FaissIndexManager): Promise<void> {
  // FaissStore.save is non-atomic (mkdir-p + parallel writes of faiss.index +
  // docstore.json, no rename). A concurrent CLI read can land mid-write and
  // see partial JSON. Retry once after 100 ms; if the second attempt also
  // fails with a SyntaxError, surface the documented "index appears mid-write"
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

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/cli.js')) {
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
