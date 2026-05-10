#!/usr/bin/env node
// RFC 012 — `kb` CLI alongside the MCP server.
//
// Top-level help is built from the SUBCOMMANDS registry below; per-command
// help text lives next to each subcommand in its own `cli-<name>.ts` file
// and is intercepted here BEFORE delegating to the handler. That way every
// subcommand answers `--help` / `-h` consistently (stdout, exit 0).

import { readFileSync, realpathSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { CAPTURE_HELP, runCapture } from './cli-capture.js';
import { COMPARE_HELP, runCompare } from './cli-compare.js';
import { DOCTOR_HELP, runDoctor } from './cli-doctor.js';
import { EVAL_HELP, runEval } from './cli-eval.js';
import { LIST_HELP, runList } from './cli-list.js';
import { MODELS_HELP, runModels } from './cli-models.js';
import { REMEMBER_HELP, runRemember } from './cli-remember.js';
import { SEARCH_HELP, runSearch } from './cli-search.js';
import { STALE_CHECK_HELP, runStaleCheck } from './cli-stale-check.js';
import { STATS_HELP, runStats } from './cli-stats.js';
import { SUPERSEDED_HELP, runSuperseded } from './cli-superseded.js';
import { WHERE_HELP, runWhere } from './cli-where.js';

// ----- Subcommand registry --------------------------------------------------

interface Subcommand {
  /** Verb used on the command line, e.g. `search`. */
  name: string;
  /** One-line summary for the top-level command list. */
  summary: string;
  /** Full help text shown by `kb <name> --help` and `kb help <name>`. */
  help: string;
  /** Argv handler. */
  handler: (rest: string[]) => Promise<number>;
}

const SUBCOMMANDS: readonly Subcommand[] = [
  { name: 'list',         summary: 'List available knowledge bases.',                                         help: LIST_HELP,         handler: runList },
  { name: 'search',       summary: 'Semantic search across one or all knowledge bases.',                     help: SEARCH_HELP,       handler: runSearch },
  { name: 'remember',     summary: 'Suggest, create, or append knowledge-base notes (write path).',          help: REMEMBER_HELP,     handler: runRemember },
  { name: 'capture',      summary: 'Run a command and append its stdout to a KB note as a fenced block.',    help: CAPTURE_HELP,      handler: runCapture },
  { name: 'compare',      summary: 'Side-by-side rank/score table for two embedding models.',                help: COMPARE_HELP,      handler: runCompare },
  { name: 'doctor',       summary: 'Aggregate model / index / backend health report.',                       help: DOCTOR_HELP,       handler: runDoctor },
  { name: 'stats',        summary: 'Read-only index/corpus stats (mirrors the MCP kb_stats payload).',       help: STATS_HELP,        handler: runStats },
  { name: 'eval',         summary: 'Run fixture-driven retrieval checks.',                                   help: EVAL_HELP,         handler: runEval },
  { name: 'stale-check',  summary: 'Scan markdown notes for path / URL references that no longer resolve.',  help: STALE_CHECK_HELP,  handler: runStaleCheck },
  { name: 'superseded',   summary: 'Scan a KB for obsolete / contradicted / deprecated / stale notes.',      help: SUPERSEDED_HELP,   handler: runSuperseded },
  { name: 'where',        summary: 'Recommend the best KB and file for a given topic.',                      help: WHERE_HELP,        handler: runWhere },
  { name: 'models',       summary: 'Manage embedding models (list, add, set-active, remove).',               help: MODELS_HELP,       handler: runModels },
];

// ----- Top-level help -------------------------------------------------------

function buildTopLevelHelp(): string {
  const nameWidth = SUBCOMMANDS.reduce((m, s) => Math.max(m, s.name.length), 0);
  const commandLines = SUBCOMMANDS
    .map((s) => `  ${s.name.padEnd(nameWidth)}   ${s.summary}`)
    .join('\n');
  return `kb — knowledge-base CLI (RFC 012 + RFC 013)

Usage:
  kb <command> [options]
  kb help [<command>]
  kb <command> --help
  kb --version

Available commands:
${commandLines}

Run \`kb <command> --help\` (or \`kb help <command>\`) for command-specific help.

Environment:
  KNOWLEDGE_BASES_ROOT_DIR  Root directory containing one folder per KB.
  FAISS_INDEX_PATH          Where FAISS stores per-model indexes.
  EMBEDDING_PROVIDER        ollama | openai | huggingface
  KB_ACTIVE_MODEL           Override the active model for this process (RFC 013 §4.7).
  OLLAMA_*, OPENAI_*, HUGGINGFACE_*
                            Provider-specific config; see the provider's docs.

Exit codes:
  0   success (results found or empty)
  1   runtime / index error
  2   argv / env / model-resolution error
  3   \`kb remember\` similarity guard refused to write
`;
}

const HELP = buildTopLevelHelp();

// ----- Entry point ----------------------------------------------------------

function wantsHelp(args: readonly string[]): boolean {
  return args.some((a) => a === '--help' || a === '-h');
}

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

  // `kb help` and `kb help <command>` mirror `kb --help` and `kb <command> --help`.
  if (sub === 'help') {
    if (rest.length === 0 || wantsHelp(rest)) {
      process.stdout.write(HELP);
      return 0;
    }
    const target = SUBCOMMANDS.find((s) => s.name === rest[0]);
    if (!target) {
      process.stderr.write(`kb help: unknown command '${rest[0]}'\n`);
      return 2;
    }
    process.stdout.write(target.help);
    return 0;
  }

  const target = SUBCOMMANDS.find((s) => s.name === sub);
  if (!target) {
    process.stderr.write(`kb: unknown subcommand '${sub}'\n${HELP}`);
    return 2;
  }

  if (wantsHelp(rest)) {
    process.stdout.write(target.help);
    return 0;
  }

  return target.handler(rest);
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
