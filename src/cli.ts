#!/usr/bin/env node
// RFC 012 — `kb` CLI alongside the MCP server.
//
// Subcommands:
//   - `kb list`               → list ingested knowledge bases (one per line)
//   - `kb search <query>`     → similarity search; default read-only
//                               (skips updateIndex, no write lock)
//   - `kb search --refresh`   → also runs updateIndex under the write lock
//   - `kb remember ...`       → conservative CLI write/suggest surface
//   - `kb capture -- <cmd>`   → run a command and append its stdout to a
//                               KB note as a fenced, provenance-tagged block
//
// Both subcommands check `model_name.txt` against the configured embedding
// model on every invocation and exit non-zero on mismatch (RFC §4.7) so a
// shell-launched CLI with different env from the MCP server's mcp.json
// can't silently return wrong-vector-space results.

import { readFileSync, realpathSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { runCapture } from './cli-capture.js';
import { runCompare } from './cli-compare.js';
import { runDoctor } from './cli-doctor.js';
import { runEval } from './cli-eval.js';
import { runList } from './cli-list.js';
import { runModels } from './cli-models.js';
import { runRemember } from './cli-remember.js';
import { runSearch } from './cli-search.js';
import { runStaleCheck } from './cli-stale-check.js';
import { runSuperseded } from './cli-superseded.js';
import { runWhere } from './cli-where.js';

// ----- Entry point -----------------------------------------------------------

const HELP = `kb — knowledge-base CLI (RFC 012 + RFC 013)

Usage:
  kb list [--describe|-v] [--format=md|json]
                                           List available knowledge bases. With
                                           --describe (alias -v) include a
                                           one-line description sourced from
                                           each KB's README.md.
  kb search <query> [opts]                Semantic search (read-only).
  kb search <query> --refresh             Also re-scan KB files (write path).
  kb search --stdin                       Read query from stdin.
  kb remember --suggest --kb=<name> --title=<title>
                                           Suggest likely existing note targets.
  kb remember --kb=<name> --title=<title> --stdin --yes
                                           Create a new markdown note.
  kb remember --kb=<name> --append=<path> --stdin --yes
                                           Append to an existing KB-relative note.
  kb remember --kb=<name> --append=<path> --append-section="<#level> <text>"
             [--occurrence=<N>] --stdin --yes
                                           Append at the END of a named heading
                                           section (after all subsections), not
                                           at EOF. Heading spec must include the
                                           level prefix (e.g. "## OSS gate flow").
  kb remember --lesson --title=<title> --stdin --yes
                                           Write a generic agent-task lesson
                                           into the agent-task-lessons KB
                                           (override with --kb=<other>). Body
                                           must include "## Mistake",
                                           "## Why it happened", and
                                           "## Better next time" sections;
                                           empty or malformed input prints a
                                           guided skeleton (exit 2) instead of
                                           writing.
  kb remember ... [--similar-threshold=<float>] [--similar-k=<int>]
                  [--force] [--format=md|json] [--no-check-similar]
                                           Writes run a semantic preflight
                                           against the active index by default
                                           and refuse (exit 3) when similar
                                           chunks already exist. Bypass with
                                           --force; disable with
                                           --no-check-similar.
  kb capture --kb=<name> --append=<path> [--note=<text>] [--language=<hint>]
             [--max-bytes=<N>] [--allow-fail] [--refresh] -- <cmd> [args...]
                                           Run a command and append its stdout
                                           to a KB note as a fenced block.
  kb compare <query> <a> <b>              Side-by-side rank/score table.
  kb doctor [--format=md|json]            Aggregate model/index/backend health.
  kb eval <fixture.yml|json> [--model=<id>] [--format=md|json]
                                           Run fixture-driven retrieval checks.
  kb stale-check [--kb=<name>] [--no-cache] [--verbose]
                                           Scan markdown notes for path / URL
                                           references that no longer resolve.
                                           Strictly read-only.
  kb superseded --kb=<name> [--format=md|json] [--k=<n>] [--include-clean]
                                           Scan markdown notes for obsolete,
                                           contradicted, deprecated, stale, or
                                           semantically superseded memory
                                           candidates. Strictly read-only.
  kb where --topic=<query> [--threshold=<float>] [--k=<int>] [--format=md|json]
                                           One-shot recommendation: which KB
                                           and which file should I update for
                                           the given topic? Strictly read-only.
  kb models list                          List registered embedding models.
  kb models add <provider> <model>        Register a new model + ingest.
  kb models set-active <id>               Change the default model.
  kb models remove <id>                   Delete a model's index.
  kb --version
  kb --help

Search options:
  --kb=<name>           Scope to one knowledge base. Omit to search ALL KBs (default).
  --model=<id>          Override active model for this call (RFC 013).
  --threshold=<float>   Max similarity score (default 2).
  --k=<int>             Top-K results (default 10).
  --format=md|json      Output format (default md).
  --group-by-source     Collapse repeated chunks from the same source file in
                        markdown output. With --format=json, keeps raw
                        results and adds grouped_results.
  --refresh             Re-scan KB files; acquires per-model write lock.
  --stdin               Read query from stdin (multi-line safe).

Remember options:
  --kb=<name>           Target knowledge base.
  --title=<title>       Note title; create uses a slugified .md filename.
  --append=<path>       Existing KB-relative note path; rejects traversal.
  --append-section=<spec>
                        Heading-aware append target. Spec is "<#level> <text>"
                        (e.g. "## OSS gate flow"). Requires --append=<path>.
                        Inserts at the end of the named section (after every
                        subsection), atomically rewrites the file, and refuses
                        to fall back to EOF if the heading is missing.
  --occurrence=<N>      1-indexed disambiguation when the heading appears
                        multiple times. Requires --append-section.
  --suggest             Read-only suggestions; does not read stdin.
  --lesson              Apply the agent-task-lesson template: defaults --kb to
                        agent-task-lessons (override with --kb=<other>),
                        validates that the body has "## Mistake", "## Why it
                        happened", and "## Better next time" H2 sections
                        (level is enforced — H1 / H3 do not count), and prints
                        a guided skeleton (exit 2) when stdin is empty or
                        sections are missing instead of writing.
  --stdin               Read note content from stdin.
  --yes                 Required for non-interactive writes.
  --refresh             Re-index the affected KB after a successful write.
  --check-similar       Force the semantic preflight ON (default). Surface
                        index-load failures as exit-1/2 errors; without this
                        flag a missing index degrades to a stderr warning
                        and the write proceeds without the guard.
  --no-check-similar    Disable the semantic preflight for this write.
  --similar-threshold=<float>
                        Max FAISS distance treated as related (default 1.0;
                        lower distance = closer match).
  --similar-k=<int>     Top-K candidate chunks to surface (default 5).
  --force               Override the similarity guard and write anyway; the
                        success response reports that the guard was
                        overridden so the action stays auditable.
  --format=md|json      Output format for similarity-guard reports (default
                        json — agent-friendly machine-readable shape).
  --model=<id>          Override active model for the preflight similarity
                        search (RFC 013).

Capture options:
  --kb=<name>           Target knowledge base.
  --append=<path>       Existing KB-relative note path; rejects traversal.
  --note=<text>         Optional "### <text>" header above the captured block.
  --language=<hint>     Code-fence language hint; auto-detected from .json /
                        .yml / .yaml args if absent.
  --max-bytes=<N>       Truncate captured stdout at N bytes (default 65536).
  --allow-fail          Capture even when the command exits non-zero.
  --refresh             Re-index the affected KB after a successful write.
  --                    End of options; remaining argv is the command + args
                        passed verbatim to spawn(..., { shell: false }).

Models add options:
  --yes                 Skip the cost-estimate confirmation prompt.
  --dry-run             Print the estimate; don't embed.

Env vars: KNOWLEDGE_BASES_ROOT_DIR, FAISS_INDEX_PATH, EMBEDDING_PROVIDER,
KB_ACTIVE_MODEL (RFC 013 §4.7), OLLAMA_*, OPENAI_*, HUGGINGFACE_*.

Exit codes:
  0  success (results found or empty)
  1  runtime / index error
  2  argv / env / model-resolution error
  3  kb remember --check-similar found similar chunks and refused to write
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
    return runList(rest);
  }
  if (sub === 'search') {
    return runSearch(rest);
  }
  if (sub === 'remember') {
    return runRemember(rest);
  }
  if (sub === 'capture') {
    return runCapture(rest);
  }
  if (sub === 'models') {
    return runModels(rest);
  }
  if (sub === 'compare') {
    return runCompare(rest);
  }
  if (sub === 'doctor') {
    return runDoctor(rest);
  }
  if (sub === 'eval') {
    return runEval(rest);
  }
  if (sub === 'stale-check') {
    return runStaleCheck(rest);
  }
  if (sub === 'superseded') {
    return runSuperseded(rest);
  }
  if (sub === 'where') {
    return runWhere(rest);
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
