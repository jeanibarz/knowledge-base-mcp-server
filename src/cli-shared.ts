import { AsyncLocalStorage } from 'node:async_hooks';
import { FaissIndexManager } from './FaissIndexManager.js';
import { parseModelId } from './model-id.js';
import { readStoredIndexType, readStoredModelName } from './model-storage-layout.js';
import type { EmbeddingProvider } from './model-id.js';
import { KBError } from './errors.js';
import { logger } from './logger.js';

export {
  closestSuggestion,
  formatKnowledgeBaseSuggestions,
  levenshteinDistance,
  rankSuggestions,
  suggestionDistanceThreshold,
  MAX_KNOWLEDGE_BASE_SUGGESTIONS,
  type ClosestSuggestion,
} from './suggestion-core.js';

/**
 * RFC 013: load a FaissIndexManager for the given model_id. Resolves the
 * (provider, modelName) pair from the model's `model_name.txt` so the
 * manager can instantiate the right embeddings client. The 0.2.x model-
 * mismatch check is obsolete under multi-model: each model has its own
 * dir, and the active resolver fails-fast on missing/malformed state.
 */
export async function loadManagerForModel(modelId: string): Promise<FaissIndexManager> {
  const { provider } = parseModelId(modelId);
  const modelName = await readStoredModelName(modelId);
  if (modelName === null) {
    throw new Error(`model_name.txt missing for "${modelId}" — corrupt model directory`);
  }
  return new FaissIndexManager({
    provider: provider as EmbeddingProvider,
    modelName,
    indexType: await readStoredIndexType(modelId),
  });
}

export async function loadWithJsonRetry(manager: FaissIndexManager): Promise<void> {
  // Pre-RFC-014 defensive belt for the LEGACY `faiss.index/` load path only.
  // The versioned `index -> index.vN/` layout pre-resolves the symlink before
  // any file open, so torn JSON is structurally impossible there.
  const isJsonParseError = (err: unknown): boolean =>
    err instanceof SyntaxError ||
    /JSON|unexpected|parse/i.test((err as Error)?.message ?? '');

  try {
    await manager.initialize({ readOnly: true });
    return;
  } catch (err) {
    if (!isJsonParseError(err)) throw err;
    logger.warn('kb search: JSON parse error on FAISS load (likely concurrent writer); retrying in 100ms');
  }
  await new Promise((r) => setTimeout(r, 100));
  try {
    await manager.initialize({ readOnly: true });
  } catch (err) {
    // Issue #1179 — a classified error (e.g. CORRUPT_INDEX, whose message
    // embeds the parser's "Unexpected token" text) keeps its code; only an
    // unclassified parse failure is reported as a concurrent write.
    if (isJsonParseError(err) && !(err instanceof KBError)) {
      throw new Error(
        `Index appears to be mid-write (concurrent writer is updating it). ` +
        `Please retry in a moment. Underlying error: ${(err as Error).message}`,
      );
    }
    throw err;
  }
}

export interface CapturedProcessOutput {
  /** Process exit code from the captured handler; see the `EXIT` taxonomy in `./cli-exit-codes.js`. */
  exitCode: number;
  stdout: string;
  stderr: string;
}

// -- Global verbosity (issue #739) -------------------------------------------
//
// A single shared mechanism so every migrated `kb` subcommand honors the same
// `--quiet`/`--verbose` flags instead of each reinventing output-noise control.
//   - `--quiet` / `-q`: strip non-essential chatter — progress spinners/lines,
//     freshness footers, and informational status lines — leaving only the
//     primary result and errors. This is what a `… | jq` pipeline wants, and it
//     composes with `--format json`.
//   - `--verbose` / `-v`: surface extra diagnostics (e.g. per-stage timing).
// Errors and genuine warnings are NEVER routed through this mechanism, so a
// degradation signal a user needs to see is not hidden by `--quiet`.

export type Verbosity = 'quiet' | 'normal' | 'verbose';

export interface ParsedVerbosity {
  verbosity: Verbosity;
  /** argv with the verbosity flags removed, ready for a command's own parser. */
  rest: string[];
}

/**
 * Strip `--quiet`/`-q` and `--verbose`/`-v` from argv and resolve one level.
 * When both families appear the LAST occurrence wins, so `--verbose --quiet`
 * ends quiet and `--quiet --verbose` ends verbose. The returned `rest` keeps
 * every other token in order so a command's existing parser is unaffected.
 */
export function extractVerbosity(rest: readonly string[]): ParsedVerbosity {
  let verbosity: Verbosity = 'normal';
  const remaining: string[] = [];
  for (const raw of rest) {
    if (raw === '--quiet' || raw === '-q') { verbosity = 'quiet'; continue; }
    if (raw === '--verbose' || raw === '-v') { verbosity = 'verbose'; continue; }
    remaining.push(raw);
  }
  return { verbosity, rest: remaining };
}

export interface VerbosityPrinter {
  readonly verbosity: Verbosity;
  readonly isQuiet: boolean;
  readonly isVerbose: boolean;
  /** Non-essential status/progress line; written unless `--quiet`. */
  info(text: string): void;
  /** Extra diagnostic line; written only under `--verbose`. */
  diag(text: string): void;
}

/**
 * Build a printer for a resolved verbosity level. `info` is the sink for
 * non-essential lines (suppressed by `--quiet`); `diag` is the sink for
 * verbose-only diagnostics. Both default to stderr so stdout stays clean for
 * the primary result. Callers pass complete lines including any trailing `\n`.
 */
export function createVerbosityPrinter(
  verbosity: Verbosity,
  write: (text: string) => void = (text) => { process.stderr.write(text); },
): VerbosityPrinter {
  return {
    verbosity,
    isQuiet: verbosity === 'quiet',
    isVerbose: verbosity === 'verbose',
    info(text) { if (verbosity !== 'quiet') write(text); },
    diag(text) { if (verbosity === 'verbose') write(text); },
  };
}

export type DelimitedOutputFormat = 'csv' | 'tsv' | 'ndjson';

export interface RenderRecordsOptions {
  columns?: readonly string[];
}

export function renderRecords(
  records: readonly Record<string, unknown>[],
  format: DelimitedOutputFormat,
  options: RenderRecordsOptions = {},
): string {
  if (format === 'ndjson') {
    return records.map((record) => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : '');
  }

  const delimiter = format === 'csv' ? ',' : '\t';
  const columns = options.columns ?? inferColumns(records);
  const lines = [
    columns.map((column) => escapeDelimitedCell(column, delimiter)).join(delimiter),
    ...records.map((record) => columns
      .map((column) => escapeDelimitedCell(formatRecordValue(record[column]), delimiter))
      .join(delimiter)),
  ];
  return `${lines.join('\n')}\n`;
}

function inferColumns(records: readonly Record<string, unknown>[]): string[] {
  const columns = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) columns.add(key);
  }
  return [...columns];
}

function formatRecordValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

function escapeDelimitedCell(value: string, delimiter: string): string {
  if (!value.includes(delimiter) && !value.includes('"') && !value.includes('\n') && !value.includes('\r')) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

interface CaptureStore {
  stdoutChunks: string[];
  stderrChunks: string[];
}

const captureContext = new AsyncLocalStorage<CaptureStore>();

interface StreamPatch {
  /** The wrapper this module installed, or undefined when none is installed. */
  wrapper?: typeof process.stdout.write;
  /** The function that was installed before the wrapper; used for pass-through. */
  original?: typeof process.stdout.write;
}

const stdoutPatch: StreamPatch = {};
const stderrPatch: StreamPatch = {};
let activeCaptures = 0;

function chunkToString(chunk: unknown): string {
  return Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
}

// One process-wide wrapper per stream. Each write is routed to the buffer of the
// capture whose async context issued it, so overlapping captures (daemon
// requests under the admission gate) cannot see or clobber each other's output.
// A write with no capture in its async context passes through to the real stream.
function installPatch(
  stream: NodeJS.WriteStream,
  patch: StreamPatch,
  pick: (store: CaptureStore) => string[],
): void {
  if (patch.wrapper && stream.write === patch.wrapper) return;
  // Re-check on every entry: something (a test spy) may have replaced our
  // wrapper, in which case the current function becomes the new pass-through.
  const original = stream.write;
  const wrapper = ((chunk: unknown, ...args: unknown[]) => {
    const store = captureContext.getStore();
    if (!store) return (patch.original ?? original).call(stream, chunk as never, ...(args as []));
    pick(store).push(chunkToString(chunk));
    const callback = args.find((arg): arg is (err?: Error) => void => typeof arg === 'function');
    if (callback) callback();
    return true;
  }) as typeof stream.write;
  patch.original = original;
  patch.wrapper = wrapper;
  stream.write = wrapper;
}

function releasePatch(stream: NodeJS.WriteStream, patch: StreamPatch): void {
  // Only unwind when our wrapper is still the installed function; if another
  // layer wrapped on top of it, leave that layer intact (our wrapper then
  // passes through once no capture is active).
  if (patch.wrapper && patch.original && stream.write === patch.wrapper) {
    stream.write = patch.original;
    patch.wrapper = undefined;
    patch.original = undefined;
  }
}

export async function captureProcessOutput(
  fn: () => Promise<number>,
): Promise<CapturedProcessOutput> {
  const store: CaptureStore = { stdoutChunks: [], stderrChunks: [] };
  activeCaptures += 1;
  installPatch(process.stdout, stdoutPatch, (s) => s.stdoutChunks);
  installPatch(process.stderr, stderrPatch, (s) => s.stderrChunks);
  try {
    const exitCode = await captureContext.run(store, fn);
    return {
      exitCode,
      stdout: store.stdoutChunks.join(''),
      stderr: store.stderrChunks.join(''),
    };
  } finally {
    activeCaptures -= 1;
    if (activeCaptures === 0) {
      releasePatch(process.stdout, stdoutPatch);
      releasePatch(process.stderr, stderrPatch);
    }
  }
}
