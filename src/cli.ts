#!/usr/bin/env node
// RFC 012 — `kb` CLI alongside the MCP server.
//
// Top-level help is built from the SUBCOMMANDS registry below; per-command
// help text lives next to each subcommand in its own `cli-<name>.ts` file
// and is intercepted here BEFORE delegating to the handler. That way every
// subcommand answers `--help` / `-h` consistently (stdout, exit 0).

import { existsSync, readFileSync, realpathSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseDotEnvText } from './config/schema.js';
import { ASK_HELP, runAsk } from './cli-ask.js';
import { BACKUP_HELP, runBackup } from './cli-backup.js';
import { CACHE_HELP, runCache } from './cli-cache.js';
import { CAPTURE_HELP, runCapture } from './cli-capture.js';
import { CITE_HELP, runCite } from './cli-cite.js';
import { COMPLETION_HELP, runCompletion } from './cli-completion.js';
import { CONFIG_HELP, runConfig } from './cli-config.js';
import { COMPARE_HELP, runCompare } from './cli-compare.js';
import { DIFF_INDEX_HELP, runDiffIndexCli } from './cli-diff-index.js';
import { DOCTOR_HELP, runDoctor } from './cli-doctor.js';
import { EVAL_HELP, runEval } from './cli-eval.js';
import { EVAL_GATE_HELP, runEvalGate } from './cli-eval-gate.js';
import { EXPLAIN_HELP, runExplain } from './cli-explain.js';
import { FEEDBACK_HELP, runFeedback } from './cli-feedback.js';
import { IMPORT_URL_HELP, runImportUrl } from './cli-import-url.js';
import { LIST_HELP, runList } from './cli-list.js';
import { LLM_HELP, runLlm } from './cli-llm.js';
import { LOGS_HELP, runLogs } from './cli-logs.js';
import { MODELS_HELP, runModels } from './cli-models.js';
import { OPEN_HELP, runOpen } from './cli-open.js';
import { PROMOTE_HELP, runPromote } from './cli-promote.js';
import { QUARANTINE_HELP, runQuarantine } from './cli-quarantine.js';
import { RELATED_HELP, runRelated } from './cli-related.js';
import { REINDEX_HELP, runReindexCli } from './cli-reindex.js';
import { REMEMBER_HELP, runRemember } from './cli-remember.js';
import { RESEARCH_HELP, runResearch } from './cli-research.js';
import { RESTORE_HELP, runRestore } from './cli-restore.js';
import { SEARCH_HELP, parseSearchArgs, runSearch, takeLastSearchCanonicalTelemetry } from './cli-search.js';
import { SERVE_HELP, runServe } from './cli-serve.js';
import { STALE_CHECK_HELP, runStaleCheck } from './cli-stale-check.js';
import { STATS_HELP, runStats } from './cli-stats.js';
import { SUPERSEDED_HELP, runSuperseded } from './cli-superseded.js';
import { VERIFY_HELP, runVerify } from './cli-verify.js';
import { WHERE_HELP, runWhere } from './cli-where.js';
import { daemonUrlFromEnv, tryRunDaemonCommand } from './daemon-client.js';
import { emitCanonicalLog } from './canonical-log.js';
import { buildDaemonSearchArgs, resolveSearchPager } from './cli-pager.js';

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

interface HelpManifestOption {
  flags: string[];
  value: string | null;
  description: string;
}

interface HelpManifestCommand {
  name: string;
  summary: string;
  usage: string[];
  options: HelpManifestOption[];
  stability: 'stable';
}

interface HelpManifestDefinition {
  name: string;
  description: string;
}

interface HelpManifestExitCode {
  code: number;
  description: string;
}

interface HelpArgs {
  command?: string;
  format: 'md' | 'json';
}

const HELP_SCHEMA_VERSION = 'kb.help.v1';
const NON_OPTION_HELP_SECTIONS = new Set([
  'Usage:',
  'Examples:',
  'Notes:',
  'Environment:',
  'Exit codes:',
]);

const SUBCOMMANDS: readonly Subcommand[] = [
  { name: 'list',         summary: 'List available knowledge bases.',                                         help: LIST_HELP,         handler: runList },
  { name: 'search',       summary: 'Semantic search across one or all knowledge bases.',                     help: SEARCH_HELP,       handler: runSearch },
  { name: 'open',         summary: 'Resolve a chunk id / kb:// URI / result path to its source file.',        help: OPEN_HELP,         handler: runOpen },
  { name: 'cite',         summary: 'Export BibTeX or CSL-JSON from note frontmatter.',                       help: CITE_HELP,         handler: runCite },
  { name: 'related',      summary: 'Find chunks related to an existing chunk id or kb:// URI.',               help: RELATED_HELP,      handler: runRelated },
  { name: 'backup',       summary: 'Create a checksum-validated active index snapshot.',                      help: BACKUP_HELP,       handler: runBackup },
  { name: 'restore',      summary: 'Validate and restore an index snapshot with an atomic swap.',             help: RESTORE_HELP,      handler: runRestore },
  { name: 'cache',        summary: 'Inspect and prune local cache surfaces.',                                help: CACHE_HELP,        handler: runCache },
  { name: 'serve',        summary: 'Run a localhost daemon for warm read-only CLI requests.',                 help: SERVE_HELP,        handler: runServe },
  { name: 'ask',          summary: 'Answer from retrieved KB context using a local LLM endpoint.',            help: ASK_HELP,          handler: runAsk },
  { name: 'remember',     summary: 'Suggest, create, or append knowledge-base notes (write path).',          help: REMEMBER_HELP,     handler: runRemember },
  { name: 'research',     summary: 'Plan and collect read-only KB evidence packets.',                       help: RESEARCH_HELP,     handler: runResearch },
  { name: 'capture',      summary: 'Run a command and append its stdout to a KB note as a fenced block.',    help: CAPTURE_HELP,      handler: runCapture },
  { name: 'config',       summary: 'Validate KB environment configuration.',                                help: CONFIG_HELP,       handler: runConfig },
  { name: 'import-url',   summary: 'Snapshot a web page or PDF into a KB note with provenance frontmatter.',  help: IMPORT_URL_HELP,   handler: runImportUrl },
  { name: 'compare',      summary: 'Side-by-side rank/score table for two embedding models.',                help: COMPARE_HELP,      handler: runCompare },
  { name: 'diff-index',   summary: 'Compare retrieval-result churn across two FAISS index versions.',        help: DIFF_INDEX_HELP,   handler: runDiffIndexCli },
  { name: 'doctor',       summary: 'Aggregate model / index / backend health report.',                       help: DOCTOR_HELP,       handler: runDoctor },
  { name: 'logs',         summary: 'Inspect historical canonical request logs.',                             help: LOGS_HELP,         handler: runLogs },
  { name: 'stats',        summary: 'Read-only index/corpus stats (mirrors the MCP kb_stats payload).',       help: STATS_HELP,        handler: runStats },
  { name: 'eval',         summary: 'Run fixture-driven retrieval checks.',                                   help: EVAL_HELP,         handler: runEval },
  { name: 'eval-gate',    summary: 'RFC 018 M0 relevance-gate validation harness (downstream answer quality).', help: EVAL_GATE_HELP,  handler: runEvalGate },
  { name: 'feedback',     summary: 'Record relevance judgments and promote them into eval fixtures.',         help: FEEDBACK_HELP,     handler: runFeedback },
  { name: 'explain',      summary: 'Verbose single-query retrieval trace for debugging and bug reports.',   help: EXPLAIN_HELP,      handler: runExplain },
  { name: 'stale-check',  summary: 'Scan markdown notes for path / URL references that no longer resolve.',  help: STALE_CHECK_HELP,  handler: runStaleCheck },
  { name: 'superseded',   summary: 'Scan a KB for obsolete / contradicted / deprecated / stale notes.',      help: SUPERSEDED_HELP,   handler: runSuperseded },
  { name: 'promote',      summary: 'Review and update lifecycle frontmatter on a KB note.',                  help: PROMOTE_HELP,      handler: runPromote },
  { name: 'quarantine',   summary: 'Inspect and manage per-file ingest quarantine entries.',                 help: QUARANTINE_HELP,   handler: runQuarantine },
  { name: 'verify',       summary: 'Run slow integrity checks for persisted indexes and sidecars.',          help: VERIFY_HELP,       handler: runVerify },
  { name: 'where',        summary: 'Recommend the best KB and file for a given topic.',                      help: WHERE_HELP,        handler: runWhere },
  { name: 'models',       summary: 'Manage embedding models (list, add, set-active, remove).',               help: MODELS_HELP,       handler: runModels },
  { name: 'llm',          summary: 'Configure local LLM endpoints and managed warm model services.',          help: LLM_HELP,          handler: runLlm },
  { name: 'reindex',      summary: 'Rebuild FAISS indexes (RFC 017 — requires --with-context).',              help: REINDEX_HELP,      handler: runReindexCli },
  { name: 'completion',   summary: 'Generate shell completions for bash, zsh, or fish.',                      help: COMPLETION_HELP,   handler: runCompletionWithCurrentManifest },
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
  kb completion bash|zsh|fish
  kb --version

Available commands:
${commandLines}

Run \`kb <command> --help\` (or \`kb help <command>\`) for command-specific help.

Environment:
  KNOWLEDGE_BASES_ROOT_DIR  Root directory containing one folder per KB.
  FAISS_INDEX_PATH          Where FAISS stores per-model indexes.
  EMBEDDING_PROVIDER        ollama | openai | huggingface
  KB_ACTIVE_MODEL           Override the active model for this process (RFC 013 §4.7).
  KB_DAEMON_URL             URL for \`kb search --daemon\` (default http://127.0.0.1:17799).
  KB_PAGER                  Pager command and opt-in for human-readable \`kb search\` output.
  KB_INGEST_SECRET_SCAN     on to quarantine credential-shaped chunks before embedding.
  KB_LLM_ENDPOINT           OpenAI-compatible endpoint used by \`kb ask\`.
  LOG_FILE                  Optional file used by \`kb logs\` and by runtime logging.
  KB_LOG_FORMAT             text | canonical | both (default both).
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

function runCompletionWithCurrentManifest(rest: string[]): Promise<number> {
  return runCompletion(rest, buildTopLevelHelpManifest().commands);
}

// ----- Entry point ----------------------------------------------------------

function wantsHelp(args: readonly string[]): boolean {
  return args.some((a) => a === '--help' || a === '-h');
}

interface ClosestSuggestion {
  value: string;
  distance: number;
}

interface UnknownFlagSuggestion {
  raw: string;
  suggestion: string;
}

// Load the package-root `.env` (gitignored) so a kb-local file can hold
// secrets like KB_OPENROUTER_API_KEY — consistent with how local-research-agent
// and kookr load their own `.env`. Real process-env values always win, so this
// only fills variables that are otherwise unset. Failures are non-fatal.
function loadKbDotEnv(): void {
  try {
    const here = fileURLToPath(import.meta.url);
    const envPath = path.join(path.dirname(here), '..', '.env');
    if (!existsSync(envPath)) return;
    const { env } = parseDotEnvText(readFileSync(envPath, 'utf-8'), envPath);
    for (const [key, value] of Object.entries(env)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // A malformed or unreadable .env must never block the CLI.
  }
}

export async function main(argv: string[]): Promise<number> {
  loadKbDotEnv();
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
    if (wantsHelp(rest)) {
      process.stdout.write(HELP);
      return 0;
    }
    let helpArgs: HelpArgs;
    try {
      helpArgs = parseHelpArgs(rest);
    } catch (err) {
      process.stderr.write(`kb help: ${(err as Error).message}\n`);
      return 2;
    }
    if (helpArgs.command === undefined) {
      if (helpArgs.format === 'json') writeJson(buildTopLevelHelpManifest());
      else process.stdout.write(HELP);
      return 0;
    }
    const target = SUBCOMMANDS.find((s) => s.name === helpArgs.command);
    if (!target) {
      process.stderr.write(
        `kb help: unknown command '${helpArgs.command}'\n${formatCommandSuggestion(helpArgs.command, 'help')}`,
      );
      return 2;
    }
    if (helpArgs.format === 'json') {
      writeJson({
        schema_version: HELP_SCHEMA_VERSION,
        command: buildCommandHelpManifest(target),
      });
    } else {
      process.stdout.write(target.help);
    }
    return 0;
  }

  const target = SUBCOMMANDS.find((s) => s.name === sub);
  if (!target) {
    process.stderr.write(`kb: unknown subcommand '${sub}'\n${formatCommandSuggestion(sub, 'run')}${HELP}`);
    return 2;
  }

  if (wantsHelp(rest)) {
    process.stdout.write(target.help);
    return 0;
  }

  if (sub === 'completion') {
    return target.handler(rest);
  }

  const unknownFlag = findUnknownFlag(rest, buildCommandHelpManifest(target).options);
  const operation = unknownFlag !== null
    ? async () => {
        process.stderr.write(formatUnknownFlagMessage(target.name, unknownFlag));
        return 2;
      }
    : sub === 'search'
      ? () => runSearchMaybeViaDaemon(rest)
      : () => target.handler(rest);
  return runSubcommandWithCanonicalLog(target, operation);
}

function formatCommandSuggestion(input: string, mode: 'help' | 'run'): string {
  const suggestion = closestSuggestion(input, SUBCOMMANDS.map((command) => command.name));
  if (suggestion === undefined) return '';
  const command = mode === 'help' ? `kb help ${suggestion.value}` : `kb ${suggestion.value}`;
  return `Did you mean ${command}?\n`;
}

function findUnknownFlag(
  args: readonly string[],
  options: readonly HelpManifestOption[],
): UnknownFlagSuggestion | null {
  const validFlags = new Set(options.flatMap((option) => option.flags));
  const candidates = [...validFlags].filter((flag) => flag !== '--');

  for (const raw of args) {
    if (raw === '--') return null;
    const flag = flagNameFromArg(raw);
    if (flag === null || validFlags.has(flag)) continue;
    const suggestion = closestSuggestion(flag, candidates)?.value;
    if (suggestion === undefined) continue;
    return {
      raw,
      suggestion,
    };
  }
  return null;
}

function flagNameFromArg(raw: string): string | null {
  if (!raw.startsWith('--')) return null;
  const eqIndex = raw.indexOf('=');
  return eqIndex === -1 ? raw : raw.slice(0, eqIndex);
}

function formatUnknownFlagMessage(command: string, unknown: UnknownFlagSuggestion): string {
  return `kb ${command}: unknown flag: ${unknown.raw}\nDid you mean ${unknown.suggestion}?\n`;
}

function closestSuggestion(input: string, candidates: readonly string[]): ClosestSuggestion | undefined {
  let best: ClosestSuggestion | undefined;
  for (const candidate of candidates) {
    const distance = levenshteinDistance(input, candidate);
    if (
      best === undefined
      || distance < best.distance
      || (distance === best.distance && candidate.length < best.value.length)
      || (distance === best.distance && candidate.length === best.value.length && candidate < best.value)
    ) {
      best = { value: candidate, distance };
    }
  }
  if (best === undefined || best.distance > suggestionDistanceThreshold(input)) return undefined;
  return best;
}

function suggestionDistanceThreshold(input: string): number {
  return Math.max(1, Math.floor(input.length / 3));
}

function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + substitutionCost,
      );
    }
  }
  return dp[a.length][b.length];
}

function parseHelpArgs(rest: readonly string[]): HelpArgs {
  const out: HelpArgs = { format: 'md' };
  for (const raw of rest) {
    if (raw === '--format=json') {
      out.format = 'json';
      continue;
    }
    if (raw === '--format=md') {
      out.format = 'md';
      continue;
    }
    if (raw.startsWith('--format=')) {
      throw new Error(`invalid --format: ${raw}`);
    }
    if (raw.startsWith('--')) {
      throw new Error(`unknown flag: ${raw}`);
    }
    if (out.command === undefined) {
      out.command = raw;
    }
  }
  return out;
}

function writeJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function buildTopLevelHelpManifest() {
  return {
    schema_version: HELP_SCHEMA_VERSION,
    command: 'kb',
    usage: extractUsageLines(HELP),
    commands: SUBCOMMANDS.map(buildCommandHelpManifest),
    environment: extractDefinitionList(HELP, 'Environment:'),
    exit_codes: extractExitCodes(HELP),
    stability: 'stable' as const,
  };
}

function buildCommandHelpManifest(command: Subcommand): HelpManifestCommand {
  return {
    name: command.name,
    summary: command.summary,
    usage: extractUsageLines(command.help),
    options: extractOptions(command.help),
    stability: 'stable',
  };
}

function extractUsageLines(help: string): string[] {
  const lines = help.split('\n');
  const usageIndex = lines.findIndex((line) => line.trim() === 'Usage:');
  if (usageIndex === -1) return [];
  const usage: string[] = [];
  for (let i = usageIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      if (usage.length === 0) continue;
      const nextContent = lines.slice(i + 1).find((nextLine) => nextLine.trim() !== '');
      if (nextContent !== undefined && nextContent.startsWith('  ')) continue;
      break;
    }
    if (!line.startsWith('  ')) break;
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      continue;
    }
    usage.push(trimmed);
  }
  return usage;
}

function extractOptions(help: string): HelpManifestOption[] {
  const options: HelpManifestOption[] = [];
  let current: HelpManifestOption | null = null;
  let inOptionSection = false;
  for (const line of help.split('\n')) {
    if (!line.startsWith(' ') && line.trim().endsWith(':')) {
      inOptionSection = isOptionMetadataSection(line.trim());
      current = null;
      continue;
    }
    if (!inOptionSection) {
      continue;
    }
    const optionLine = parseOptionLine(line);
    if (optionLine !== null) {
      current = optionLine;
      options.push(optionLine);
      continue;
    }
    if (current !== null && isContinuationLine(line)) {
      current.description = appendDescription(current.description, line.trim());
    } else if (line.trim() === '') {
      current = null;
    }
  }
  addUsageOptions(options, extractUsageLines(help));
  return options;
}

function isOptionMetadataSection(heading: string): boolean {
  return !NON_OPTION_HELP_SECTIONS.has(heading);
}

function parseOptionLine(line: string): HelpManifestOption | null {
  if (!line.startsWith('  ')) return null;
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('-')) return null;
  const match = /^(\S+(?:,\s+\S+)*)\s{2,}(.*)$/.exec(trimmed);
  const flagSpec = match?.[1] ?? trimmed;
  const parsedFlags = parseFlagSpec(flagSpec);
  if (parsedFlags.flags.length === 0) return null;
  return {
    flags: parsedFlags.flags,
    value: parsedFlags.value,
    description: match?.[2]?.trim() ?? '',
  };
}

function parseFlagSpec(flagSpec: string): { flags: string[]; value: string | null } {
  const flags: string[] = [];
  let value: string | null = null;
  for (const rawPart of flagSpec.split(',')) {
    const part = rawPart.trim();
    if (part === '') continue;
    const eqIndex = part.indexOf('=');
    const flag = eqIndex === -1 ? part : part.slice(0, eqIndex);
    if (!isHelpFlagToken(flag)) continue;
    flags.push(flag);
    if (eqIndex !== -1 && value === null) value = part.slice(eqIndex + 1);
  }
  return { flags, value };
}

function addUsageOptions(options: HelpManifestOption[], usageLines: string[]): void {
  const seen = new Set(options.flatMap((option) => option.flags));
  for (const usageLine of usageLines) {
    for (const flagSpec of usageFlagSpecs(usageLine)) {
      const parsed = parseFlagSpec(flagSpec);
      const newFlags = parsed.flags.filter((flag) => !seen.has(flag));
      if (newFlags.length === 0) continue;
      for (const flag of newFlags) seen.add(flag);
      options.push({
        flags: newFlags,
        value: parsed.value,
        description: '',
      });
    }
  }
}

function usageFlagSpecs(usageLine: string): string[] {
  const specs: string[] = [];
  const matches = usageLine.match(/--[A-Za-z0-9][A-Za-z0-9-]*(?:=[^\s\]]+)?/g) ?? [];
  for (const match of matches) {
    if (match.includes('|--')) {
      specs.push(...match.split('|').filter((part) => part.startsWith('--')));
    } else {
      specs.push(match);
    }
  }
  return specs;
}

function isHelpFlagToken(value: string): boolean {
  return value === '--' || /^--?[A-Za-z0-9][A-Za-z0-9-]*$/.test(value);
}

function extractDefinitionList(help: string, heading: string): HelpManifestDefinition[] {
  const lines = help.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex === -1) return [];
  const definitions: HelpManifestDefinition[] = [];
  let current: HelpManifestDefinition[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (line.trim() === '') {
      if (definitions.length > 0) break;
      continue;
    }
    if (!line.startsWith('  ')) break;
    if (isDefinitionContinuationLine(line) && current.length > 0) {
      for (const definition of current) {
        definition.description = appendDescription(definition.description, line.trim());
      }
      continue;
    }
    const match = /^ {2}(.+?)\s{2,}(.*)$/.exec(line);
    if (match) {
      current = pushDefinitions(definitions, match[1], match[2].trim());
      continue;
    }
    current = pushDefinitions(definitions, line.trim(), '');
  }
  return definitions;
}

function pushDefinitions(
  definitions: HelpManifestDefinition[],
  namesText: string,
  description: string,
): HelpManifestDefinition[] {
  const current = namesText.split(',').map((name) => ({
    name: name.trim(),
    description,
  })).filter((definition) => definition.name !== '');
  definitions.push(...current);
  return current;
}

function extractExitCodes(help: string): HelpManifestExitCode[] {
  const lines = help.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim() === 'Exit codes:');
  if (headingIndex === -1) return [];
  const exitCodes: HelpManifestExitCode[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (line.trim() === '') {
      if (exitCodes.length > 0) break;
      continue;
    }
    const match = /^ {2}(\d+)\s{2,}(.*)$/.exec(line);
    if (!match) break;
    exitCodes.push({ code: Number(match[1]), description: match[2].trim() });
  }
  return exitCodes;
}

function isContinuationLine(line: string): boolean {
  return line.startsWith('                        ') && line.trim() !== '';
}

function isDefinitionContinuationLine(line: string): boolean {
  return /^ {4,}\S/.test(line);
}

function appendDescription(description: string, continuation: string): string {
  return description === '' ? continuation : `${description} ${continuation}`;
}

async function runSubcommandWithCanonicalLog(
  target: Subcommand,
  operation: () => Promise<number>,
): Promise<number> {
  const startedAt = Date.now();
  try {
    const code = await operation();
    const searchExtra = target.name === 'search'
      ? takeLastSearchCanonicalTelemetry() ?? {}
      : {};
    emitCanonicalLog({
      process: 'cli',
      cmd: `kb ${target.name}`,
      ...searchExtra,
      took_ms: Date.now() - startedAt,
      error: code === 0 ? undefined : {
        code: `EXIT_${code}`,
        category: code === 2 ? 'input' : 'unknown',
      },
    });
    return code;
  } catch (error: unknown) {
    emitCanonicalLog({
      process: 'cli',
      cmd: `kb ${target.name}`,
      took_ms: Date.now() - startedAt,
      error: {
        code: (error as { code?: string })?.code ?? 'INTERNAL',
        category: 'unknown',
      },
    });
    throw error;
  }
}

async function runSearchMaybeViaDaemon(rest: string[]): Promise<number> {
  const daemonIndex = rest.indexOf('--daemon');
  if (daemonIndex === -1) return runSearch(rest);

  const directRest = rest.filter((arg) => arg !== '--daemon');
  if (directRest.includes('--refresh')) {
    return runSearch(directRest);
  }
  if (await shouldRunSearchLocallyForPager(directRest)) {
    return runSearch(directRest);
  }

  const startedAt = Date.now();
  const daemonResult = await tryRunDaemonCommand('search', buildDaemonSearchArgs(directRest));
  if (daemonResult === null) {
    // The daemon was unreachable: tell the operator the search still ran,
    // just directly, and how long the daemon probe cost before falling back.
    process.stderr.write(
      `kb search: daemon unavailable${daemonUrlSuffix()}; ran search directly `
      + `(fell back after ${Date.now() - startedAt}ms)\n`,
    );
    return runSearch(directRest);
  }
  if (daemonResult.stdout !== '') process.stdout.write(daemonResult.stdout);
  if (daemonResult.stderr !== '') process.stderr.write(daemonResult.stderr);
  return daemonResult.exitCode;
}

async function shouldRunSearchLocallyForPager(rest: string[]): Promise<boolean> {
  try {
    const parsed = parseSearchArgs(rest);
    return await resolveSearchPager({
      flag: parsed.pager,
      format: parsed.format,
      env: process.env,
      stdoutIsTTY: process.stdout.isTTY === true,
    }) !== null;
  } catch {
    return false;
  }
}

/** ` at <url>` for the fallback notice, or '' when the daemon URL is unset. */
function daemonUrlSuffix(): string {
  try {
    return ` at ${daemonUrlFromEnv().href}`;
  } catch {
    return '';
  }
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
