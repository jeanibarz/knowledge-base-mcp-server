// `kb doctor` — aggregate read-only health report for local KB operations
// (issue #180). The command intentionally composes existing filesystem and
// model-resolution surfaces instead of loading the FAISS store or embedding
// documents.

import * as fsp from 'fs/promises';
import { realpathSync } from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  ActiveModelResolutionError,
  listIncompleteModelStates,
  listRegisteredModels,
  parseModelId,
  resolveActiveModel,
  resolveFaissIndexBinaryPath,
} from './active-model.js';
import {
  FAISS_INDEX_PATH,
  HUGGINGFACE_ENDPOINT_URL_OVERRIDDEN,
  INGEST_EXCLUDE_PATHS,
  INGEST_EXTRA_EXTENSIONS,
  KNOWLEDGE_BASES_ROOT_DIR,
  OLLAMA_BASE_URL,
} from './config.js';
import { enumerateIngestableKbFiles, listKnowledgeBases } from './kb-fs.js';
import {
  createNeverRunIndexUpdateSummary,
  FaissIndexManager,
  type IndexUpdateSummary,
} from './FaissIndexManager.js';
import {
  AgeBudgetConfigError,
  computeAgeBudgetStatus,
  formatAgeBudgetBreachRow,
  formatAgeHours,
  type AgeBudgetStatus,
} from './age-budget.js';
import { maxMtimeIso } from './kb-stats.js';
import {
  providerCallMetrics,
  type ProviderCallMetrics,
  type ProviderCallSnapshot,
} from './metrics.js';

/**
 * Issue #210 — error-rate threshold above which the doctor surfaces a
 * WARN row for a model_id. 5% matches the issue spec; intentionally
 * coarse so transient one-off failures on a low-volume process don't
 * trip an operator's alarm.
 */
export const PROVIDER_CALL_ERROR_RATE_WARN_THRESHOLD = 0.05;

const execFileAsync = promisify(execFile);

export const DOCTOR_HELP = `kb doctor — aggregate model / index / backend health report

Usage:
  kb doctor [--format=md|json]

Composes existing read-only checks (env vars, registered models, active
model, FAISS index presence + mtime, knowledge-base count, embedding
backend reachability) into a single status report. Does NOT load the
FAISS store or embed documents.

Report status is one of \`ok\`, \`warn\`, or \`error\`. The exit code is non-zero
when any required check fails, so \`kb doctor && kb search ...\` is a safe
gate from a script.

Options:
  --format=md|json      Output format (default: md). \`json\` emits the same
                        underlying report shape for agent shells.
  --help, -h            Show this help.

Examples:
  kb doctor
  kb doctor --format=json
  kb doctor && kb search "rollback"
`;

export interface DoctorArgs {
  format: 'md' | 'json';
}

export type HealthStatus = 'ok' | 'warn' | 'error';

export interface DoctorReport {
  status: HealthStatus;
  checks: Array<{ name: string; status: HealthStatus; detail: string }>;
  active_model: {
    model_id: string | null;
    provider: string | null;
    model_name: string | null;
  };
  index: {
    path: string;
    binary_path: string | null;
    version: string | null;
    mtime: string | null;
  };
  stale_counts_by_kb: Record<string, { modified_files: number; new_files: number }>;
  /**
   * Per-KB time-based age budget status (issue #218). Only KBs that have
   * a configured budget (per-KB or via the global `KB_AGE_BUDGET_HOURS`
   * fallback) appear in this map. `current_age_hours` is `null` when the
   * KB has never been indexed.
   */
  age_budgets: Record<
    string,
    {
      configured_hours: number;
      current_age_hours: number | null;
      breach: boolean;
    }
  >;
  /**
   * Malformed `KB_AGE_BUDGET_HOURS*` env-var values surfaced as a
   * separate list so the operator notices a typo even when the
   * affected KB falls back to "no budget". Empty when all configured
   * values parsed cleanly.
   */
  age_budget_config_errors: Array<{
    env_var: string;
    raw_value: string;
    message: string;
  }>;
  incomplete_models: Array<{
    model_id: string;
    status: 'in_progress' | 'stale_interrupted' | 'unknown';
    detail: string;
    pid: number | null;
    provider: string | null;
    model_name: string | null;
    started_at: string | null;
    recovery_command: string | null;
  }>;
  backend: {
    provider: string | null;
    healthy: boolean;
    detail: string;
  };
  cli: {
    version: string;
    package_root: string;
    invoked_path: string | null;
    symlinked_checkout_path: string | null;
  };
  git: {
    branch: string | null;
    head: string | null;
    origin_main: string | null;
    relation: 'ahead' | 'behind' | 'diverged' | 'up-to-date' | 'unknown';
  } | null;
  last_index_update: IndexUpdateSummary;
  /**
   * Issue #210 — per-`model_id` runtime telemetry for the active
   * embedding provider. Empty `{}` until the active provider has served
   * at least one call. The doctor row is WARN when
   * `errors / count > PROVIDER_CALL_ERROR_RATE_WARN_THRESHOLD` for any
   * model_id; otherwise it is OK.
   */
  provider_calls: Record<string, ProviderCallSnapshot>;
}

export interface BuildDoctorReportOptions {
  backendHealthCheck?: BackendHealthCheck;
  packageRoot?: string;
  invokedPath?: string | null;
  packageVersion?: string;
  lastIndexUpdateSummary?: IndexUpdateSummary;
  /**
   * Issue #210 — test seam for the provider-call telemetry registry.
   * Production callers leave this undefined so the process-wide
   * singleton is read.
   */
  providerCallMetrics?: ProviderCallMetrics;
}

export type BackendHealthCheck = (
  provider: string,
  modelName: string,
) => Promise<{ healthy: boolean; detail: string }>;

export async function runDoctor(rest: string[]): Promise<number> {
  let parsed: DoctorArgs;
  try {
    parsed = parseDoctorArgs(rest);
  } catch (err) {
    process.stderr.write(`kb doctor: ${(err as Error).message}\n`);
    return 2;
  }

  const report = await buildDoctorReport();
  if (parsed.format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatDoctorMarkdown(report));
  }
  return report.status === 'error' ? 1 : 0;
}

export function parseDoctorArgs(rest: string[]): DoctorArgs {
  const out: DoctorArgs = { format: 'md' };
  for (const raw of rest) {
    if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length);
      if (value !== 'md' && value !== 'json') {
        throw new Error(`invalid --format: ${raw}`);
      }
      out.format = value;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
  }
  return out;
}

export async function buildDoctorReport(
  options: BuildDoctorReportOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorReport['checks'] = [];
  let activeModelId: string | null = null;
  let activeProvider: string | null = null;
  let activeModelName: string | null = null;

  try {
    await FaissIndexManager.bootstrapLayout();
    checks.push({ name: 'layout', status: 'ok', detail: 'index layout bootstrap succeeded' });
  } catch (err) {
    checks.push({ name: 'layout', status: 'error', detail: (err as Error).message });
  }

  try {
    activeModelId = await resolveActiveModel();
    const model = (await listRegisteredModels()).find((m) => m.model_id === activeModelId);
    const parsed = parseModelId(activeModelId);
    activeProvider = parsed.provider;
    activeModelName = model?.model_name ?? parsed.slugBody;
    checks.push({ name: 'active_model', status: 'ok', detail: activeModelId });
  } catch (err) {
    const status = err instanceof ActiveModelResolutionError ? 'error' : 'error';
    checks.push({ name: 'active_model', status, detail: (err as Error).message });
  }

  const index = await readIndexHealth(activeModelId);
  checks.push({
    name: 'index',
    status: index.binary_path === null ? 'error' : 'ok',
    detail: index.binary_path === null
      ? 'active model index is not built'
      : `${index.version ?? 'unknown'} at ${index.mtime ?? 'unknown mtime'}`,
  });

  const staleCounts = await computeStaleCountsByKb(
    activeModelId,
    index.mtime === null ? null : Date.parse(index.mtime),
  );
  const staleTotal = Object.values(staleCounts)
    .reduce((sum, row) => sum + row.modified_files + row.new_files, 0);
  checks.push({
    name: 'staleness',
    status: staleTotal === 0 ? 'ok' : 'warn',
    detail: staleTotal === 0
      ? 'no modified or new ingestable files detected'
      : `${staleTotal} modified/new ingestable file(s) detected`,
  });

  const ageBudgetResult = await computeAgeBudgetsByKb(
    Object.keys(staleCounts),
  );
  if (
    Object.keys(ageBudgetResult.byKb).length > 0 ||
    ageBudgetResult.configErrors.length > 0
  ) {
    const breaches = Object.entries(ageBudgetResult.byKb)
      .filter(([, row]) => row.breach);
    if (ageBudgetResult.configErrors.length > 0) {
      const summary = ageBudgetResult.configErrors
        .map((e) => `${e.env_var}=${JSON.stringify(e.raw_value)}`)
        .join(', ');
      checks.push({
        name: 'age_budget',
        status: 'error',
        detail: `malformed age-budget config: ${summary}`,
      });
    } else if (breaches.length > 0) {
      const summary = breaches
        .map(([kb, row]) =>
          `kb=${kb}, age=${formatAgeHours(row.current_age_hours)}h, ` +
          `budget=${row.configured_hours}h`,
        )
        .join('; ');
      checks.push({
        name: 'age_budget',
        status: 'warn',
        detail: `${breaches.length} KB age-budget breach(es): ${summary}`,
      });
    } else {
      const configured = Object.keys(ageBudgetResult.byKb).length;
      checks.push({
        name: 'age_budget',
        status: 'ok',
        detail: `no breaches across ${configured} KB(s) with configured budgets`,
      });
    }
  }

  const incompleteModels = await listIncompleteModelStates();
  const staleIncompleteModels = incompleteModels.filter((m) => m.status === 'stale_interrupted');
  checks.push({
    name: 'incomplete_models',
    status: staleIncompleteModels.length > 0 ? 'warn' : 'ok',
    detail: staleIncompleteModels.length === 0
      ? 'no stale incomplete model directories detected'
      : `${staleIncompleteModels.length} stale incomplete model director${staleIncompleteModels.length === 1 ? 'y' : 'ies'} detected`,
  });

  const backend = await readBackendHealth(
    activeProvider,
    activeModelName,
    options.backendHealthCheck ?? defaultBackendHealthCheck,
  );
  // Issue #204 — the `fake` provider is functionally healthy (no network,
  // no key, deterministic vectors) but must not silently power production.
  // Surface the active fake provider as WARN so `kb doctor` is loud about
  // it without forcing a non-zero exit code.
  const backendIsFake = activeProvider === 'fake';
  checks.push({
    name: 'backend',
    status: !backend.healthy ? 'error' : (backendIsFake ? 'warn' : 'ok'),
    detail: backend.detail,
  });

  const metricsSource = options.providerCallMetrics ?? providerCallMetrics;
  const providerCalls = metricsSource.snapshot();
  // Issue #210 — only emit the row when at least one call has been
  // observed; otherwise the doctor on a fresh process would always show
  // a noisy "no telemetry yet" line.
  if (Object.keys(providerCalls).length > 0) {
    const breaches = Object.entries(providerCalls)
      .filter(([, row]) => row.count > 0
        && row.errors / row.count > PROVIDER_CALL_ERROR_RATE_WARN_THRESHOLD);
    if (breaches.length > 0) {
      const summary = breaches
        .map(([modelId, row]) =>
          `model=${modelId}, errors=${row.errors}/${row.count}` +
          ` (${formatErrorRate(row.errors, row.count)})`,
        )
        .join('; ');
      checks.push({
        name: 'provider_calls',
        status: 'warn',
        detail: `${breaches.length} model(s) over ` +
          `${formatErrorRate(PROVIDER_CALL_ERROR_RATE_WARN_THRESHOLD * 100, 100)}` +
          ` error rate: ${summary}`,
      });
    } else {
      const totals = Object.values(providerCalls)
        .reduce((sum, row) => sum + row.count, 0);
      checks.push({
        name: 'provider_calls',
        status: 'ok',
        detail: `${totals} call(s) across ${Object.keys(providerCalls).length}` +
          ' model(s) within error budget',
      });
    }
  }

  const packageRoot = options.packageRoot ?? resolvePackageRoot();
  const invokedPath = options.invokedPath ?? process.argv[1] ?? null;
  const cli = {
    version: options.packageVersion ?? await readPackageVersion(packageRoot),
    package_root: packageRoot,
    invoked_path: invokedPath,
    symlinked_checkout_path: detectSymlinkedCheckoutPath(packageRoot, invokedPath),
  };
  const git = await readGitState(packageRoot);
  const lastIndexUpdate = options.lastIndexUpdateSummary
    ?? createNeverRunIndexUpdateSummary(activeModelId);

  const status = summarizeStatus(checks);
  return {
    status,
    checks,
    active_model: {
      model_id: activeModelId,
      provider: activeProvider,
      model_name: activeModelName,
    },
    index,
    stale_counts_by_kb: staleCounts,
    age_budgets: ageBudgetResult.byKb,
    age_budget_config_errors: ageBudgetResult.configErrors,
    incomplete_models: incompleteModels,
    backend,
    cli,
    git,
    last_index_update: lastIndexUpdate,
    provider_calls: providerCalls,
  };
}

function formatErrorRate(errors: number, count: number): string {
  if (count === 0) return '0%';
  const pct = (errors / count) * 100;
  return `${pct.toFixed(1)}%`;
}

async function readIndexHealth(activeModelId: string | null): Promise<DoctorReport['index']> {
  if (activeModelId === null) {
    return { path: FAISS_INDEX_PATH, binary_path: null, version: null, mtime: null };
  }
  const binaryPath = await resolveFaissIndexBinaryPath(activeModelId);
  if (binaryPath === null) {
    return { path: FAISS_INDEX_PATH, binary_path: null, version: null, mtime: null };
  }
  try {
    const st = await fsp.stat(binaryPath);
    return {
      path: FAISS_INDEX_PATH,
      binary_path: binaryPath,
      version: indexVersionFromPath(binaryPath),
      mtime: new Date(st.mtimeMs).toISOString(),
    };
  } catch {
    return { path: FAISS_INDEX_PATH, binary_path: null, version: null, mtime: null };
  }
}

async function computeStaleCountsByKb(
  activeModelId: string | null,
  indexMtimeMs: number | null,
): Promise<DoctorReport['stale_counts_by_kb']> {
  let kbs: string[];
  try {
    kbs = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
  } catch {
    return {};
  }

  const enumerations = await enumerateIngestableKbFiles(
    KNOWLEDGE_BASES_ROOT_DIR,
    kbs,
    {
      extraExtensions: INGEST_EXTRA_EXTENSIONS,
      excludePaths: INGEST_EXCLUDE_PATHS,
    },
  );

  const out: DoctorReport['stale_counts_by_kb'] = {};
  for (const { kbName, kbPath, filePaths } of enumerations) {
    let modified = 0;
    for (const filePath of filePaths) {
      if (indexMtimeMs === null) continue;
      try {
        const st = await fsp.stat(filePath);
        if (st.mtimeMs > indexMtimeMs) modified += 1;
      } catch {
        // Vanished between walk and stat; ignore in a read-only health check.
      }
    }
    const sidecarCount = await countFiles(path.join(kbPath, '.index'));
    const added = activeModelId === null || indexMtimeMs === null
      ? filePaths.length
      : Math.max(0, filePaths.length - sidecarCount);
    out[kbName] = { modified_files: modified, new_files: added };
  }
  return out;
}

/**
 * Iterate KBs and produce the per-KB age-budget rows for the doctor
 * report. Only KBs whose name resolves to a configured budget (either
 * the per-KB env var or the global `KB_AGE_BUDGET_HOURS` fallback) are
 * included. Malformed env values are collected separately so the
 * operator notices the typo while the affected KB silently falls back
 * to "no budget".
 */
async function computeAgeBudgetsByKb(
  kbNames: string[],
): Promise<{
  byKb: DoctorReport['age_budgets'];
  configErrors: DoctorReport['age_budget_config_errors'];
}> {
  const nowMs = Date.now();
  const byKb: DoctorReport['age_budgets'] = {};
  const configErrors: DoctorReport['age_budget_config_errors'] = [];
  for (const kbName of kbNames) {
    const lastIndexAtIso = await maxMtimeIso(
      path.join(KNOWLEDGE_BASES_ROOT_DIR, kbName, '.index'),
    );
    const lastIndexAtMs = lastIndexAtIso === null
      ? null
      : Date.parse(lastIndexAtIso);
    let status: AgeBudgetStatus;
    try {
      status = computeAgeBudgetStatus(kbName, lastIndexAtMs, nowMs);
    } catch (err) {
      if (!(err instanceof AgeBudgetConfigError)) throw err;
      configErrors.push({
        env_var: err.envVar,
        raw_value: err.rawValue,
        message: err.message,
      });
      continue;
    }
    if (status.configuredHours === null) continue;
    byKb[kbName] = {
      configured_hours: status.configuredHours,
      current_age_hours:
        status.currentAgeHours === null ? null : status.currentAgeHours,
      breach: status.breach,
    };
  }
  return { byKb, configErrors };
}

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  async function walk(target: string): Promise<void> {
    let entries: Array<import('fs').Dirent>;
    try {
      entries = await fsp.readdir(target, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw err;
    }
    for (const entry of entries) {
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        count += 1;
      }
    }
  }
  await walk(dir);
  return count;
}

async function readBackendHealth(
  provider: string | null,
  modelName: string | null,
  check: BackendHealthCheck,
): Promise<DoctorReport['backend']> {
  if (provider === null || modelName === null) {
    return { provider, healthy: false, detail: 'no active model resolved' };
  }
  const result = await check(provider, modelName).catch((err): { healthy: boolean; detail: string } => ({
    healthy: false,
    detail: (err as Error).message,
  }));
  return { provider, ...result };
}

async function defaultBackendHealthCheck(
  provider: string,
  modelName: string,
): Promise<{ healthy: boolean; detail: string }> {
  if (provider === 'fake') {
    // Issue #204 — deterministic offline provider. No reachability check
    // possible; the doctor row is marked WARN at the call site so the
    // operator sees the "testing only" note in the status report.
    return {
      healthy: true,
      detail: `fake provider active for ${modelName} — testing only, do not deploy to production`,
    };
  }

  if (provider === 'ollama') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(new URL('/api/tags', OLLAMA_BASE_URL), {
        signal: controller.signal,
      });
      if (!res.ok) return { healthy: false, detail: `Ollama ${OLLAMA_BASE_URL} returned HTTP ${res.status}` };
      return { healthy: true, detail: `Ollama ${OLLAMA_BASE_URL} is reachable for ${modelName}` };
    } catch (err) {
      const message = (err as Error).name === 'AbortError'
        ? 'timed out'
        : (err as Error).message;
      return { healthy: false, detail: `Ollama ${OLLAMA_BASE_URL} is not reachable: ${message}` };
    } finally {
      clearTimeout(timeout);
    }
  }

  if (provider === 'openai') {
    return process.env.OPENAI_API_KEY
      ? { healthy: true, detail: `OPENAI_API_KEY is set for ${modelName}` }
      : { healthy: false, detail: 'OPENAI_API_KEY is not set' };
  }

  if (provider === 'huggingface') {
    if (!process.env.HUGGINGFACE_API_KEY) {
      return { healthy: false, detail: 'HUGGINGFACE_API_KEY is not set' };
    }
    const endpointNote = HUGGINGFACE_ENDPOINT_URL_OVERRIDDEN
      ? 'custom endpoint configured'
      : 'router endpoint configured';
    return { healthy: true, detail: `HUGGINGFACE_API_KEY is set for ${modelName}; ${endpointNote}` };
  }

  return { healthy: false, detail: `unsupported provider: ${provider}` };
}

function summarizeStatus(checks: DoctorReport['checks']): HealthStatus {
  if (checks.some((c) => c.status === 'error')) return 'error';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}

function indexVersionFromPath(binaryPath: string): string {
  const parent = path.basename(path.dirname(binaryPath));
  if (/^index\.v\d+$/.test(parent)) return parent;
  if (parent === 'faiss.index') return 'legacy';
  return parent;
}

function resolvePackageRoot(): string {
  if (process.argv[1]) {
    try {
      return path.resolve(path.dirname(realpathSync(process.argv[1])), '..');
    } catch {
      // Fall through to cwd below.
    }
  }
  return process.cwd();
}

async function readPackageVersion(packageRoot: string): Promise<string> {
  try {
    const raw = await fsp.readFile(path.join(packageRoot, 'package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function detectSymlinkedCheckoutPath(packageRoot: string, invokedPath: string | null): string | null {
  if (invokedPath === null) return null;
  try {
    const invokedLexical = path.resolve(invokedPath);
    const invokedReal = realpathSync(invokedPath);
    const cliReal = path.join(packageRoot, 'build', 'cli.js');
    if (invokedLexical !== invokedReal && invokedReal === cliReal) return packageRoot;
  } catch {
    return null;
  }
  return null;
}

async function readGitState(packageRoot: string): Promise<DoctorReport['git']> {
  try {
    const [branch, head, originMain] = await Promise.all([
      git(packageRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(packageRoot, ['rev-parse', '--short', 'HEAD']),
      git(packageRoot, ['rev-parse', '--short', 'origin/main']),
    ]);
    let relation: 'ahead' | 'behind' | 'diverged' | 'up-to-date' | 'unknown' = 'unknown';
    try {
      const counts = await git(packageRoot, ['rev-list', '--left-right', '--count', 'HEAD...origin/main']);
      const [aheadRaw, behindRaw] = counts.split(/\s+/);
      const ahead = Number(aheadRaw);
      const behind = Number(behindRaw);
      if (ahead === 0 && behind === 0) relation = 'up-to-date';
      else if (ahead > 0 && behind === 0) relation = 'ahead';
      else if (ahead === 0 && behind > 0) relation = 'behind';
      else if (ahead > 0 && behind > 0) relation = 'diverged';
    } catch {
      relation = 'unknown';
    }
    return { branch, head, origin_main: originMain, relation };
  } catch {
    return null;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

export function formatDoctorMarkdown(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`Status: ${report.status.toUpperCase()}`);
  lines.push('');
  lines.push(`Active model: ${report.active_model.model_id ?? '<unresolved>'}`);
  if (report.active_model.provider !== null && report.active_model.model_name !== null) {
    lines.push(`Provider/model: ${report.active_model.provider} / ${report.active_model.model_name}`);
  }
  lines.push(`Index: ${report.index.binary_path ?? '<not built>'}`);
  lines.push(`Index version: ${report.index.version ?? '<unknown>'}`);
  lines.push(`Index mtime: ${report.index.mtime ?? '<none>'}`);
  lines.push(`Last index update: ${formatLastIndexUpdate(report.last_index_update)}`);
  lines.push(`Backend: ${report.backend.healthy ? 'ok' : 'error'} — ${report.backend.detail}`);
  lines.push(`kb version: ${report.cli.version}`);
  if (report.cli.symlinked_checkout_path !== null) {
    lines.push(`Linked checkout: ${report.cli.symlinked_checkout_path}`);
  }
  if (report.git !== null) {
    lines.push(
      `Git: ${report.git.branch ?? '<unknown>'} ${report.git.head ?? '<unknown>'} ` +
      `vs origin/main ${report.git.origin_main ?? '<unknown>'} (${report.git.relation})`,
    );
  }
  lines.push('');
  lines.push('Stale counts by KB:');
  const names = Object.keys(report.stale_counts_by_kb).sort();
  if (names.length === 0) {
    lines.push('  (no knowledge bases found)');
  } else {
    for (const name of names) {
      const row = report.stale_counts_by_kb[name];
      lines.push(`  ${name}: ${row.modified_files} modified, ${row.new_files} new`);
    }
  }
  lines.push('');
  lines.push('Age budgets:');
  const budgetNames = Object.keys(report.age_budgets).sort();
  if (budgetNames.length === 0 && report.age_budget_config_errors.length === 0) {
    lines.push('  (no budgets configured)');
  } else {
    for (const name of budgetNames) {
      const row = report.age_budgets[name];
      const age = formatAgeHours(row.current_age_hours);
      const ageDisplay = age === null ? 'never indexed' : `${age}h`;
      if (row.breach) {
        const breachRow = formatAgeBudgetBreachRow({
          kb: name,
          configuredHours: row.configured_hours,
          currentAgeHours: row.current_age_hours,
          breach: true,
        });
        lines.push(`  ${breachRow ?? `${name}: age=${ageDisplay}, budget=${row.configured_hours}h, BREACH`}`);
      } else {
        lines.push(
          `  ${name}: age=${ageDisplay}, budget=${row.configured_hours}h, ok`,
        );
      }
    }
    for (const err of report.age_budget_config_errors) {
      lines.push(`  CONFIG_ERROR: ${err.env_var}=${JSON.stringify(err.raw_value)}`);
    }
  }
  lines.push('');
  lines.push('Provider calls:');
  const providerModelIds = Object.keys(report.provider_calls).sort();
  if (providerModelIds.length === 0) {
    lines.push('  (no provider calls observed)');
  } else {
    for (const modelId of providerModelIds) {
      const row = report.provider_calls[modelId];
      const errorMarker = row.count > 0
        && row.errors / row.count > PROVIDER_CALL_ERROR_RATE_WARN_THRESHOLD
        ? ', WARN'
        : '';
      const tokens = row.tokens_in === null
        ? 'tokens=n/a'
        : `tokens=${row.tokens_in}`;
      lines.push(
        `  model=${modelId} calls=${row.count} errors=${row.errors}` +
        ` p50=${row.latency_ms.p50}ms p95=${row.latency_ms.p95}ms` +
        ` p99=${row.latency_ms.p99}ms ${tokens}${errorMarker}`,
      );
    }
  }
  lines.push('');
  lines.push('Incomplete model dirs:');
  if (report.incomplete_models.length === 0) {
    lines.push('  (none)');
  } else {
    for (const model of report.incomplete_models) {
      const recovery = model.recovery_command === null ? '' : `; recovery: ${model.recovery_command}`;
      lines.push(`  ${model.status} ${model.model_id}: ${model.detail}${recovery}`);
    }
  }
  lines.push('');
  lines.push('Checks:');
  for (const check of report.checks) {
    lines.push(`  ${check.status.toUpperCase().padEnd(5)} ${check.name}: ${check.detail}`);
  }
  return lines.join('\n') + '\n';
}

function formatLastIndexUpdate(summary: IndexUpdateSummary): string {
  if (summary.status === 'never_run') {
    return 'never run in this process';
  }
  const scope = summary.scope ?? '<unknown scope>';
  const duration = summary.duration_ms === null ? '<unknown duration>' : `${summary.duration_ms}ms`;
  return `${summary.status} (${scope}, ${duration}, ${summary.files_changed} changed, ` +
    `${summary.files_unchanged} unchanged, ${summary.files_skipped} skipped)`;
}
