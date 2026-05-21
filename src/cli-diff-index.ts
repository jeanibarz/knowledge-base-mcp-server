import * as fsp from 'fs/promises';
import yaml from 'js-yaml';

import {
  ActiveModelResolutionError,
  resolveActiveModel,
} from './active-model.js';
import { loadManagerForModel, loadWithJsonRetry } from './cli-shared.js';
import {
  formatDiffIndexMarkdown,
  resolveIndexVersionPath,
  runDiffIndex as runDiffIndexCore,
  type DiffIndexQuery,
  type DiffIndexManager,
} from './diff-index-core.js';
import { FaissIndexManager } from './FaissIndexManager.js';
import { normalizeRetrievalEvalFixture } from './retrieval-eval.js';

type DiffIndexFormat = 'json' | 'markdown';

type QuerySource =
  | { kind: 'query'; query: string }
  | { kind: 'queries'; path: string }
  | { kind: 'fixture'; path: string };

export interface DiffIndexArgs {
  before: string | null;
  after: string | null;
  model?: string;
  kb?: string;
  topK: number;
  threshold: number;
  format: DiffIndexFormat;
  source: QuerySource | null;
}

export interface RunDiffIndexCliDeps {
  bootstrapLayout: () => Promise<void>;
  resolveActiveModel: (opts: { explicitOverride?: string }) => Promise<string>;
  loadManagerForModel: (modelId: string) => Promise<DiffIndexManager & { modelDir: string }>;
  loadWithJsonRetry: (manager: DiffIndexManager & { modelDir: string }) => Promise<void>;
  runDiffIndex: typeof runDiffIndexCore;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const DEFAULT_TOP_K = 10;
const DEFAULT_THRESHOLD = 2;

const DEFAULT_RUN_DIFF_INDEX_CLI_DEPS: RunDiffIndexCliDeps = {
  bootstrapLayout: () => FaissIndexManager.bootstrapLayout(),
  resolveActiveModel,
  loadManagerForModel,
  loadWithJsonRetry: (manager) => loadWithJsonRetry(manager as FaissIndexManager),
  runDiffIndex: runDiffIndexCore,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

export const DIFF_INDEX_HELP = `kb diff-index — compare retrieval-result churn across two FAISS index versions

Usage:
  kb diff-index --before=<version|path> --after=<version|path> --queries=<path> [options]
  kb diff-index --before=<version|path> --after=<version|path> --fixture=<path> [options]
  kb diff-index --before=<version|path> --after=<version|path> --query=<text> [options]

Runs the same query set against two persisted FAISS index versions for one
embedding model and reports top-K membership changes, rank deltas, churn score,
and stability score. Numeric versions resolve under the selected model dir
(for example --before=3 -> <modelDir>/index.v3).

Options:
  --before=<v>          BEFORE index version number, relative dir, or absolute dir.
  --after=<v>           AFTER index version number, relative dir, or absolute dir.
  --queries=<path>      Text file with one query per non-empty line.
  --fixture=<path>      Retrieval eval YAML/JSON fixture; uses each case query.
  --query=<text>        Single ad-hoc query.
  --model=<id>          Override the active embedding model.
  --kb=<name>           Scope every query to one knowledge base unless a fixture
                        case already specifies kb.
  --top-k=<int>         Top-K results per query (default: ${DEFAULT_TOP_K}).
  --k=<int>             Alias for --top-k.
  --threshold=<float>   Dense similarity threshold (default: ${DEFAULT_THRESHOLD}).
  --format=md|json      Output format (default: md; markdown is accepted as
                        an alias).
  --help, -h            Show this help.

Notes:
  Canonical logs store query hashes rather than plaintext query strings, so
  log sampling cannot reconstruct queries. Export plaintext queries to a file
  and pass --queries=<path>.

Examples:
  kb diff-index --before=3 --after=4 --queries=queries.txt --kb=operating-environment
  kb diff-index --before=index.v3 --after=index.v4 --fixture=docs/testing/fixtures/rfc-017-recall-canary.yml --format=json
`;

export async function runDiffIndexCli(
  rest: string[],
  deps: RunDiffIndexCliDeps = DEFAULT_RUN_DIFF_INDEX_CLI_DEPS,
): Promise<number> {
  let parsed: DiffIndexArgs;
  try {
    parsed = parseDiffIndexArgs(rest);
  } catch (err) {
    deps.stderr(`kb diff-index: ${(err as Error).message}\n`);
    return 2;
  }
  if (parsed.before === null || parsed.after === null) {
    deps.stderr('kb diff-index: --before and --after are required\n');
    return 2;
  }
  if (parsed.source === null) {
    deps.stderr('kb diff-index: one query source is required (--queries, --fixture, or --query)\n');
    return 2;
  }

  let queries: DiffIndexQuery[];
  try {
    queries = await loadDiffIndexQueries(parsed.source, parsed.kb);
  } catch (err) {
    deps.stderr(`kb diff-index: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    await deps.bootstrapLayout();
  } catch (err) {
    deps.stderr(`kb diff-index: layout bootstrap failed: ${(err as Error).message}\n`);
    return 1;
  }

  let activeModelId: string;
  try {
    activeModelId = await deps.resolveActiveModel({ explicitOverride: parsed.model });
  } catch (err) {
    if (err instanceof ActiveModelResolutionError) {
      deps.stderr(`kb diff-index: ${err.message}\n`);
      return 2;
    }
    deps.stderr(`kb diff-index: ${(err as Error).message}\n`);
    return 1;
  }

  try {
    const manager = await deps.loadManagerForModel(activeModelId);
    await deps.loadWithJsonRetry(manager);
    const beforePath = resolveIndexVersionPath(parsed.before, manager.modelDir);
    const afterPath = resolveIndexVersionPath(parsed.after, manager.modelDir);
    const report = await deps.runDiffIndex({
      manager,
      before: beforePath,
      after: afterPath,
      queries,
      topK: parsed.topK,
      threshold: parsed.threshold,
    });
    if (parsed.format === 'json') {
      deps.stdout(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      deps.stdout(formatDiffIndexMarkdown(report));
    }
    return 0;
  } catch (err) {
    deps.stderr(`kb diff-index: ${(err as Error).message}\n`);
    return 1;
  }
}

export function parseDiffIndexArgs(rest: readonly string[]): DiffIndexArgs {
  const out: DiffIndexArgs = {
    before: null,
    after: null,
    topK: DEFAULT_TOP_K,
    threshold: DEFAULT_THRESHOLD,
    format: 'markdown',
    source: null,
  };

  for (const raw of rest) {
    if (raw.startsWith('--before=')) {
      out.before = nonEmptyValue(raw, '--before=');
      continue;
    }
    if (raw.startsWith('--after=')) {
      out.after = nonEmptyValue(raw, '--after=');
      continue;
    }
    if (raw.startsWith('--queries=')) {
      setQuerySource(out, { kind: 'queries', path: nonEmptyValue(raw, '--queries=') });
      continue;
    }
    if (raw.startsWith('--fixture=')) {
      setQuerySource(out, { kind: 'fixture', path: nonEmptyValue(raw, '--fixture=') });
      continue;
    }
    if (raw.startsWith('--query=')) {
      setQuerySource(out, { kind: 'query', query: nonEmptyValue(raw, '--query=') });
      continue;
    }
    if (raw.startsWith('--model=')) {
      out.model = nonEmptyValue(raw, '--model=');
      continue;
    }
    if (raw.startsWith('--kb=')) {
      out.kb = nonEmptyValue(raw, '--kb=');
      continue;
    }
    if (raw.startsWith('--top-k=')) {
      out.topK = parsePositiveInt(raw, '--top-k=');
      continue;
    }
    if (raw.startsWith('--k=')) {
      out.topK = parsePositiveInt(raw, '--k=');
      continue;
    }
    if (raw.startsWith('--threshold=')) {
      out.threshold = parseFiniteNumber(raw, '--threshold=');
      continue;
    }
    if (raw.startsWith('--format=')) {
      const value = nonEmptyValue(raw, '--format=');
      if (value === 'md' || value === 'markdown') {
        out.format = 'markdown';
      } else if (value === 'json') {
        out.format = 'json';
      } else {
        throw new Error(`invalid --format: ${raw}`);
      }
      continue;
    }
    if (raw.startsWith('--sample-logs=')) {
      throw new Error('--sample-logs is not supported because canonical logs store query hashes, not plaintext queries; use --queries instead');
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
  }

  return out;
}

export async function loadDiffIndexQueries(
  source: QuerySource,
  defaultKb?: string,
): Promise<DiffIndexQuery[]> {
  if (source.kind === 'query') {
    return [{ query: source.query, ...(defaultKb !== undefined ? { kb: defaultKb } : {}) }];
  }
  if (source.kind === 'queries') {
    const text = await fsp.readFile(source.path, 'utf-8');
    const queries = parseQueriesText(text, defaultKb);
    if (queries.length === 0) {
      throw new Error(`${source.path} did not contain any non-empty queries`);
    }
    return queries;
  }

  const raw = await fsp.readFile(source.path, 'utf-8');
  const fixture = normalizeRetrievalEvalFixture(yaml.load(raw));
  return fixture.cases.map((fixtureCase): DiffIndexQuery => ({
    name: fixtureCase.name,
    query: fixtureCase.query,
    ...(fixtureCase.kb !== undefined ? { kb: fixtureCase.kb } : defaultKb !== undefined ? { kb: defaultKb } : {}),
  }));
}

export function parseQueriesText(text: string, defaultKb?: string): DiffIndexQuery[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((query): DiffIndexQuery => ({
      query,
      ...(defaultKb !== undefined ? { kb: defaultKb } : {}),
    }));
}

function setQuerySource(out: DiffIndexArgs, source: QuerySource): void {
  if (out.source !== null) {
    throw new Error('choose exactly one query source (--queries, --fixture, or --query)');
  }
  out.source = source;
}

function nonEmptyValue(raw: string, prefix: string): string {
  const value = raw.slice(prefix.length);
  if (value.length === 0) throw new Error(`${prefix.slice(0, -1)} requires a non-empty value`);
  return value;
}

function parsePositiveInt(raw: string, prefix: string): number {
  const value = raw.slice(prefix.length);
  if (!/^\d+$/.test(value)) throw new Error(`invalid ${prefix.slice(0, -1)}: ${raw}`);
  const parsed = Number(value);
  if (parsed <= 0) throw new Error(`${prefix.slice(0, -1)} must be > 0`);
  return parsed;
}

function parseFiniteNumber(raw: string, prefix: string): number {
  const value = Number(raw.slice(prefix.length));
  if (!Number.isFinite(value)) throw new Error(`invalid ${prefix.slice(0, -1)}: ${raw}`);
  return value;
}
