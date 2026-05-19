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
  readModelIndexStorage,
  resolveActiveModel,
  resolveFaissIndexBinaryPath,
} from './active-model.js';
import {
  FAISS_INDEX_PATH,
  KNOWLEDGE_BASES_ROOT_DIR,
} from './config/paths.js';
import {
  HUGGINGFACE_ENDPOINT_URL_OVERRIDDEN,
  OLLAMA_BASE_URL,
} from './config/provider.js';
import {
  INGEST_EXCLUDE_PATHS,
  INGEST_EXTRA_EXTENSIONS,
} from './config/ingest.js';
import {
  KB_FS_WATCH,
  REINDEX_TRIGGER_PATH,
  REINDEX_TRIGGER_POLL_MS,
  resolveReindexTriggerPath,
  resolveReindexTriggerPollMs,
} from './config/watchers.js';
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
import { countIngestQuarantine } from './ingest-quarantine.js';
import { inspectReindexTriggerFilesystem } from './triggerWatcher.js';
import { deriveHealthUrl, probeLlmEndpoint, type LlmProbeResult } from './llm-client.js';
import {
  createExternalProfile,
  resolveProfile,
  type LlmProfile,
} from './llm-profiles.js';
import { resolveRerankerConfig } from './config/reranker.js';

/**
 * Issue #210 — error-rate threshold above which the doctor surfaces a
 * WARN row for a model_id. 5% matches the issue spec; intentionally
 * coarse so transient one-off failures on a low-volume process don't
 * trip an operator's alarm.
 */
export const PROVIDER_CALL_ERROR_RATE_WARN_THRESHOLD = 0.05;
const DEFAULT_LLM_ENDPOINT = 'http://127.0.0.1:8080/v1/chat/completions';
const DOCTOR_LLM_HEALTH_TIMEOUT_MS = 1_000;
const DOCTOR_LLM_CHAT_TIMEOUT_MS = 3_000;

const execFileAsync = promisify(execFile);

export const DOCTOR_HELP = `kb doctor — aggregate model / index / backend health report

Usage:
  kb doctor [--format=md|json] [--reindex-trigger]

Composes existing read-only checks (env vars, registered models, active
model, FAISS index presence + mtime, knowledge-base count, embedding
backend reachability, and local LLM endpoint readiness for kb ask) into
a single status report. Does NOT load the FAISS store, embed documents,
or start managed LLM services.

Report status is one of \`ok\`, \`warn\`, or \`error\`. The exit code is non-zero
when any required check fails, so \`kb doctor && kb search ...\` is a safe
gate from a script.

Options:
  --format=md|json      Output format (default: md). \`json\` emits the same
                        underlying report shape for agent shells.
  --reindex-trigger     Include focused reindex-trigger diagnostics
                        (also included in the aggregate report).
  --help, -h            Show this help.

Examples:
  kb doctor
  kb doctor --format=json
  kb doctor && kb search "rollback"
`;

export interface DoctorArgs {
  format: 'md' | 'json';
  reindexTrigger: boolean;
}

export type HealthStatus = 'ok' | 'warn' | 'error';

export interface DoctorIndexSecurityEntry {
  name: 'faiss_root' | 'active_file' | 'active_model_dir' | 'active_index_version_dir';
  path: string;
  exists: boolean;
  kind: 'directory' | 'file' | 'other' | 'missing';
  mode_octal: string | null;
  uid: number | null;
  expected_uid: number | null;
  permission_status: 'ok' | 'warn' | 'skipped';
  ownership_status: 'ok' | 'warn' | 'skipped';
  warnings: string[];
}

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
    storage: {
      active_version_bytes: number | null;
      inactive_version_count: number;
      inactive_version_bytes: number;
      total_version_bytes: number;
      retention_previous_versions: number;
    };
  };
  /**
   * Best-effort filesystem security checks for the FAISS trust boundary.
   * Ownership is skipped on platforms without `process.getuid`; permission
   * warnings are derived from POSIX group/world write bits where available.
   */
  index_security: {
    permission_check: 'checked' | 'skipped';
    ownership_check: 'checked' | 'skipped';
    entries: DoctorIndexSecurityEntry[];
  };
  stale_counts_by_kb: Record<string, { modified_files: number; new_files: number }>;
  quarantine_counts_by_kb: Record<string, number>;
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
  llm_endpoint: {
    status: HealthStatus;
    endpoint: string | null;
    health_url: string | null;
    endpoint_source: 'env' | 'profile' | 'default' | 'unresolved';
    profile_name: string | null;
    profile_mode: 'managed' | 'external' | null;
    managed_by: string | null;
    unit_name: string | null;
    health_ok: boolean;
    chat_ok: boolean;
    detail: string;
    next_action: string | null;
  };
  reranker: {
    enabled: boolean;
    model: string;
    top_n: number;
    status: HealthStatus;
    cache_path: string | null;
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
   * Reindex-trigger diagnostics for external ingest workflows. This is a
   * read-only configuration and filesystem check; it cannot prove that a
   * separate MCP server process is actively watching the trigger.
   */
  reindex_trigger: {
    status: HealthStatus;
    enabled: boolean;
    poll_ms: number;
    poll_ms_source: 'default' | 'env' | 'fallback';
    poll_ms_raw: string | null;
    path: string;
    path_source: 'default' | 'env';
    path_raw: string | null;
    kb_fs_watch_enabled: boolean;
    trigger_file: {
      exists: boolean;
      kind: 'file' | 'directory' | 'other' | 'missing';
      mtime: string | null;
      age_ms: number | null;
      size_bytes: number | null;
      stat_error: string | null;
    };
    parent: {
      path: string;
      exists: boolean;
      writable: boolean | null;
      access_error: string | null;
    };
    freshness: {
      index_mtime: string | null;
      trigger_mtime: string | null;
      trigger_newer_than_index: boolean | null;
    };
    warnings: string[];
    limitation: string;
  };
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
  /**
   * Issue #388 — test seam for the local LLM endpoint readiness check.
   * Production callers leave this undefined so the doctor performs a
   * short, read-only probe without starting any services.
   */
  llmEndpointProbe?: LlmEndpointProbe;
}

export type BackendHealthCheck = (
  provider: string,
  modelName: string,
) => Promise<{ healthy: boolean; detail: string }>;
export type LlmEndpointProbe = (endpoint: string) => Promise<LlmProbeResult>;

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
  const out: DoctorArgs = { format: 'md', reindexTrigger: false };
  for (const raw of rest) {
    if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length);
      if (value !== 'md' && value !== 'json') {
        throw new Error(`invalid --format: ${raw}`);
      }
      out.format = value;
      continue;
    }
    if (raw === '--reindex-trigger') {
      out.reindexTrigger = true;
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
  const indexSecurity = await readIndexSecurity(activeModelId, index.binary_path);
  const indexSecurityWarningCount = indexSecurity.entries
    .reduce((sum, entry) => sum + entry.warnings.length, 0);
  checks.push({
    name: 'index_security',
    status: indexSecurityWarningCount > 0 ? 'warn' : 'ok',
    detail: indexSecurityWarningCount === 0
      ? 'FAISS index boundary permissions look safe'
      : `${indexSecurityWarningCount} FAISS index boundary permission warning(s)`,
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

  const quarantineCounts = await computeQuarantineCountsByKb(Object.keys(staleCounts));
  const quarantineTotal = Object.values(quarantineCounts).reduce((sum, count) => sum + count, 0);
  checks.push({
    name: 'INGEST_QUARANTINE_NONZERO',
    status: quarantineTotal === 0 ? 'ok' : 'warn',
    detail: quarantineTotal === 0
      ? 'no quarantined ingest files detected'
      : `${quarantineTotal} quarantined ingest file(s) detected`,
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

  const llmEndpoint = await readLlmEndpointHealth(
    options.llmEndpointProbe ?? defaultLlmEndpointProbe,
  );
  checks.push({
    name: 'llm_endpoint',
    status: llmEndpoint.status,
    detail: llmEndpoint.detail,
  });

  const reranker = await readRerankerHealth();
  checks.push({
    name: 'reranker',
    status: reranker.status,
    detail: reranker.detail,
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
    ?? (await FaissIndexManager.readPersistedIndexUpdateSummary(activeModelId))
    ?? createNeverRunIndexUpdateSummary(activeModelId);
  const reindexTrigger = await readReindexTriggerHealth(index.mtime);
  checks.push({
    name: 'reindex_trigger',
    status: reindexTrigger.status,
    detail: formatReindexTriggerCheckDetail(reindexTrigger),
  });

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
    index_security: indexSecurity,
    stale_counts_by_kb: staleCounts,
    quarantine_counts_by_kb: quarantineCounts,
    age_budgets: ageBudgetResult.byKb,
    age_budget_config_errors: ageBudgetResult.configErrors,
    incomplete_models: incompleteModels,
    backend,
    llm_endpoint: llmEndpoint,
    reranker,
    cli,
    git,
    last_index_update: lastIndexUpdate,
    reindex_trigger: reindexTrigger,
    provider_calls: providerCalls,
  };
}

async function readReindexTriggerHealth(
  indexMtime: string | null,
): Promise<DoctorReport['reindex_trigger']> {
  const poll = resolveReindexTriggerPollMs(process.env.REINDEX_TRIGGER_POLL_MS);
  const triggerPath = resolveReindexTriggerPath(
    process.env.REINDEX_TRIGGER_PATH,
    KNOWLEDGE_BASES_ROOT_DIR,
  );
  const fsState = await inspectReindexTriggerFilesystem(REINDEX_TRIGGER_PATH);
  const warnings = [
    ...triggerPath.warnings,
    ...(poll.warning === null ? [] : [poll.warning]),
    ...fsState.warnings,
  ];

  if (REINDEX_TRIGGER_POLL_MS <= 0) {
    warnings.push('REINDEX_TRIGGER_POLL_MS=0 disables the reindex-trigger watcher');
  }

  const triggerMtimeMs = fsState.mtime === null ? null : Date.parse(fsState.mtime);
  const indexMtimeMs = indexMtime === null ? null : Date.parse(indexMtime);
  const triggerNewerThanIndex = triggerMtimeMs === null || indexMtimeMs === null
    ? null
    : triggerMtimeMs > indexMtimeMs;
  if (triggerNewerThanIndex === true) {
    warnings.push('trigger file is newer than the active index; a refresh may be pending');
  }

  const hasError = fsState.kind === 'directory'
    || fsState.kind === 'other'
    || !fsState.parent_exists
    || fsState.parent_writable === false;
  const status: HealthStatus = hasError ? 'error' : warnings.length > 0 ? 'warn' : 'ok';
  const now = Date.now();
  return {
    status,
    enabled: REINDEX_TRIGGER_POLL_MS > 0,
    poll_ms: REINDEX_TRIGGER_POLL_MS,
    poll_ms_source: poll.source,
    poll_ms_raw: poll.raw_value,
    path: REINDEX_TRIGGER_PATH,
    path_source: triggerPath.source,
    path_raw: triggerPath.raw_value,
    kb_fs_watch_enabled: KB_FS_WATCH,
    trigger_file: {
      exists: fsState.exists,
      kind: fsState.kind,
      mtime: fsState.mtime,
      age_ms: triggerMtimeMs === null ? null : Math.max(0, now - triggerMtimeMs),
      size_bytes: fsState.size_bytes,
      stat_error: fsState.stat_error,
    },
    parent: {
      path: fsState.parent_path,
      exists: fsState.parent_exists,
      writable: fsState.parent_writable,
      access_error: fsState.parent_access_error,
    },
    freshness: {
      index_mtime: indexMtime,
      trigger_mtime: fsState.mtime,
      trigger_newer_than_index: triggerNewerThanIndex,
    },
    warnings,
    limitation: 'configuration and filesystem state only; this CLI cannot prove another MCP server process is actively watching',
  };
}

function formatReindexTriggerCheckDetail(
  report: DoctorReport['reindex_trigger'],
): string {
  if (!report.enabled) {
    return `disabled; path=${report.path}`;
  }
  if (report.warnings.length > 0) {
    return `${report.warnings.length} reindex-trigger warning(s); path=${report.path}`;
  }
  return `enabled every ${report.poll_ms}ms; path=${report.path}`;
}

function formatErrorRate(errors: number, count: number): string {
  if (count === 0) return '0%';
  const pct = (errors / count) * 100;
  return `${pct.toFixed(1)}%`;
}

async function readIndexHealth(activeModelId: string | null): Promise<DoctorReport['index']> {
  const emptyStorage: DoctorReport['index']['storage'] = {
    active_version_bytes: null,
    inactive_version_count: 0,
    inactive_version_bytes: 0,
    total_version_bytes: 0,
    retention_previous_versions: 0,
  };
  if (activeModelId === null) {
    return { path: FAISS_INDEX_PATH, binary_path: null, version: null, mtime: null, storage: emptyStorage };
  }
  const storage = await readModelIndexStorage(activeModelId);
  const storageSummary: DoctorReport['index']['storage'] = {
    active_version_bytes: storage.active_version_bytes,
    inactive_version_count: storage.inactive_version_count,
    inactive_version_bytes: storage.inactive_version_bytes,
    total_version_bytes: storage.total_version_bytes,
    retention_previous_versions: storage.retention_previous_versions,
  };
  const binaryPath = await resolveFaissIndexBinaryPath(activeModelId);
  if (binaryPath === null) {
    return { path: FAISS_INDEX_PATH, binary_path: null, version: null, mtime: null, storage: storageSummary };
  }
  try {
    const st = await fsp.stat(binaryPath);
    return {
      path: FAISS_INDEX_PATH,
      binary_path: binaryPath,
      version: indexVersionFromPath(binaryPath),
      mtime: new Date(st.mtimeMs).toISOString(),
      storage: storageSummary,
    };
  } catch {
    return { path: FAISS_INDEX_PATH, binary_path: null, version: null, mtime: null, storage: storageSummary };
  }
}

async function readIndexSecurity(
  activeModelId: string | null,
  binaryPath: string | null,
): Promise<DoctorReport['index_security']> {
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const canCheckPosixMode = process.platform !== 'win32';
  const candidates: Array<Pick<DoctorIndexSecurityEntry, 'name' | 'path'>> = [
    { name: 'faiss_root', path: FAISS_INDEX_PATH },
    { name: 'active_file', path: path.join(FAISS_INDEX_PATH, 'active.txt') },
  ];
  if (activeModelId !== null) {
    const activeModelDir = path.join(FAISS_INDEX_PATH, 'models', activeModelId);
    candidates.push({ name: 'active_model_dir', path: activeModelDir });
  }
  if (binaryPath !== null) {
    candidates.push({ name: 'active_index_version_dir', path: path.dirname(binaryPath) });
  }

  const entries: DoctorIndexSecurityEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(`${candidate.name}:${candidate.path}`)) continue;
    seen.add(`${candidate.name}:${candidate.path}`);
    entries.push(await statIndexSecurityEntry(candidate, expectedUid, canCheckPosixMode));
  }
  return {
    permission_check: canCheckPosixMode ? 'checked' : 'skipped',
    ownership_check: expectedUid === null ? 'skipped' : 'checked',
    entries,
  };
}

async function statIndexSecurityEntry(
  candidate: Pick<DoctorIndexSecurityEntry, 'name' | 'path'>,
  expectedUid: number | null,
  canCheckPosixMode: boolean,
): Promise<DoctorIndexSecurityEntry> {
  let st: import('fs').Stats;
  try {
    st = await fsp.stat(candidate.path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return {
        ...candidate,
        exists: false,
        kind: 'missing',
        mode_octal: null,
        uid: null,
        expected_uid: expectedUid,
        permission_status: 'skipped',
        ownership_status: expectedUid === null ? 'skipped' : 'ok',
        warnings: [],
      };
    }
    return {
      ...candidate,
      exists: false,
      kind: 'missing',
      mode_octal: null,
      uid: null,
      expected_uid: expectedUid,
      permission_status: 'skipped',
      ownership_status: expectedUid === null ? 'skipped' : 'ok',
      warnings: [`stat_failed: ${(err as Error).message}`],
    };
  }

  const kind = st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other';
  const mode = st.mode & 0o777;
  const modeDisplay = formatMode(mode);
  const permissionWarning = canCheckPosixMode && (mode & 0o022) !== 0;
  const warnings: string[] = [];
  if (canCheckPosixMode && (mode & 0o020) !== 0) warnings.push(`group_writable: mode ${modeDisplay}`);
  if (canCheckPosixMode && (mode & 0o002) !== 0) warnings.push(`world_writable: mode ${modeDisplay}`);
  if (expectedUid !== null && st.uid !== expectedUid) {
    warnings.push(`unexpected_owner: uid ${st.uid}, expected ${expectedUid}`);
  }
  return {
    ...candidate,
    exists: true,
    kind,
    mode_octal: modeDisplay,
    uid: typeof st.uid === 'number' ? st.uid : null,
    expected_uid: expectedUid,
    permission_status: canCheckPosixMode ? (permissionWarning ? 'warn' : 'ok') : 'skipped',
    ownership_status: expectedUid === null ? 'skipped' : (st.uid === expectedUid ? 'ok' : 'warn'),
    warnings,
  };
}

function formatMode(mode: number): string {
  return `0${mode.toString(8).padStart(3, '0')}`;
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

async function computeQuarantineCountsByKb(
  kbNames: string[],
): Promise<DoctorReport['quarantine_counts_by_kb']> {
  const out: DoctorReport['quarantine_counts_by_kb'] = {};
  for (const kbName of kbNames) {
    try {
      out[kbName] = await countIngestQuarantine(
        path.join(KNOWLEDGE_BASES_ROOT_DIR, kbName),
      );
    } catch {
      out[kbName] = 0;
    }
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

async function readRerankerHealth(): Promise<DoctorReport['reranker']> {
  let config;
  try {
    config = resolveRerankerConfig();
  } catch (err) {
    return {
      enabled: false,
      model: '<invalid>',
      top_n: 0,
      status: 'error',
      cache_path: null,
      detail: (err as Error).message,
    };
  }

  if (!config.enabled) {
    return {
      enabled: false,
      model: config.model,
      top_n: config.topN,
      status: 'ok',
      cache_path: null,
      detail: 'KB_RERANK is off',
    };
  }

  const cachePath = await findHuggingFaceModelCachePath(config.model);
  return {
    enabled: true,
    model: config.model,
    top_n: config.topN,
    status: cachePath === null ? 'warn' : 'ok',
    cache_path: cachePath,
    detail: cachePath === null
      ? 'reranker model cache not found; first enabled call may download the model or degrade offline'
      : 'reranker model cache found',
  };
}

async function findHuggingFaceModelCachePath(model: string): Promise<string | null> {
  const hfHome = process.env.HF_HOME || process.env.TRANSFORMERS_CACHE ||
    (process.env.HOME ? path.join(process.env.HOME, '.cache', 'huggingface') : null);
  if (hfHome === null) return null;
  const modelDirName = `models--${model.replace(/\//g, '--')}`;
  const candidates = [
    path.join(hfHome, 'hub', modelDirName),
    path.join(hfHome, modelDirName),
  ];
  for (const candidate of candidates) {
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // best-effort cache probe
    }
  }
  return null;
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

async function readLlmEndpointHealth(
  check: LlmEndpointProbe,
): Promise<DoctorReport['llm_endpoint']> {
  let target: { profile: LlmProfile; source: DoctorReport['llm_endpoint']['endpoint_source'] };
  try {
    target = await resolveDoctorLlmTarget();
  } catch (err) {
    return {
      status: 'warn',
      endpoint: null,
      health_url: null,
      endpoint_source: 'unresolved',
      profile_name: null,
      profile_mode: null,
      managed_by: null,
      unit_name: null,
      health_ok: false,
      chat_ok: false,
      detail: `LLM profile resolution failed: ${(err as Error).message}`,
      next_action: 'Run kb llm status --format=json, then fix or remove the active LLM profile.',
    };
  }

  const { profile, source } = target;
  try {
    const probe = await check(profile.endpoint);
    const status: HealthStatus = probe.health_ok && probe.chat_ok ? 'ok' : 'warn';
    return {
      status,
      endpoint: probe.endpoint,
      health_url: probe.health_url,
      endpoint_source: source,
      profile_name: profile.name,
      profile_mode: profile.mode,
      managed_by: profile.mode === 'external' ? profile.managed_by ?? null : null,
      unit_name: profile.mode === 'managed' ? profile.unit_name : null,
      health_ok: probe.health_ok,
      chat_ok: probe.chat_ok,
      detail: formatLlmEndpointDetail(profile, source, probe),
      next_action: status === 'ok' ? null : llmEndpointNextAction(profile, probe),
    };
  } catch (err) {
    const endpoint = profile.endpoint;
    return {
      status: 'warn',
      endpoint,
      health_url: safeDeriveHealthUrl(endpoint),
      endpoint_source: source,
      profile_name: profile.name,
      profile_mode: profile.mode,
      managed_by: profile.mode === 'external' ? profile.managed_by ?? null : null,
      unit_name: profile.mode === 'managed' ? profile.unit_name : null,
      health_ok: false,
      chat_ok: false,
      detail: `LLM endpoint probe failed: ${(err as Error).message}`,
      next_action: `Run kb llm probe --endpoint=${endpoint} after starting or fixing the local LLM service.`,
    };
  }
}

async function resolveDoctorLlmTarget(): Promise<{
  profile: LlmProfile;
  source: DoctorReport['llm_endpoint']['endpoint_source'];
}> {
  if (process.env.KB_LLM_ENDPOINT?.trim()) {
    return {
      profile: await createExternalProfile('env', process.env.KB_LLM_ENDPOINT),
      source: 'env',
    };
  }
  const configured = await resolveProfile();
  if (configured) return { profile: configured, source: 'profile' };
  return {
    profile: await createExternalProfile(
      'local-research-agent',
      DEFAULT_LLM_ENDPOINT,
      'local-research-agent',
    ),
    source: 'default',
  };
}

async function defaultLlmEndpointProbe(endpoint: string): Promise<LlmProbeResult> {
  return probeLlmEndpoint(endpoint, fetch, {
    healthTimeoutMs: DOCTOR_LLM_HEALTH_TIMEOUT_MS,
    chatTimeoutMs: DOCTOR_LLM_CHAT_TIMEOUT_MS,
  });
}

function formatLlmEndpointDetail(
  profile: LlmProfile,
  source: DoctorReport['llm_endpoint']['endpoint_source'],
  probe: LlmProbeResult,
): string {
  const owner = profile.mode === 'managed'
    ? `managed ${profile.unit_name}`
    : `external${profile.managed_by ? ` (${profile.managed_by})` : ''}`;
  const readiness = probe.chat_ok
    ? (probe.health_ok ? 'ready' : 'chat ready, health endpoint unhealthy')
    : 'not ready';
  return `${readiness}; profile=${profile.name}; source=${source}; owner=${owner}; ${probe.detail}`;
}

function llmEndpointNextAction(profile: LlmProfile, probe: LlmProbeResult): string {
  if (profile.mode === 'managed') {
    return `Run kb llm start --profile=${profile.name}, then kb llm probe --endpoint=${probe.endpoint}.`;
  }
  if (profile.mode === 'external' && profile.managed_by) {
    return `Start or fix ${profile.managed_by}, then run kb llm probe --endpoint=${probe.endpoint}.`;
  }
  return `Start or fix the external LLM service, then run kb llm probe --endpoint=${probe.endpoint}.`;
}

function safeDeriveHealthUrl(endpoint: string): string | null {
  try {
    return deriveHealthUrl(endpoint);
  } catch {
    return null;
  }
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
  lines.push(
    `Index storage: ${formatBytes(report.index.storage.total_version_bytes)} total ` +
      `(${formatBytes(report.index.storage.active_version_bytes)} active, ` +
      `${formatBytes(report.index.storage.inactive_version_bytes)} inactive across ` +
      `${report.index.storage.inactive_version_count} retained inactive version(s); ` +
      `retention=${report.index.storage.retention_previous_versions})`,
  );
  lines.push('FAISS index security:');
  for (const entry of report.index_security.entries) {
    const mode = entry.mode_octal === null ? 'mode=n/a' : `mode=${entry.mode_octal}`;
    const uid = entry.uid === null ? 'uid=n/a' : `uid=${entry.uid}`;
    const marker = entry.warnings.length === 0 ? 'ok' : `WARN ${entry.warnings.join('; ')}`;
    lines.push(`  ${entry.name}: ${entry.path} (${mode}, ${uid}) ${marker}`);
  }
  if (report.index_security.permission_check === 'skipped') {
    lines.push('  permissions: skipped on this platform');
  }
  if (report.index_security.ownership_check === 'skipped') {
    lines.push('  ownership: skipped on this platform');
  }
  lines.push(`Last index update: ${formatLastIndexUpdate(report.last_index_update)}`);
  lines.push('Reindex trigger:');
  lines.push(
    `  path: ${report.reindex_trigger.path} (${report.reindex_trigger.path_source})`,
  );
  lines.push(
    `  poll: ${report.reindex_trigger.enabled ? `${report.reindex_trigger.poll_ms}ms` : 'disabled'} ` +
    `(${report.reindex_trigger.poll_ms_source})`,
  );
  const triggerFile = report.reindex_trigger.trigger_file;
  const triggerMtime = triggerFile.mtime ?? 'none';
  const triggerAge = triggerFile.age_ms === null ? 'n/a' : `${Math.round(triggerFile.age_ms / 1000)}s`;
  lines.push(
    `  trigger file: ${triggerFile.exists ? triggerFile.kind : 'missing'}, ` +
    `mtime=${triggerMtime}, age=${triggerAge}`,
  );
  lines.push(
    `  parent: ${report.reindex_trigger.parent.path} ` +
    `(exists=${report.reindex_trigger.parent.exists ? 'yes' : 'no'}, ` +
    `writable=${formatNullableBoolean(report.reindex_trigger.parent.writable)})`,
  );
  lines.push(`  freshness: ${formatReindexTriggerFreshness(report.reindex_trigger)}`);
  lines.push(
    `  KB_FS_WATCH: ${report.reindex_trigger.kb_fs_watch_enabled ? 'on' : 'off'} ` +
    '(independent per-file watcher)',
  );
  if (report.reindex_trigger.warnings.length === 0) {
    lines.push('  warnings: (none)');
  } else {
    for (const warning of report.reindex_trigger.warnings) {
      lines.push(`  WARN ${warning}`);
    }
  }
  lines.push(`  note: ${report.reindex_trigger.limitation}`);
  lines.push(`Backend: ${report.backend.healthy ? 'ok' : 'error'} — ${report.backend.detail}`);
  lines.push('LLM endpoint:');
  lines.push(`  status: ${report.llm_endpoint.status}`);
  lines.push(`  source: ${report.llm_endpoint.endpoint_source}`);
  lines.push(`  profile: ${report.llm_endpoint.profile_name ?? '<unresolved>'} (${report.llm_endpoint.profile_mode ?? 'n/a'})`);
  if (report.llm_endpoint.unit_name !== null) {
    lines.push(`  unit: ${report.llm_endpoint.unit_name}`);
  }
  if (report.llm_endpoint.managed_by !== null) {
    lines.push(`  managed_by: ${report.llm_endpoint.managed_by}`);
  }
  lines.push(`  endpoint: ${report.llm_endpoint.endpoint ?? '<unresolved>'}`);
  lines.push(`  health_url: ${report.llm_endpoint.health_url ?? '<unresolved>'}`);
  lines.push(`  health_ok: ${report.llm_endpoint.health_ok ? 'yes' : 'no'}`);
  lines.push(`  chat_ok: ${report.llm_endpoint.chat_ok ? 'yes' : 'no'}`);
  lines.push(`  detail: ${report.llm_endpoint.detail}`);
  if (report.llm_endpoint.next_action !== null) {
    lines.push(`  next_action: ${report.llm_endpoint.next_action}`);
  }
  lines.push('Reranker:');
  lines.push(`  enabled: ${report.reranker.enabled ? 'yes' : 'no'}`);
  lines.push(`  model: ${report.reranker.model}`);
  lines.push(`  top_n: ${report.reranker.top_n}`);
  lines.push(`  status: ${report.reranker.status}`);
  lines.push(`  cache_path: ${report.reranker.cache_path ?? '<not found>'}`);
  lines.push(`  detail: ${report.reranker.detail}`);
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
  lines.push('Ingest quarantine by KB:');
  const quarantineNames = Object.keys(report.quarantine_counts_by_kb).sort();
  if (quarantineNames.length === 0) {
    lines.push('  (no knowledge bases found)');
  } else {
    for (const name of quarantineNames) {
      lines.push(`  ${name}: ${report.quarantine_counts_by_kb[name]} quarantined`);
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

function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'n/a';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${bytes} B`;
  return `${value.toFixed(1)} ${units[unit]}`;
}

function formatNullableBoolean(value: boolean | null): string {
  if (value === null) return 'unknown';
  return value ? 'yes' : 'no';
}

function formatReindexTriggerFreshness(
  report: DoctorReport['reindex_trigger'],
): string {
  const indexMtime = report.freshness.index_mtime ?? 'none';
  const triggerMtime = report.freshness.trigger_mtime ?? 'none';
  if (report.freshness.trigger_newer_than_index === null) {
    return `unknown (trigger=${triggerMtime}, index=${indexMtime})`;
  }
  if (report.freshness.trigger_newer_than_index) {
    return `trigger newer than active index (trigger=${triggerMtime}, index=${indexMtime})`;
  }
  return `trigger not newer than active index (trigger=${triggerMtime}, index=${indexMtime})`;
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
