import { existsSync, readFileSync } from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { hashQuery } from './canonical-log.js';
import {
  parseCanonicalLogLines,
  type CanonicalLogRecord,
} from './cli-logs.js';
import { runExplain } from './cli-explain.js';
import {
  combineRedactionSummaries,
  redactSecrets,
  type RedactionSummary,
} from './redaction.js';

export const DIAGNOSE_HELP = `kb diagnose — package a canonical request log as a repro bundle

Usage:
  kb diagnose --request-id=<id> --repro-bundle=<dir> [--file=<path>] [--query=<text>|--query-file=<path>|--stdin] [--include-content] [--force] [--format=md|json]

Reads canonical logs for one request id and writes a private diagnostic bundle
with redacted log context. When the raw query is supplied, it also replays
\`kb explain --repro-bundle\` using model, KB scope, k, and threshold hints from
the selected canonical event when available.

Options:
  --request-id=<id>       Canonical request id to package.
  --repro-bundle=<dir>    Output directory for the diagnostic bundle.
  --file=<path>           Log file to read. Defaults to LOG_FILE, then known
                          local log paths if they exist.
  --query=<text>          Raw query to replay with kb explain. Canonical logs
                          store only query_sha256 and query_len_chars.
  --query-file=<path>     Read the raw query from a UTF-8 file.
  --stdin                 Read the raw query from stdin.
  --include-content       Forward to kb explain; includes candidate chunk text.
                          Requires a raw query.
  --force                 Chmod unsafe existing bundle directories to 0700.
  --format=md|json        Output format (default: md).
  --help, -h              Show this help.

Examples:
  kb diagnose --request-id=maw6d3qfabcd1234 --repro-bundle=/tmp/kb-diag
  kb diagnose --request-id=maw6d3qfabcd1234 --query-file=query.txt --repro-bundle=/tmp/kb-diag
`;

const DIAGNOSE_SCHEMA_VERSION = 'kb.diagnose.repro_bundle.v1';
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const UNSAFE_DIR_MODE_MASK = 0o077;
const DIAGNOSE_BUNDLE_FILENAMES = new Set([
  'README.md',
  'canonical-events.json',
  'explain-stderr.txt',
  'manifest.json',
]);

type DiagnoseFormat = 'md' | 'json';
type QuerySource = '--query' | '--query-file' | 'stdin';

export interface DiagnoseArgs {
  requestId?: string;
  reproBundle?: string;
  file?: string;
  query?: string;
  queryFile?: string;
  stdin: boolean;
  includeContent: boolean;
  force: boolean;
  format: DiagnoseFormat;
}

export interface DiagnoseDeps {
  readFile: (filePath: string) => string;
  exists: (filePath: string) => boolean;
  env: NodeJS.ProcessEnv;
  cwd: () => string;
  homedir: () => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
  runExplain: (rest: string[]) => Promise<number>;
  now: () => Date;
}

interface DiagnoseManifest {
  schema_version: typeof DIAGNOSE_SCHEMA_VERSION;
  bundle_dir: string;
  created_at: string;
  source_log: string;
  request_id: string;
  event_count: number;
  selected_event: {
    ts?: string;
    cmd?: string;
    tool?: string;
    model_id?: string;
    kb_scope?: string | null;
    query_sha256?: string;
    query_len_chars?: number;
    k?: number;
    threshold?: number;
    took_ms?: number;
    degraded?: true;
  };
  raw_query: {
    supplied: boolean;
    source: QuerySource | null;
    query_sha256_matches: boolean | null;
    query_len_chars_matches: boolean | null;
  };
  explain: {
    attempted: boolean;
    exit_code: number | null;
    bundle_dir: string | null;
    inferred_args: string[];
    stderr_file: string | null;
  };
  files: string[];
  redaction_summary: RedactionSummary;
}

const DEFAULT_DEPS: DiagnoseDeps = {
  readFile: (filePath) => readFileSync(filePath, 'utf-8'),
  exists: (filePath) => existsSync(filePath),
  env: process.env,
  cwd: () => process.cwd(),
  homedir: () => os.homedir(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin: readProcessStdin,
  runExplain,
  now: () => new Date(),
};

export async function runDiagnose(
  rest: string[],
  deps: DiagnoseDeps = DEFAULT_DEPS,
): Promise<number> {
  let args: DiagnoseArgs;
  try {
    args = parseDiagnoseArgs(rest);
  } catch (err) {
    deps.stderr(`kb diagnose: ${(err as Error).message}\n`);
    return 2;
  }

  if (args.requestId === undefined) {
    deps.stderr('kb diagnose: missing --request-id=<id>\n');
    return 2;
  }
  if (args.reproBundle === undefined) {
    deps.stderr('kb diagnose: missing --repro-bundle=<dir>\n');
    return 2;
  }

  let rawQuery: { value: string; source: QuerySource } | null;
  try {
    rawQuery = await resolveRawQuery(args, deps);
  } catch (err) {
    deps.stderr(`kb diagnose: ${(err as Error).message}\n`);
    return 2;
  }
  if (args.includeContent && rawQuery === null) {
    deps.stderr('kb diagnose: --include-content requires --query, --query-file, or --stdin\n');
    return 2;
  }

  const source = resolveLogFile(args, deps);
  if (source === null) {
    deps.stderr('kb diagnose: no log file found; pass --file=<path> or set LOG_FILE\n');
    return 2;
  }

  let events: CanonicalLogRecord[];
  try {
    events = parseCanonicalLogLines(deps.readFile(source))
      .events
      .filter((event) => event.request_id === args.requestId);
  } catch (err) {
    deps.stderr(`kb diagnose: failed to read ${source}: ${(err as Error).message}\n`);
    return 1;
  }

  if (events.length === 0) {
    deps.stderr(`kb diagnose: no canonical events found for request id ${args.requestId}\n`);
    return 1;
  }

  const bundleDir = expandPath(args.reproBundle, deps);
  try {
    await ensurePrivateDiagnoseDirectory(bundleDir, args.force);
  } catch (err) {
    deps.stderr(`kb diagnose: failed to prepare bundle: ${(err as Error).message}\n`);
    return 1;
  }

  const files: string[] = [];
  const redactions: RedactionSummary[] = [];

  try {
    const canonical = redactSecrets(`${JSON.stringify({
      schema_version: DIAGNOSE_SCHEMA_VERSION,
      source_log: source,
      request_id: args.requestId,
      events,
    }, null, 2)}\n`);
    await writePrivateUtf8File(bundleDir, 'canonical-events.json', canonical.text);
    files.push('canonical-events.json');
    redactions.push(canonical.summary);

    const selectedEvent = chooseSelectedEvent(events);
    let explainExitCode: number | null = null;
    let explainStderrFile: string | null = null;
    let inferredArgs: string[] = [];

    if (rawQuery !== null) {
      const explainBundleRel = 'explain';
      const explainBundleDir = path.join(bundleDir, explainBundleRel);
      inferredArgs = buildExplainArgs(rawQuery.value, selectedEvent, explainBundleDir, args);
      const captured = await runExplainCaptured(inferredArgs, deps.runExplain);
      explainExitCode = captured.code;
      if (captured.stderr.trim() !== '') {
        const stderrRedacted = redactSecrets(captured.stderr);
        await writePrivateUtf8File(bundleDir, 'explain-stderr.txt', stderrRedacted.text);
        files.push('explain-stderr.txt');
        redactions.push(stderrRedacted.summary);
        explainStderrFile = 'explain-stderr.txt';
      }
      if (deps.exists(explainBundleDir)) {
        files.push(explainBundleRel);
      }
    }

    const manifest = buildManifest({
      bundleDir,
      source,
      requestId: args.requestId,
      events,
      selectedEvent,
      rawQuery,
      explainExitCode,
      explainBundleDir: rawQuery === null ? null : 'explain',
      inferredArgs,
      explainStderrFile,
      files: [...files, 'README.md', 'manifest.json'].sort(),
      redactionSummary: combineRedactionSummaries(true, ...redactions),
      now: deps.now(),
    });

    await writePrivateUtf8File(bundleDir, 'README.md', formatReadme(manifest));
    await writePrivateUtf8File(bundleDir, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    if (args.format === 'json') {
      deps.stdout(`${JSON.stringify(manifest, null, 2)}\n`);
    } else {
      deps.stdout(formatMarkdownResult(manifest));
    }
    return 0;
  } catch (err) {
    deps.stderr(`kb diagnose: failed to write bundle: ${(err as Error).message}\n`);
    return 1;
  }
}

export function parseDiagnoseArgs(rest: string[]): DiagnoseArgs {
  const out: DiagnoseArgs = {
    stdin: false,
    includeContent: false,
    force: false,
    format: 'md',
  };
  for (const raw of rest) {
    if (raw.startsWith('--request-id=')) {
      const value = raw.slice('--request-id='.length);
      if (value === '') throw new Error('empty --request-id value');
      out.requestId = value;
      continue;
    }
    if (raw.startsWith('--repro-bundle=')) {
      const value = raw.slice('--repro-bundle='.length);
      if (value === '') throw new Error('empty --repro-bundle value');
      out.reproBundle = value;
      continue;
    }
    if (raw.startsWith('--file=')) {
      const value = raw.slice('--file='.length);
      if (value === '') throw new Error('empty --file value');
      out.file = value;
      continue;
    }
    if (raw.startsWith('--query=')) {
      out.query = raw.slice('--query='.length);
      continue;
    }
    if (raw.startsWith('--query-file=')) {
      const value = raw.slice('--query-file='.length);
      if (value === '') throw new Error('empty --query-file value');
      out.queryFile = value;
      continue;
    }
    if (raw === '--stdin') {
      out.stdin = true;
      continue;
    }
    if (raw === '--include-content') {
      out.includeContent = true;
      continue;
    }
    if (raw === '--force') {
      out.force = true;
      continue;
    }
    if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length);
      if (value !== 'md' && value !== 'json') throw new Error(`invalid --format: ${raw}`);
      out.format = value;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
  }

  const querySources = [
    out.query !== undefined,
    out.queryFile !== undefined,
    out.stdin,
  ].filter(Boolean).length;
  if (querySources > 1) {
    throw new Error('choose at most one of --query, --query-file, or --stdin');
  }
  return out;
}

async function resolveRawQuery(
  args: DiagnoseArgs,
  deps: DiagnoseDeps,
): Promise<{ value: string; source: QuerySource } | null> {
  if (args.query !== undefined) {
    if (args.query.trim() === '') throw new Error('empty --query value');
    return { value: args.query, source: '--query' };
  }
  if (args.queryFile !== undefined) {
    const queryPath = expandPath(args.queryFile, deps);
    const value = deps.readFile(queryPath);
    if (value.trim() === '') throw new Error(`${queryPath} does not contain a query`);
    return { value: value.trimEnd(), source: '--query-file' };
  }
  if (args.stdin) {
    const value = await deps.readStdin();
    if (value.trim() === '') throw new Error('stdin did not contain a query');
    return { value: value.trimEnd(), source: 'stdin' };
  }
  return null;
}

function resolveLogFile(args: DiagnoseArgs, deps: DiagnoseDeps): string | null {
  if (args.file !== undefined) return expandPath(args.file, deps);
  if (deps.env.LOG_FILE !== undefined && deps.env.LOG_FILE !== '') {
    return expandPath(deps.env.LOG_FILE, deps);
  }
  for (const candidate of defaultLogPaths(deps)) {
    if (deps.exists(candidate)) return candidate;
  }
  return null;
}

function defaultLogPaths(deps: DiagnoseDeps): string[] {
  const stateHome = deps.env.XDG_STATE_HOME && deps.env.XDG_STATE_HOME !== ''
    ? deps.env.XDG_STATE_HOME
    : path.join(deps.homedir(), '.local', 'state');
  return [
    path.join(stateHome, 'knowledge-base-mcp-server', 'knowledge-base.log'),
    path.join(stateHome, 'knowledge-base-mcp-server', 'kb.log'),
    path.join(deps.cwd(), 'logs', 'knowledge-base.log'),
    path.join(deps.cwd(), 'knowledge-base.log'),
  ];
}

function expandPath(filePath: string, deps: Pick<DiagnoseDeps, 'cwd' | 'homedir'>): string {
  if (filePath === '~') return deps.homedir();
  if (filePath.startsWith('~/')) return path.join(deps.homedir(), filePath.slice(2));
  return path.resolve(deps.cwd(), filePath);
}

function chooseSelectedEvent(events: CanonicalLogRecord[]): CanonicalLogRecord {
  return events.find((event) => event.query_sha256 !== undefined) ?? events[events.length - 1];
}

function buildExplainArgs(
  query: string,
  event: CanonicalLogRecord,
  explainBundleDir: string,
  args: DiagnoseArgs,
): string[] {
  const explainArgs = [
    query,
    `--repro-bundle=${explainBundleDir}`,
    '--format=json',
  ];
  const kbScope = stringField(event.kb_scope);
  if (kbScope !== undefined && kbScope !== '') explainArgs.push(`--kb=${kbScope}`);
  const modelId = stringField(event.model_id);
  if (modelId !== undefined) explainArgs.push(`--model=${modelId}`);
  const k = integerField(event.k);
  if (k !== undefined && k > 0) explainArgs.push(`--k=${k}`);
  const threshold = numberField(event.threshold);
  if (threshold !== undefined) explainArgs.push(`--threshold=${threshold}`);
  if (args.includeContent) explainArgs.push('--include-content');
  if (args.force) explainArgs.push('--force');
  return explainArgs;
}

async function runExplainCaptured(
  args: string[],
  runExplainFn: (rest: string[]) => Promise<number>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await runExplainFn(args);
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
}

function buildManifest(input: {
  bundleDir: string;
  source: string;
  requestId: string;
  events: CanonicalLogRecord[];
  selectedEvent: CanonicalLogRecord;
  rawQuery: { value: string; source: QuerySource } | null;
  explainExitCode: number | null;
  explainBundleDir: string | null;
  inferredArgs: string[];
  explainStderrFile: string | null;
  files: string[];
  redactionSummary: RedactionSummary;
  now: Date;
}): DiagnoseManifest {
  return {
    schema_version: DIAGNOSE_SCHEMA_VERSION,
    bundle_dir: input.bundleDir,
    created_at: input.now.toISOString(),
    source_log: input.source,
    request_id: input.requestId,
    event_count: input.events.length,
    selected_event: summarizeSelectedEvent(input.selectedEvent),
    raw_query: {
      supplied: input.rawQuery !== null,
      source: input.rawQuery?.source ?? null,
      query_sha256_matches: queryShaMatches(input.rawQuery?.value, input.selectedEvent),
      query_len_chars_matches: queryLengthMatches(input.rawQuery?.value, input.selectedEvent),
    },
    explain: {
      attempted: input.rawQuery !== null,
      exit_code: input.explainExitCode,
      bundle_dir: input.explainBundleDir,
      inferred_args: redactExplainArgs(input.inferredArgs),
      stderr_file: input.explainStderrFile,
    },
    files: input.files,
    redaction_summary: input.redactionSummary,
  };
}

function summarizeSelectedEvent(event: CanonicalLogRecord): DiagnoseManifest['selected_event'] {
  return {
    ts: stringField(event.ts),
    cmd: stringField(event.cmd),
    tool: stringField(event.tool),
    model_id: stringField(event.model_id),
    kb_scope: event.kb_scope === null ? null : stringField(event.kb_scope),
    query_sha256: stringField(event.query_sha256),
    query_len_chars: integerField(event.query_len_chars),
    k: integerField(event.k),
    threshold: numberField(event.threshold),
    took_ms: numberField(event.took_ms),
    degraded: event.degraded === true ? true : undefined,
  };
}

function queryShaMatches(query: string | undefined, event: CanonicalLogRecord): boolean | null {
  const expected = stringField(event.query_sha256);
  if (query === undefined || expected === undefined) return null;
  return hashQuery(query) === expected;
}

function queryLengthMatches(query: string | undefined, event: CanonicalLogRecord): boolean | null {
  const expected = integerField(event.query_len_chars);
  if (query === undefined || expected === undefined) return null;
  return query.length === expected;
}

function redactExplainArgs(args: string[]): string[] {
  if (args.length === 0) return [];
  return ['<raw-query>', ...args.slice(1)];
}

async function ensurePrivateDiagnoseDirectory(
  bundleDir: string,
  forceUnsafeExistingDirectory: boolean,
): Promise<void> {
  const posixPermissions = process.platform !== 'win32';
  try {
    const existing = await fsp.stat(bundleDir);
    if (!existing.isDirectory()) {
      throw new Error(`${bundleDir} exists and is not a directory`);
    }
    if (posixPermissions && (existing.mode & UNSAFE_DIR_MODE_MASK) !== 0 && !forceUnsafeExistingDirectory) {
      throw new Error(
        `${bundleDir} exists with unsafe permissions ${formatMode(existing.mode)}; ` +
        'rerun with --force to chmod it to 0700 before writing',
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await fsp.mkdir(bundleDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  }
  if (posixPermissions) await fsp.chmod(bundleDir, PRIVATE_DIR_MODE);
  await assertDiagnoseDirectoryHasOnlyBundleFiles(bundleDir);
}

async function assertDiagnoseDirectoryHasOnlyBundleFiles(bundleDir: string): Promise<void> {
  const entries = await fsp.readdir(bundleDir, { withFileTypes: true });
  const unsafeEntries = entries
    .filter((entry) => {
      if (entry.name === 'explain') return !entry.isDirectory();
      return !DIAGNOSE_BUNDLE_FILENAMES.has(entry.name) || !entry.isFile();
    })
    .map((entry) => entry.name)
    .sort();
  if (unsafeEntries.length > 0) {
    throw new Error(
      `${bundleDir} contains non-bundle file(s): ${unsafeEntries.join(', ')}; ` +
      'choose an empty directory or remove stale files before writing',
    );
  }
}

async function writePrivateUtf8File(bundleDir: string, relativePath: string, body: string): Promise<void> {
  const filePath = path.join(bundleDir, relativePath);
  await fsp.writeFile(filePath, body, { encoding: 'utf-8', mode: PRIVATE_FILE_MODE });
  if (process.platform !== 'win32') await fsp.chmod(filePath, PRIVATE_FILE_MODE);
}

function formatMarkdownResult(manifest: DiagnoseManifest): string {
  const lines = [
    `Diagnostic bundle written to \`${manifest.bundle_dir}\`.`,
    '',
    `- Request id: \`${manifest.request_id}\``,
    `- Canonical events: ${manifest.event_count}`,
    `- Raw query supplied: ${manifest.raw_query.supplied ? 'yes' : 'no'}`,
    `- Explain replay: ${manifest.explain.attempted ? `exit ${manifest.explain.exit_code}` : 'not attempted'}`,
    '',
  ];
  if (!manifest.raw_query.supplied) {
    lines.push('Pass `--query`, `--query-file`, or `--stdin` to replay `kb explain` into the bundle.', '');
  }
  return lines.join('\n');
}

function formatReadme(manifest: DiagnoseManifest): string {
  return [
    '# kb diagnose bundle',
    '',
    'This bundle contains redacted canonical log context for one request id.',
    '',
    '- `manifest.json` - bundle schema, selected event summary, and replay status.',
    '- `canonical-events.json` - redacted canonical log events matching the request id.',
    ...(manifest.explain.bundle_dir !== null
      ? ['- `explain/` - nested `kb explain --repro-bundle` output for the supplied raw query.']
      : []),
    ...(manifest.explain.stderr_file !== null
      ? ['- `explain-stderr.txt` - redacted stderr captured from the explain replay.']
      : []),
    '',
    'Canonical logs do not store the raw query. If a raw query was supplied for replay, review `explain/query.txt` before sharing.',
    'Candidate chunk content is included only when `--include-content` was passed.',
    '',
  ].join('\n');
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function integerField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function formatMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, '0');
}
