import * as fsp from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import type { CliSearchScenarioResult, CliSearchVariantResult, FixtureOverrides, ScenarioContext } from '../types.js';
import { generateKnowledgeBaseFixture } from '../fixtures/generator.js';
import { durationMs, percentile, resetDirectory } from '../utils.js';

/**
 * Issue #284 — phase-timing benchmark for the real `kb search` CLI path.
 *
 * The other scenarios drive `FaissIndexManager` in-process and miss the user-
 * visible cost of `kb search`: Node startup, argv parse, layout bootstrap,
 * active-model resolution, manager load, optional refresh, retrieval, the
 * staleness scan, grouping/formatting, and stdout/stderr write. This scenario
 * spawns the built `kb` binary against an offline `fake` model with a
 * pre-built index, parses the JSON `--timing` payload, and combines it with
 * externally measured wall time + (Linux-only) peak RSS.
 *
 * The scenario is opt-in via `BENCH_INCLUDE_CLI_SEARCH=1` because each
 * repetition spawns a Node process; the cost is what we are measuring, so it
 * is structurally heavier than the in-process scenarios.
 *
 * The `fake` provider (issue #204) is required: it is offline, deterministic,
 * and has no API-key or daemon dependency, so the spawned CLI can run inside
 * CI without provider stubbing (the existing stub patches embeddings in the
 * parent process only and would not survive the child fork).
 */

const FAKE_MODEL_ID = 'fake__bench-fake';
const FAKE_MODEL_NAME = 'bench-fake';

export interface CliSearchTimingFields {
  bootstrap_ms?: number;
  model_resolution_ms?: number;
  manager_load_ms?: number;
  index_load_ms?: number;
  dense_search_ms?: number;
  embed_query_ms?: number;
  faiss_search_ms?: number;
  query_search_ms?: number;
  post_filter_ms?: number;
  staleness_ms?: number;
  total_ms?: number;
}

export interface CliSearchRepetition {
  wall_ms: number;
  rss_peak_bytes: number | null;
  timing: CliSearchTimingFields | null;
}

interface CliSearchVariantSpec {
  name: string;
  format: 'json' | 'md';
  args: string[];
}

interface CliSearchScenarioOptions {
  repetitions?: number;
  files?: number;
  targetChunksPerFile?: number;
  chunkSize?: number;
}

const DEFAULT_REPETITIONS = 10;

export async function runCliSearchScenario(
  context: ScenarioContext,
  fixtureOverrides: FixtureOverrides = {},
  options: CliSearchScenarioOptions = {},
): Promise<CliSearchScenarioResult> {
  const repetitions = clampPositiveInt(options.repetitions, DEFAULT_REPETITIONS);
  const files = fixtureOverrides.files ?? options.files ?? 20;
  const targetChunksPerFile = fixtureOverrides.targetChunksPerFile ?? options.targetChunksPerFile ?? 5;

  await resetDirectory(context.knowledgeBasesRootDir);
  await resetDirectory(context.faissIndexPath);
  context.stubController?.resetCounters();

  const fixture = await generateKnowledgeBaseFixture({
    files,
    knowledgeBaseName: context.knowledgeBaseName,
    rootDir: context.knowledgeBasesRootDir,
    seed: context.fixtureSeed + 7,
    targetChunksPerFile,
    chunkSize: fixtureOverrides.chunkSize ?? options.chunkSize,
  });

  await registerFakeModel(context.faissIndexPath);

  const cliPath = path.join(context.buildRoot, 'cli.js');
  const childEnv = buildChildEnv(context);

  await prebuildIndex(cliPath, childEnv, fixture.query);

  const variants: CliSearchVariantSpec[] = [
    { name: 'json-global', format: 'json', args: ['--format=json', '--timing'] },
    { name: 'md-global', format: 'md', args: ['--format=md', '--timing'] },
  ];

  const variantResults: CliSearchVariantResult[] = [];
  for (const variant of variants) {
    // One warmup invocation to absorb fs / page-cache cold-start noise so the
    // measured `process_start_ms` reflects steady-state Node import cost.
    await spawnCliSearch(cliPath, [fixture.query, ...variant.args], childEnv);

    const reps: CliSearchRepetition[] = [];
    for (let r = 0; r < repetitions; r += 1) {
      reps.push(await spawnCliSearch(cliPath, [fixture.query, ...variant.args], childEnv));
    }
    variantResults.push(aggregateCliSearchVariant(variant.name, variant.format, reps));
  }

  return {
    fixture_files: fixture.files,
    fixture_chunk_count: fixture.chunkCount,
    variants: variantResults,
  };
}

/**
 * Parse the `timing` block out of `kb search --format=json --timing` stdout.
 * Returns null when no JSON payload or no `timing` field is present so the
 * caller can record the repetition's external wall time without internal phase
 * detail. Markdown output lines like `> _Timing (dense): bootstrap_ms=4ms, …_`
 * are parsed too, so the same helper handles both formats.
 */
export function parseCliSearchTimingFromStdout(stdout: string): CliSearchTimingFields | null {
  const json = tryExtractJson(stdout);
  if (json && typeof json === 'object' && json !== null && 'timing' in json) {
    const timing = (json as { timing?: unknown }).timing;
    if (timing && typeof timing === 'object') {
      return pickTimingFields(timing as Record<string, unknown>);
    }
  }
  // Markdown timing footer: `> _Timing (dense): k=Vms, …._`. The body itself
  // contains `_` characters (e.g. `bootstrap_ms`) so the lazy capture must be
  // anchored to end-of-line via the `m` flag instead of trying to exclude `_`.
  const footerMatch = /_Timing[^:]*:\s*(.+?)\._\s*$/m.exec(stdout);
  if (footerMatch) {
    const pairs = footerMatch[1].split(',').map((s) => s.trim());
    const out: Record<string, unknown> = {};
    for (const pair of pairs) {
      const eqIndex = pair.indexOf('=');
      if (eqIndex <= 0) continue;
      const key = pair.slice(0, eqIndex).trim();
      const valueRaw = pair.slice(eqIndex + 1).trim();
      const numericMatch = /^(-?\d+(?:\.\d+)?)/.exec(valueRaw);
      if (numericMatch) out[key] = Number(numericMatch[1]);
    }
    return pickTimingFields(out);
  }
  return null;
}

/**
 * Reduce a list of per-repetition measurements to p50/p95/p99 across wall
 * time and each named phase timing. Missing phase values are skipped (the
 * percentile is computed only over reps that emitted the field); a variant
 * with zero phase samples reports `null` for that percentile.
 */
export function aggregateCliSearchVariant(
  name: string,
  format: 'json' | 'md',
  reps: readonly CliSearchRepetition[],
): CliSearchVariantResult {
  if (reps.length === 0) {
    throw new Error(`cli-search scenario: aggregateCliSearchVariant("${name}") called with no repetitions`);
  }
  const wallSamples = reps.map((r) => r.wall_ms);
  const rssSamples = reps.map((r) => r.rss_peak_bytes).filter((v): v is number => v !== null);

  const sampleFor = (key: keyof CliSearchTimingFields): number[] => {
    const out: number[] = [];
    for (const r of reps) {
      const v = r.timing?.[key];
      if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    }
    return out;
  };

  const cliTotalSamples = sampleFor('total_ms');
  const processStartSamples: number[] = [];
  for (const r of reps) {
    const totalMs = r.timing?.total_ms;
    if (typeof totalMs === 'number' && Number.isFinite(totalMs)) {
      processStartSamples.push(Math.max(0, r.wall_ms - totalMs));
    }
  }

  return {
    variant: name,
    format,
    repetitions: reps.length,
    wall_p50_ms: percentile(wallSamples, 50),
    wall_p95_ms: percentile(wallSamples, 95),
    wall_p99_ms: percentile(wallSamples, 99),
    process_start_p50_ms: processStartSamples.length > 0 ? percentile(processStartSamples, 50) : null,
    bootstrap_p50_ms: percentileOrNull(sampleFor('bootstrap_ms'), 50),
    model_resolution_p50_ms: percentileOrNull(sampleFor('model_resolution_ms'), 50),
    manager_load_p50_ms: percentileOrNull(sampleFor('manager_load_ms'), 50),
    index_load_p50_ms: percentileOrNull(sampleFor('index_load_ms'), 50),
    embed_query_p50_ms: percentileOrNull(sampleFor('embed_query_ms'), 50),
    faiss_search_p50_ms: percentileOrNull(sampleFor('faiss_search_ms'), 50),
    post_filter_p50_ms: percentileOrNull(sampleFor('post_filter_ms'), 50),
    staleness_p50_ms: percentileOrNull(sampleFor('staleness_ms'), 50),
    cli_total_p50_ms: percentileOrNull(cliTotalSamples, 50),
    rss_peak_bytes: rssSamples.length > 0 ? Math.max(...rssSamples) : null,
  };
}

function percentileOrNull(samples: number[], p: number): number | null {
  return samples.length > 0 ? percentile(samples, p) : null;
}

function pickTimingFields(source: Record<string, unknown>): CliSearchTimingFields {
  const out: CliSearchTimingFields = {};
  const keys: Array<keyof CliSearchTimingFields> = [
    'bootstrap_ms', 'model_resolution_ms', 'manager_load_ms', 'index_load_ms',
    'dense_search_ms', 'embed_query_ms', 'faiss_search_ms', 'query_search_ms',
    'post_filter_ms', 'staleness_ms', 'total_ms',
  ];
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function tryExtractJson(stdout: string): unknown {
  const trimmed = stdout.trimStart();
  if (!trimmed.startsWith('{')) return null;
  // The CLI emits `${JSON.stringify(payload, null, 2)}\n`; nothing else on stdout.
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

async function registerFakeModel(faissIndexPath: string): Promise<void> {
  // Issue #284 — minimum on-disk registration (active-model.ts isRegisteredModel):
  // models/<id>/ dir + model_name.txt; no .adding sentinel. active.txt names
  // the model so resolveActiveModel step 3 wins without needing KB_ACTIVE_MODEL.
  const modelDir = path.join(faissIndexPath, 'models', FAKE_MODEL_ID);
  await fsp.mkdir(modelDir, { recursive: true });
  await fsp.writeFile(path.join(modelDir, 'model_name.txt'), FAKE_MODEL_NAME, 'utf-8');
  await fsp.writeFile(path.join(faissIndexPath, 'active.txt'), FAKE_MODEL_ID, 'utf-8');
}

function buildChildEnv(context: ScenarioContext): NodeJS.ProcessEnv {
  // Copy parent env then override the keys the CLI reads at boot. The bench
  // parent has already pointed KNOWLEDGE_BASES_ROOT_DIR / FAISS_INDEX_PATH at
  // the per-pid workspace; the child needs the same plus EMBEDDING_PROVIDER=fake.
  return {
    ...process.env,
    EMBEDDING_PROVIDER: 'fake',
    KNOWLEDGE_BASES_ROOT_DIR: context.knowledgeBasesRootDir,
    FAISS_INDEX_PATH: context.faissIndexPath,
    KB_ACTIVE_MODEL: FAKE_MODEL_ID,
    // Silence the structured log file the CLI opens at boot so the bench's
    // temp dir does not accumulate per-rep log files.
    LOG_FILE: path.join(context.faissIndexPath, 'cli-search-bench.log'),
  };
}

async function prebuildIndex(cliPath: string, env: NodeJS.ProcessEnv, query: string): Promise<void> {
  const result = await spawnCliSearch(
    cliPath,
    [query, '--refresh', '--format=json'],
    env,
  );
  // The prebuild result is discarded — only the persisted index matters.
  if (result.wall_ms < 0) {
    throw new Error('cli-search scenario: prebuild produced negative wall time (clock skew?)');
  }
}

async function spawnCliSearch(
  cliPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CliSearchRepetition> {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const child = spawn(process.execPath, [cliPath, 'search', ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    // Linux-only: poll /proc/<pid>/status for VmHWM (peak RSS). Best-effort —
    // the file disappears on exit and may be unreadable on non-Linux kernels.
    let rssPeak: number | null = null;
    const pollHandle = process.platform === 'linux' && child.pid !== undefined
      ? setInterval(() => {
          if (child.pid === undefined) return;
          readVmHwmKb(child.pid).then((kb) => {
            if (kb !== null) {
              const bytes = kb * 1024;
              if (rssPeak === null || bytes > rssPeak) rssPeak = bytes;
            }
          }).catch(() => undefined);
        }, 10)
      : null;

    child.on('error', (err) => {
      if (pollHandle) clearInterval(pollHandle);
      reject(err);
    });
    child.on('exit', (code) => {
      if (pollHandle) clearInterval(pollHandle);
      const end = process.hrtime.bigint();
      const wall_ms = Number(durationMs(start, end).toFixed(3));
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      if (code !== 0) {
        reject(new Error(
          `kb search exited with code ${code}.\nstderr:\n${stderr}\nstdout:\n${stdout.slice(0, 4000)}`,
        ));
        return;
      }
      const timing = parseCliSearchTimingFromStdout(stdout);
      resolve({ wall_ms, rss_peak_bytes: rssPeak, timing });
    });
  });
}

async function readVmHwmKb(pid: number): Promise<number | null> {
  try {
    const raw = await fsp.readFile(`/proc/${pid}/status`, 'utf-8');
    const match = /^VmHWM:\s+(\d+)\s+kB/m.exec(raw);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
