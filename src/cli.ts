#!/usr/bin/env node
// RFC 012 — `kb` CLI alongside the MCP server.
//
// Two subcommands:
//   - `kb list`               → list ingested knowledge bases (one per line)
//   - `kb search <query>`     → similarity search; default read-only
//                               (skips updateIndex, no write lock)
//   - `kb search --refresh`   → also runs updateIndex under the write lock
//   - `kb remember ...`       → conservative CLI write/suggest surface
//
// Both subcommands check `model_name.txt` against the configured embedding
// model on every invocation and exit non-zero on mismatch (RFC §4.7) so a
// shell-launched CLI with different env from the MCP server's mcp.json
// can't silently return wrong-vector-space results.

import { readFileSync, realpathSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { runCompare } from './cli-compare.js';
import { runList } from './cli-list.js';
import { runModels } from './cli-models.js';
import { runRemember } from './cli-remember.js';
import { runSearch } from './cli-search.js';

// ----- Entry point -----------------------------------------------------------

const HELP = `kb — knowledge-base CLI (RFC 012 + RFC 013)

Usage:
  kb list                                 List available knowledge bases.
  kb search <query> [opts]                Semantic search (read-only).
  kb search <query> --refresh             Also re-scan KB files (write path).
  kb search --stdin                       Read query from stdin.
  kb remember --suggest --kb=<name> --title=<title>
                                           Suggest likely existing note targets.
  kb remember --kb=<name> --title=<title> --stdin --yes
                                           Create a new markdown note.
  kb remember --kb=<name> --append=<path> --stdin --yes
                                           Append to an existing KB-relative note.
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

Remember options:
  --kb=<name>           Target knowledge base.
  --title=<title>       Note title; create uses a slugified .md filename.
  --append=<path>       Existing KB-relative note path; rejects traversal.
  --suggest             Read-only suggestions; does not read stdin.
  --stdin               Read note content from stdin.
  --yes                 Required for non-interactive writes.
  --refresh             Re-index the affected KB after a successful write.

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
  if (sub === 'remember') {
    return runRemember(rest);
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
