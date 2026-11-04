import { existsSync, readFileSync } from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { hashQuery } from './canonical-log.js';
import { normalizeRetrievalEvalFixture } from './retrieval-eval.js';
import {
  parseCanonicalLogLines,
  type CanonicalLogRecord,
} from './cli-logs.js';
import { runExplain } from './cli-explain.js';
import { captureProcessOutput } from './cli-shared.js';
import {
  combineRedactionSummaries,
  redactSecrets,
  type RedactionSummary,
} from './redaction.js';

export const DIAGNOSE_HELP = `kb diagnose — package a canonical request log as a repro bundle

Usage:
  kb diagnose --request-id=<id> --repro-bundle=<dir> [--file=<path>] [--query=<text>|--query-file=<path>|--stdin] [--include-content] [--force] [--format=md|json]
  kb diagnose --to-fixture=<bundle-dir> --out=<fixture-dir> [--include-sources] [--force] [--format=md|json]

Reads canonical logs for one request id and writes a private diagnostic bundle
with redacted log context. When the raw query is supplied, it also replays
\`kb explain --repro-bundle\` using model, KB scope, k, and threshold hints from
the selected canonical event when available.

\`--to-fixture\` turns an existing diagnose bundle into a runnable local
retrieval fixture (issue #977). It reads the bundle's replayed query and hits
and writes a \`kb eval\` fixture plus a redacted mini-corpus that \`kb eval\` can
run offline with fake (deterministic, no-network) embeddings — no real
embedding provider is ever called. The mini-corpus is a redacted stand-in built
from the bundle; original note bodies are NOT rehydrated from disk unless you
pass \`--include-sources\`. The generated \`README.md\` lists the exact commands.

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
  --to-fixture=<dir>      Read an existing diagnose bundle at <dir> and scaffold
                          a runnable retrieval-eval fixture from it. Requires
                          --out=<fixture-dir>.
  --out=<dir>             Output directory for the scaffolded fixture. Only
                          valid with --to-fixture.
  --include-sources       Only with --to-fixture: rehydrate note bodies from the
                          live knowledge base on disk (redacted) instead of the
                          redacted stand-in corpus. Default is off.
  --force                 Chmod unsafe existing output directories to 0700.
  --format=md|json        Output format (default: md).
  --help, -h              Show this help.

Examples:
  kb diagnose --request-id=maw6d3qfabcd1234 --repro-bundle=/tmp/kb-diag
  kb diagnose --request-id=maw6d3qfabcd1234 --query-file=query.txt --repro-bundle=/tmp/kb-diag
  kb diagnose --to-fixture=/tmp/kb-diag --out=/tmp/kb-fixture
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

interface DiagnoseArgs {
  requestId?: string;
  reproBundle?: string;
  file?: string;
  query?: string;
  queryFile?: string;
  stdin: boolean;
  includeContent: boolean;
  /** issue #977 — input diagnose bundle directory when scaffolding a fixture. */
  toFixture?: string;
  /** issue #977 — output fixture directory. Only valid with --to-fixture. */
  fixtureOut?: string;
  /** issue #977 — rehydrate note bodies from disk under --to-fixture. */
  includeSources: boolean;
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

  if (args.toFixture !== undefined) {
    return runDiagnoseToFixture(args, deps);
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
    let explainBundleRel: string | null = null;
    let inferredArgs: string[] = [];

    if (rawQuery !== null) {
      const nextExplainBundleRel = 'explain';
      const explainBundleDir = path.join(bundleDir, nextExplainBundleRel);
      inferredArgs = buildExplainArgs(rawQuery.value, selectedEvent, explainBundleDir, args);
      const captured = await captureProcessOutput(() => deps.runExplain(inferredArgs));
      explainExitCode = captured.exitCode;
      if (captured.stderr.trim() !== '') {
        const stderrRedacted = redactSecrets(captured.stderr);
        await writePrivateUtf8File(bundleDir, 'explain-stderr.txt', stderrRedacted.text);
        files.push('explain-stderr.txt');
        redactions.push(stderrRedacted.summary);
        explainStderrFile = 'explain-stderr.txt';
      }
      if (deps.exists(explainBundleDir)) {
        files.push(nextExplainBundleRel);
        explainBundleRel = nextExplainBundleRel;
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
      explainBundleDir: explainBundleRel,
      inferredArgs,
      explainStderrFile,
      files: [...files, 'README.md', 'manifest.json'].sort((a, b) => a.localeCompare(b)),
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
    includeSources: false,
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
    if (raw.startsWith('--to-fixture=')) {
      const value = raw.slice('--to-fixture='.length);
      if (value === '') throw new Error('empty --to-fixture value');
      out.toFixture = value;
      continue;
    }
    if (raw.startsWith('--out=')) {
      const value = raw.slice('--out='.length);
      if (value === '') throw new Error('empty --out value');
      out.fixtureOut = value;
      continue;
    }
    if (raw === '--include-sources') {
      out.includeSources = true;
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

  // issue #977 — --to-fixture is a distinct mode. It does not combine with the
  // request-id → bundle flags, and its only companions are --out,
  // --include-sources, --force, and --format.
  if (out.toFixture !== undefined) {
    const incompatible = [
      out.requestId !== undefined && '--request-id',
      out.reproBundle !== undefined && '--repro-bundle',
      out.file !== undefined && '--file',
      querySources > 0 && '--query/--query-file/--stdin',
      out.includeContent && '--include-content',
    ].filter((flag): flag is string => typeof flag === 'string');
    if (incompatible.length > 0) {
      throw new Error(`--to-fixture cannot be combined with ${incompatible.join(', ')}`);
    }
  } else {
    if (out.fixtureOut !== undefined) {
      throw new Error('--out is only valid with --to-fixture');
    }
    if (out.includeSources) {
      throw new Error('--include-sources is only valid with --to-fixture');
    }
  }
  return out;
}

// ===== issue #977 — diagnose bundle → runnable retrieval fixture ============

const FIXTURE_SCHEMA_VERSION = 'kb.diagnose.fixture.v1';
const FIXTURE_TOP_LEVEL_FILES = new Set(['README.md', 'fixture.yml', 'manifest.json']);
const FIXTURE_CORPUS_DIR = 'corpus';
const FIXTURE_FIXTURE_FILE = 'fixture.yml';
const FIXTURE_DEFAULT_K = 10;
const MAX_REHYDRATED_BODY_CHARS = 8000;

interface BundleCandidate {
  rank: number | undefined;
  score: number | undefined;
  source: string;
  relativePath: string | null;
  knowledgeBase: string | null;
  inTopk: boolean;
  frontmatter: Record<string, unknown>;
  content: string | undefined;
}

interface FixtureCorpusEntry {
  /** Identity written to required_sources — equals the corpus-relative path. */
  requiredSource: string;
  /** POSIX path under corpus/ where the stand-in note is written. */
  corpusPath: string;
  knowledgeBase: string | null;
  originSource: string;
  body: string;
  rehydratedFromDisk: boolean;
}

interface FixtureManifest {
  schema_version: typeof FIXTURE_SCHEMA_VERSION;
  created_at: string;
  source_bundle: string;
  fixture_dir: string;
  embeddings: 'fake';
  query_len_chars: number;
  kb_scope: string | null;
  k: number;
  mode: 'dense';
  include_sources: boolean;
  bundle_kb_scope: string | null;
  corpus: Array<{
    required_source: string;
    corpus_path: string;
    knowledge_base: string | null;
    rehydrated_from_disk: boolean;
  }>;
  files: string[];
  redaction_summary: RedactionSummary;
}

async function runDiagnoseToFixture(args: DiagnoseArgs, deps: DiagnoseDeps): Promise<number> {
  if (args.fixtureOut === undefined) {
    deps.stderr('kb diagnose: --to-fixture requires --out=<fixture-dir>\n');
    return 2;
  }

  const bundleDir = expandPath(args.toFixture as string, deps);
  const fixtureDir = expandPath(args.fixtureOut, deps);
  if (path.resolve(bundleDir) === path.resolve(fixtureDir)) {
    deps.stderr('kb diagnose: --out must differ from the --to-fixture bundle directory\n');
    return 2;
  }

  const queryPath = path.join(bundleDir, 'explain', 'query.txt');
  let rawQuery: string;
  try {
    rawQuery = deps.readFile(queryPath).replace(/\r?\n+$/, '');
  } catch (err) {
    deps.stderr(
      `kb diagnose: cannot read ${queryPath}: ${(err as Error).message}\n` +
      'The bundle must have been created with a raw query ' +
      '(kb diagnose --query/--query-file/--stdin) so the replay captured the hits.\n',
    );
    return 1;
  }
  if (rawQuery.trim() === '') {
    deps.stderr(`kb diagnose: ${queryPath} does not contain a query\n`);
    return 1;
  }

  const candidatesPath = path.join(bundleDir, 'explain', 'top-candidates.json');
  let candidates: BundleCandidate[];
  try {
    candidates = parseBundleCandidates(deps.readFile(candidatesPath));
  } catch (err) {
    deps.stderr(`kb diagnose: cannot read ${candidatesPath}: ${(err as Error).message}\n`);
    return 1;
  }

  const selected = selectFixtureCandidates(candidates);
  if (selected.length === 0) {
    deps.stderr(`kb diagnose: ${candidatesPath} has no usable candidate hits to seed a fixture\n`);
    return 1;
  }

  const redactions: RedactionSummary[] = [];
  const redactedQuery = redactSecrets(rawQuery);
  redactions.push(redactedQuery.summary);

  let entries: FixtureCorpusEntry[];
  try {
    entries = await buildFixtureCorpusEntries(selected, redactedQuery.text, args, deps, redactions);
  } catch (err) {
    deps.stderr(`kb diagnose: failed to build mini-corpus: ${(err as Error).message}\n`);
    return 1;
  }

  const kbScope = resolveCorpusKbScope(entries);
  const bundleKbScope = readBundleKbScope(bundleDir, deps);
  const k = Math.max(readBundleK(candidatesPath, deps) ?? FIXTURE_DEFAULT_K, entries.length, 1);

  let fixtureYaml: string;
  try {
    fixtureYaml = buildFixtureYaml(redactedQuery.text, entries, kbScope, k);
  } catch (err) {
    deps.stderr(`kb diagnose: generated fixture is invalid: ${(err as Error).message}\n`);
    return 1;
  }

  try {
    await ensurePrivateFixtureDirectory(fixtureDir, args.force);
  } catch (err) {
    deps.stderr(`kb diagnose: failed to prepare fixture dir: ${(err as Error).message}\n`);
    return 1;
  }

  try {
    const files: string[] = [];
    for (const entry of entries) {
      await writePrivateNestedFile(fixtureDir, path.posix.join(FIXTURE_CORPUS_DIR, entry.corpusPath), entry.body);
      files.push(path.posix.join(FIXTURE_CORPUS_DIR, entry.corpusPath));
    }
    await writePrivateNestedFile(fixtureDir, FIXTURE_FIXTURE_FILE, fixtureYaml);
    files.push(FIXTURE_FIXTURE_FILE);

    const manifest = buildFixtureManifest({
      bundleDir,
      fixtureDir,
      rawQuery,
      kbScope,
      bundleKbScope,
      k,
      includeSources: args.includeSources,
      entries,
      files: [...files, 'README.md', 'manifest.json'].sort((a, b) => a.localeCompare(b)),
      redactionSummary: combineRedactionSummaries(true, ...redactions),
      now: deps.now(),
    });

    await writePrivateNestedFile(fixtureDir, 'README.md', buildFixtureReadme(manifest, entries));
    await writePrivateNestedFile(fixtureDir, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

    if (args.format === 'json') {
      deps.stdout(`${JSON.stringify(manifest, null, 2)}\n`);
    } else {
      deps.stdout(formatFixtureMarkdownResult(manifest));
    }
    return 0;
  } catch (err) {
    deps.stderr(`kb diagnose: failed to write fixture: ${(err as Error).message}\n`);
    return 1;
  }
}

function parseBundleCandidates(raw: string): BundleCandidate[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!isPlainObject(parsed) || !Array.isArray(parsed.candidates)) {
    throw new Error('top-candidates.json is missing a candidates array');
  }
  return parsed.candidates.map((candidate): BundleCandidate => {
    const record = isPlainObject(candidate) ? candidate : {};
    return {
      rank: integerField(record.rank),
      score: numberField(record.score),
      source: stringField(record.source) ?? '',
      relativePath: stringField(record.relative_path) ?? null,
      knowledgeBase: stringField(record.knowledge_base) ?? null,
      inTopk: record.in_topk === true,
      frontmatter: isPlainObject(record.frontmatter) ? record.frontmatter : {},
      content: stringField(record.content),
    };
  });
}

function selectFixtureCandidates(candidates: BundleCandidate[]): BundleCandidate[] {
  const usable = candidates.filter(
    (candidate) =>
      (candidate.relativePath !== null && candidate.relativePath.trim() !== '') ||
      candidate.source.trim() !== '',
  );
  const topk = usable.filter((candidate) => candidate.inTopk);
  return topk.length > 0 ? topk : usable;
}

async function buildFixtureCorpusEntries(
  candidates: BundleCandidate[],
  redactedQuery: string,
  args: DiagnoseArgs,
  deps: DiagnoseDeps,
  redactions: RedactionSummary[],
): Promise<FixtureCorpusEntry[]> {
  const byPath = new Map<string, FixtureCorpusEntry>();
  for (const candidate of candidates) {
    const corpusPath = toCorpusRelPath(candidate);
    if (byPath.has(corpusPath)) continue; // dedupe chunks from the same source file

    let diskBody: string | undefined;
    let rehydrated = false;
    if (args.includeSources) {
      diskBody = readSourceBodyFromDisk(candidate, deps);
      rehydrated = diskBody !== undefined;
    }

    const rawBody = buildCorpusBody(candidate, corpusPath, redactedQuery, diskBody);
    const redacted = redactSecrets(rawBody);
    redactions.push(redacted.summary);

    byPath.set(corpusPath, {
      requiredSource: corpusPath,
      corpusPath,
      knowledgeBase: candidate.knowledgeBase,
      originSource: candidate.relativePath ?? candidate.source,
      body: redacted.text,
      rehydratedFromDisk: rehydrated,
    });
  }
  return [...byPath.values()];
}

/**
 * Rehydrate a note body from the local knowledge base. `top-candidates.json`
 * is untrusted bundle input, so reads are confined to inside
 * KNOWLEDGE_BASES_ROOT_DIR: only `relativePath` is used (never the bundle's raw
 * `source`, which is an arbitrary absolute path), and a `..`/absolute escape
 * out of the root is rejected. This blocks a crafted bundle from reading
 * arbitrary files such as `../../.aws/credentials` or `~/.ssh/id_rsa`.
 */
function readSourceBodyFromDisk(candidate: BundleCandidate, deps: DiagnoseDeps): string | undefined {
  if (candidate.relativePath === null || candidate.relativePath.trim() === '') return undefined;
  const root = path.resolve(
    deps.env.KNOWLEDGE_BASES_ROOT_DIR && deps.env.KNOWLEDGE_BASES_ROOT_DIR !== ''
      ? deps.env.KNOWLEDGE_BASES_ROOT_DIR
      : path.join(deps.homedir(), 'knowledge_bases'),
  );
  const resolved = path.resolve(root, candidate.relativePath);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return undefined; // escapes the knowledge-base root — refuse the read
  }
  try {
    if (!deps.exists(resolved)) return undefined;
    const body = deps.readFile(resolved);
    return body.length > MAX_REHYDRATED_BODY_CHARS
      ? `${body.slice(0, MAX_REHYDRATED_BODY_CHARS)}\n\n<!-- truncated to ${MAX_REHYDRATED_BODY_CHARS} chars by kb diagnose --to-fixture -->\n`
      : body;
  } catch {
    // Best-effort: fall through to the synthetic stand-in body.
    return undefined;
  }
}

function toCorpusRelPath(candidate: BundleCandidate): string {
  const raw = candidate.relativePath !== null && candidate.relativePath.trim() !== ''
    ? candidate.relativePath
    : candidate.source;
  const segments = raw
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map((segment) => segment.replace(/^[A-Za-z]:$/, '')) // drop a Windows drive letter
    .filter((segment) => segment !== '');
  let clean = segments.length > 0 ? segments : ['note'];
  // Ensure a leading shelf segment so the re-ingested relativePath is `<kb>/<file>`.
  if (clean.length === 1) {
    const shelf = sanitizeSegment(candidate.knowledgeBase) ?? 'diagnose';
    clean = [shelf, clean[0]];
  }
  let out = clean.join('/');
  if (!/\.(md|markdown)$/i.test(out)) out += '.md';
  return out;
}

function sanitizeSegment(value: string | null): string | undefined {
  if (value === null) return undefined;
  const cleaned = value.replace(/[\\/]+/g, '-').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? undefined : cleaned;
}

function buildCorpusBody(
  candidate: BundleCandidate,
  corpusPath: string,
  redactedQuery: string,
  diskBody: string | undefined,
): string {
  const frontmatterLines = Object.entries(candidate.frontmatter)
    .filter(([key]) => /^[A-Za-z0-9_.-]+$/.test(key))
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  const header = [
    '---',
    'source-of-truth: kb-diagnose-fixture',
    `knowledge_base: ${candidate.knowledgeBase ?? ''}`,
    `origin_source: ${candidate.relativePath ?? candidate.source}`,
    ...frontmatterLines,
    '---',
    '',
    `# ${corpusPath}`,
    '',
  ];
  const bodyParts: string[] = [];
  if (diskBody !== undefined) {
    bodyParts.push(diskBody.trimEnd(), '');
  } else if (candidate.content !== undefined && candidate.content.trim() !== '') {
    // Chunk text captured in the bundle (kb diagnose --include-content).
    bodyParts.push(candidate.content.trimEnd(), '');
  } else {
    bodyParts.push(
      'Redacted stand-in generated by `kb diagnose --to-fixture` from a diagnose',
      'repro bundle. The original note body is not included. Re-run with',
      '`--include-sources` to rehydrate it from the local knowledge base.',
      '',
    );
  }
  // Query anchor: keeps the note retrievable under the deterministic fake
  // embedding provider so the generated fixture's required_sources match.
  bodyParts.push('<!-- kb-diagnose-query-anchor -->', redactedQuery, '');
  return `${[...header, ...bodyParts].join('\n')}`;
}

function resolveCorpusKbScope(entries: FixtureCorpusEntry[]): string | null {
  const shelves = new Set(entries.map((entry) => entry.corpusPath.split('/')[0]));
  return shelves.size === 1 ? [...shelves][0] : null;
}

function buildFixtureYaml(
  redactedQuery: string,
  entries: FixtureCorpusEntry[],
  kbScope: string | null,
  k: number,
): string {
  const fixtureObject = {
    gate: false,
    mode: 'dense',
    cases: [
      {
        name: 'diagnose repro',
        query: redactedQuery,
        ...(kbScope !== null ? { kb: kbScope } : {}),
        k,
        required_sources: entries.map((entry) => entry.requiredSource),
        stale_policy: 'allow_stale',
      },
    ],
  };
  // Fail fast if the generated fixture would not parse under `kb eval`.
  normalizeRetrievalEvalFixture(fixtureObject);
  const header = [
    '# Generated by `kb diagnose --to-fixture` (issue #977).',
    '# Runs offline with fake (deterministic, no-network) embeddings against the',
    '# redacted mini-corpus in ./corpus. See README.md for the exact commands.',
    '',
  ].join('\n');
  return `${header}${yaml.dump(fixtureObject, { lineWidth: -1, noRefs: true, sortKeys: false })}`;
}

function readBundleKbScope(bundleDir: string, deps: DiagnoseDeps): string | null {
  try {
    const manifest = JSON.parse(deps.readFile(path.join(bundleDir, 'manifest.json'))) as unknown;
    if (isPlainObject(manifest) && isPlainObject(manifest.selected_event)) {
      return stringField(manifest.selected_event.kb_scope) ?? null;
    }
  } catch {
    // Optional provenance only.
  }
  return null;
}

function readBundleK(candidatesPath: string, deps: DiagnoseDeps): number | undefined {
  try {
    const parsed = JSON.parse(deps.readFile(candidatesPath)) as unknown;
    if (isPlainObject(parsed)) {
      return integerField(parsed.k);
    }
  } catch {
    // Optional hint only.
  }
  return undefined;
}

function buildFixtureManifest(input: {
  bundleDir: string;
  fixtureDir: string;
  rawQuery: string;
  kbScope: string | null;
  bundleKbScope: string | null;
  k: number;
  includeSources: boolean;
  entries: FixtureCorpusEntry[];
  files: string[];
  redactionSummary: RedactionSummary;
  now: Date;
}): FixtureManifest {
  return {
    schema_version: FIXTURE_SCHEMA_VERSION,
    created_at: input.now.toISOString(),
    source_bundle: input.bundleDir,
    fixture_dir: input.fixtureDir,
    embeddings: 'fake',
    query_len_chars: input.rawQuery.length,
    kb_scope: input.kbScope,
    k: input.k,
    mode: 'dense',
    include_sources: input.includeSources,
    bundle_kb_scope: input.bundleKbScope,
    corpus: input.entries.map((entry) => ({
      required_source: entry.requiredSource,
      corpus_path: entry.corpusPath,
      knowledge_base: entry.knowledgeBase,
      rehydrated_from_disk: entry.rehydratedFromDisk,
    })),
    files: input.files,
    redaction_summary: input.redactionSummary,
  };
}

const FIXTURE_FAKE_MODEL_ID = 'fake__BAAI-bge-small-en-v1.5';
const FIXTURE_FAKE_MODEL_NAME = 'BAAI/bge-small-en-v1.5';

function buildFixtureReadme(manifest: FixtureManifest, entries: FixtureCorpusEntry[]): string {
  return [
    '# kb diagnose → eval fixture',
    '',
    'Replays a reported retrieval locally with **fake** embeddings — a',
    'deterministic, offline provider. No real embedding provider is called, and',
    'the mini-corpus under `corpus/` is a redacted stand-in built from the',
    'diagnose bundle, not the original notes.',
    '',
    '## Run it',
    '',
    'From this directory (if your `kb` is a local build, use `node build/cli.js`',
    'in place of `kb`):',
    '',
    '```bash',
    'export EMBEDDING_PROVIDER=fake',
    'export KNOWLEDGE_BASES_ROOT_DIR="$PWD/corpus"',
    'export FAISS_INDEX_PATH="$PWD/.faiss"',
    '',
    '# Register the offline fake model. `kb models add` only supports live',
    '# providers, so the deterministic fake model is registered by hand:',
    `MODEL_ID=${FIXTURE_FAKE_MODEL_ID}`,
    'mkdir -p "$FAISS_INDEX_PATH/models/$MODEL_ID"',
    `printf '%s' '${FIXTURE_FAKE_MODEL_NAME}' > "$FAISS_INDEX_PATH/models/$MODEL_ID/model_name.txt"`,
    'printf \'%s\' "$MODEL_ID" > "$FAISS_INDEX_PATH/active.txt"',
    '',
    '# Build the index from the mini-corpus (fake embeddings, offline):',
    'kb reindex --with-context --force',
    '',
    '# Run the retrieval check:',
    'kb eval fixture.yml',
    '```',
    '',
    '## What is here',
    '',
    '- `fixture.yml` — the retrieval-eval case (query + required sources).',
    '- `corpus/` — the redacted mini-corpus the fixture runs against.',
    '- `manifest.json` — provenance, redaction summary, and the source bundle.',
    '',
    `Generated from \`${manifest.source_bundle}\` on ${manifest.created_at}.`,
    manifest.include_sources
      ? 'Note bodies were rehydrated from the local knowledge base (redacted).'
      : 'Note bodies are redacted stand-ins seeded with the query so retrieval can find them.',
    '',
    `Required sources (${entries.length}):`,
    ...entries.map((entry) => `- \`${entry.requiredSource}\``),
    '',
  ].join('\n');
}

function formatFixtureMarkdownResult(manifest: FixtureManifest): string {
  return [
    `Retrieval fixture written to \`${manifest.fixture_dir}\`.`,
    '',
    `- Source bundle: \`${manifest.source_bundle}\``,
    `- Embeddings: fake (deterministic, offline)`,
    `- Corpus notes: ${manifest.corpus.length}`,
    `- KB scope: ${manifest.kb_scope ?? '(all shelves)'}`,
    `- Rehydrated from disk: ${manifest.include_sources ? 'yes' : 'no'}`,
    '',
    'Run it with the commands in the generated `README.md`.',
    '',
  ].join('\n');
}

async function ensurePrivateFixtureDirectory(fixtureDir: string, force: boolean): Promise<void> {
  const posixPermissions = process.platform !== 'win32';
  try {
    const existing = await fsp.stat(fixtureDir);
    if (!existing.isDirectory()) {
      throw new Error(`${fixtureDir} exists and is not a directory`);
    }
    if (posixPermissions && (existing.mode & UNSAFE_DIR_MODE_MASK) !== 0 && !force) {
      throw new Error(
        `${fixtureDir} exists with unsafe permissions ${formatMode(existing.mode)}; ` +
        'rerun with --force to chmod it to 0700 before writing',
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await fsp.mkdir(fixtureDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  }
  if (posixPermissions) await fsp.chmod(fixtureDir, PRIVATE_DIR_MODE);
  await assertFixtureDirectoryHasOnlyFixtureFiles(fixtureDir);
  await clearExistingFixtureFiles(fixtureDir);
}

async function assertFixtureDirectoryHasOnlyFixtureFiles(fixtureDir: string): Promise<void> {
  const entries = await fsp.readdir(fixtureDir, { withFileTypes: true });
  const unsafe = entries
    .filter((entry) => {
      if (entry.name === FIXTURE_CORPUS_DIR) return !entry.isDirectory();
      return !FIXTURE_TOP_LEVEL_FILES.has(entry.name) || !entry.isFile();
    })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  if (unsafe.length > 0) {
    throw new Error(
      `${fixtureDir} contains non-fixture file(s): ${unsafe.join(', ')}; ` +
      'choose an empty directory or remove stale files before writing',
    );
  }
}

async function clearExistingFixtureFiles(fixtureDir: string): Promise<void> {
  for (const filename of FIXTURE_TOP_LEVEL_FILES) {
    await fsp.rm(path.join(fixtureDir, filename), { force: true });
  }
  await fsp.rm(path.join(fixtureDir, FIXTURE_CORPUS_DIR), { recursive: true, force: true });
}

async function writePrivateNestedFile(baseDir: string, relativePath: string, body: string): Promise<void> {
  const filePath = path.join(baseDir, relativePath);
  const parent = path.dirname(filePath);
  await fsp.mkdir(parent, { recursive: true, mode: PRIVATE_DIR_MODE });
  await fsp.writeFile(filePath, body, { encoding: 'utf-8', mode: PRIVATE_FILE_MODE });
  if (process.platform !== 'win32') await fsp.chmod(filePath, PRIVATE_FILE_MODE);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  await clearExistingDiagnoseBundleFiles(bundleDir);
}

async function assertDiagnoseDirectoryHasOnlyBundleFiles(bundleDir: string): Promise<void> {
  const entries = await fsp.readdir(bundleDir, { withFileTypes: true });
  const unsafeEntries = entries
    .filter((entry) => {
      if (entry.name === 'explain') return !entry.isDirectory();
      return !DIAGNOSE_BUNDLE_FILENAMES.has(entry.name) || !entry.isFile();
    })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  if (unsafeEntries.length > 0) {
    throw new Error(
      `${bundleDir} contains non-bundle file(s): ${unsafeEntries.join(', ')}; ` +
      'choose an empty directory or remove stale files before writing',
    );
  }
}

async function clearExistingDiagnoseBundleFiles(bundleDir: string): Promise<void> {
  for (const filename of DIAGNOSE_BUNDLE_FILENAMES) {
    await fsp.rm(path.join(bundleDir, filename), { force: true });
  }
  await fsp.rm(path.join(bundleDir, 'explain'), { recursive: true, force: true });
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
