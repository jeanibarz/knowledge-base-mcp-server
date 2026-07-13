// `kb doctor` — aggregate read-only health report for local KB operations
// (issue #180). The command intentionally composes existing filesystem and
// model-resolution surfaces instead of loading the FAISS store or embedding
// documents.

import * as fsp from 'fs/promises';
import { realpathSync } from 'fs';
import * as net from 'net';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  ActiveModelResolutionError,
  listIncompleteModelStates,
  listRegisteredModels,
  modelsRoot,
  parseModelId,
  readModelIndexStorage,
  readStoredIndexType,
  resolveActiveModel,
  modelDir,
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
import {
  aggregateEnumerationDiagnostics,
  enumerateIngestableKbFiles,
  inventoryKbSymlinks,
  listKnowledgeBases,
  type KbFilesystemEnumerationDiagnostics,
  type KbSymlinkInventory,
} from './kb-fs.js';
import {
  createNeverRunIndexUpdateSummary,
  FaissIndexManager,
  type IndexUpdateSummary,
} from './FaissIndexManager.js';
import { createEmbeddingsClient } from './embedding-provider.js';
import type { EmbeddingProvider } from './model-id.js';
import {
  AgeBudgetConfigError,
  computeAgeBudgetStatus,
  formatAgeBudgetBreachRow,
  formatAgeHours,
  type AgeBudgetStatus,
} from './age-budget.js';
import {
  indexFactoryForType,
  maxMtimeIso,
  summarizeDenseSearchLatency,
  type KbStatsDenseSearchLatencySummary,
  type KbStatsPayload,
} from './kb-stats.js';
import { defaultAnswerCache, type AnswerCache, type AnswerCacheStats } from './ask-answer-cache.js';
import {
  llmCallMetrics,
  providerCallMetrics,
  quantileFromBuckets,
  searchLatencyMetrics,
  type LlmCallMetrics,
  type LlmCallMetricsSnapshot,
  type ProviderCallMetrics,
  type ProviderCallSnapshot,
  type SearchLatencyMetrics,
} from './metrics.js';
import {
  parseProviderCircuitKey,
  providerBreakerRegistry,
  type ProviderBreakerRegistry,
  type ProviderCircuitSnapshot,
} from './provider-breaker.js';
import { countIngestQuarantine } from './ingest-quarantine.js';
import {
  inventoryExtractionCache,
  type ExtractionCacheInventory,
} from './extraction-cache.js';
import { inspectReindexTriggerFilesystem } from './triggerWatcher.js';
import {
  deriveHealthUrl,
  probeLlmEndpoint,
  type LlmProbeOptions,
  type LlmProbeResult,
} from './llm-client.js';
import {
  createExternalProfile,
  readActiveProfileName,
  readProfile,
  resolveProfile,
  type LlmProfile,
} from './llm-profiles.js';
import { resolveRelevanceGateConfig } from './config/relevance-gate.js';
import { isFakeLlmEnabled } from './llm-fake-stub.js';
import { resolveRerankerConfig } from './config/reranker.js';
import {
  backendForIndexType,
  resolveFlatSearchP95AdvisoryMs,
  type SearchIndexType,
} from './config/indexing.js';
import { tryReadDaemonStatsPayload } from './cli-stats.js';
import {
  daemonUrlFromEnv,
  fetchDaemonHealth,
} from './daemon-client.js';
import {
  DEFAULT_MCP_BIND_ADDR,
  DEFAULT_MCP_PORT,
} from './transport-config.js';
import {
  validateConfigEnv,
  type ConfigValidateReport,
} from './config/schema.js';
import {
  formatIntegrityMarkdown,
  integrityExitCode,
  verifyIntegrity,
  type IntegrityReport,
} from './cli-verify.js';
import {
  EMBEDDING_CANARY_COSINE_WARN_THRESHOLD,
  EMBEDDING_CANARY_ID,
  createEmbeddingCanaryFingerprint,
  cosineSimilarity,
  readIndexIntegrityManifest,
  resolveActiveIndexFilePath,
} from './faiss-store-layout.js';
import { createDoctorBugReportBundle } from './cli-bug-report.js';
import {
  WRITE_LOCK_OWNER_SCHEMA_VERSION,
  WRITE_LOCK_STALE_MS,
  writeLockOwnerPathFor,
  writeLockPathFor,
  type WriteLockOwnerMetadata,
} from './write-lock.js';

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
  kb doctor [--format=md|json] [--reindex-trigger] [--endpoints] [--locks] [--kb-symlinks] [--integrity|--slow]
  kb doctor --bug-report[=<dir>] [--include-command -- <cmd> [args...]]

Composes existing read-only checks (env vars, registered models, active
model, FAISS index presence + mtime, knowledge-base count, embedding
backend readiness, and local LLM endpoint readiness for kb ask) into
a single status report. Does NOT load the FAISS store, embed KB documents,
or start managed LLM services; backend checks may perform a tiny
model-specific smoke embedding.

Report status is one of \`ok\`, \`warn\`, or \`error\`. The exit code is non-zero
when any required check fails, so \`kb doctor && kb search ...\` is a safe
gate from a script.

Options:
  --format=md|json      Output format (default: md). \`json\` emits the same
                        underlying report shape for agent shells.
  --reindex-trigger     Include focused reindex-trigger diagnostics
                        (also included in the aggregate report).
  --endpoints           Check only configured local bind/connect endpoint
                        readiness (MCP bind target, KB_DAEMON_URL,
                        Ollama embedding endpoint, KB_LLM_ENDPOINT/profile, and
                        the enabled relevance-gate KB_GATE_LLM_ENDPOINT).
  --locks               Check only FAISS/model write-lock paths, including
                        owner metadata when available and stale-lock guidance.
  --kb-symlinks         Inventory symlinks under KB roots without following
                        symlink directories; classifies inside-root, escaping,
                        broken, and loop/error targets.
  --bug-report[=<dir>]  Write a timestamped redacted support bundle under
                        <dir> (default: current directory). Includes doctor,
                        stats, recent canonical logs, runtime metadata, and
                        a README. Does not include note contents or raw keys.
  --include-command -- <cmd> [args...]
                        With --bug-report, run a support command and record
                        exit code plus redacted stderr tail.
  --integrity           Include slow \`kb verify --integrity\` checks.
  --slow                Alias for --integrity.
  --help, -h            Show this help.

Examples:
  kb doctor
  kb doctor --format=json
  kb doctor && kb search "rollback"
  kb doctor --kb-symlinks
`;

export interface DoctorArgs {
  format: 'md' | 'json';
  reindexTrigger: boolean;
  endpoints: boolean;
  locks: boolean;
  kbSymlinks: boolean;
  integrity: boolean;
  bugReport: {
    outputParentDir?: string;
    includeCommand: boolean;
    command?: string[];
  } | null;
}

export type HealthStatus = 'ok' | 'warn' | 'error';
export type EndpointHealthStatus = HealthStatus | 'skipped';
export type EmbeddingCanaryHealthStatus = HealthStatus | 'not_recorded' | 'skipped';
type DoctorDaemonStatsPayload = Pick<KbStatsPayload, 'dense_search_latency'>;

export interface EndpointReadinessEntry {
  name: 'mcp_bind' | 'kb_daemon' | 'embedding_ollama' | 'llm_endpoint' | 'gate_llm_endpoint';
  kind: 'bind' | 'http';
  status: EndpointHealthStatus;
  configured: boolean;
  target: string | null;
  source: 'env' | 'profile' | 'default' | 'not_configured' | 'invalid';
  detail: string;
}

export interface EndpointReadinessReport {
  schema_version: 'kb.doctor.endpoints.v1';
  status: HealthStatus;
  endpoints: EndpointReadinessEntry[];
}

export interface DoctorLockOwner {
  pid: number | null;
  live: boolean | null;
  command: string | null;
  cwd: string | null;
  hostname: string | null;
  started_at: string | null;
  source: 'metadata' | 'none' | 'invalid';
  detail: string | null;
}

export interface DoctorLockEntry {
  kind: 'model_write';
  model_id: string;
  model_name: string | null;
  resource_path: string;
  lock_path: string;
  owner_path: string;
  present: boolean;
  lock_kind: 'directory' | 'file' | 'other' | 'missing' | 'unknown';
  mtime: string | null;
  age_ms: number | null;
  stale_threshold_ms: number;
  stale_suspected: boolean;
  owner: DoctorLockOwner;
  status: 'ok' | 'held' | 'stale' | 'unknown';
  next_action: string;
  warnings: string[];
}

export interface DoctorLocksReport {
  schema_version: 'kb.doctor.locks.v1';
  status: HealthStatus;
  faiss_index_path: string;
  models_root: string;
  generated_at: string;
  stale_threshold_ms: number;
  locks: DoctorLockEntry[];
  summary: {
    total: number;
    held: number;
    stale_suspected: number;
    unknown: number;
  };
}

export interface DoctorKbSymlinksReport {
  schema_version: 'kb.doctor.kb_symlinks.v1';
  status: HealthStatus;
  inventory: KbSymlinkInventory;
}

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

export interface DoctorEmbeddingCanaryReport {
  status: EmbeddingCanaryHealthStatus;
  canary_id: string | null;
  recorded_at: string | null;
  dimensions: number | null;
  similarity: number | null;
  threshold: number;
  detail: string;
  next_action: string | null;
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
    type: SearchIndexType | null;
    factory: string | null;
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
  embedding_canary: DoctorEmbeddingCanaryReport;
  extraction_cache: {
    cache_dir: string;
    exists: boolean;
    entry_count: number;
    total_bytes: number;
    oldest_mtime: string | null;
    newest_mtime: string | null;
    ignored_entry_count: number;
    error_count: number;
    errors: ExtractionCacheInventory['errors'];
  };
  stale_counts_by_kb: Record<string, { modified_files: number; new_files: number }>;
  filesystem: {
    enumeration_failures: KbFilesystemEnumerationDiagnostics;
  };
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
  gate_llm_endpoint: EndpointReadinessEntry;
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
  /** Issue #831 — bounded chat-completion telemetry by ask/gate/preface operation. */
  llm_calls?: LlmCallMetricsSnapshot;
  /** Issue #859 — answer-cache counters and workflow-boundary outcomes. */
  answer_cache?: AnswerCacheStats;
  /**
   * Issue #747 — per-key snapshot of the shared provider circuit breaker
   * (embedding + LLM paths). Empty `[]` until a breaker has admitted a
   * call in this process; breakers are process-local, so a one-shot
   * `kb doctor` typically sees an empty list. The `provider_circuit` check
   * is WARN when any breaker is open or half-open, OK when all tracked
   * breakers are closed, and omitted entirely when the list is empty.
   */
  provider_circuits: ProviderCircuitSnapshot[];
  dense_search_latency: KbStatsDenseSearchLatencySummary | null;
  /** Non-null only when kb doctor is invoked with --integrity or --slow. */
  integrity: IntegrityReport | null;
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
  /** Issue #831 — test seam for chat-completion telemetry. */
  llmCallMetrics?: LlmCallMetrics;
  /** Issue #859 — test seam for answer-cache telemetry. */
  answerCache?: AnswerCache;
  /** Issue #747 — test seam for the shared provider circuit breaker registry. */
  providerBreaker?: ProviderBreakerRegistry;
  /** Issue #604 — test seam for daemon-served search latency telemetry. */
  searchMetrics?: SearchLatencyMetrics;
  /** Issue #604 — test seam for daemon stats telemetry captured out of process. */
  daemonStatsPayload?: () => Promise<DoctorDaemonStatsPayload | null>;
  /**
   * Issue #388 — test seam for the local LLM endpoint readiness check.
   * Production callers leave this undefined so the doctor performs a
   * short, read-only probe without starting any services.
   */
  llmEndpointProbe?: LlmEndpointProbe;
  /** Run the slow `kb verify --integrity` audit and fold it into status. */
  integrity?: boolean;
  /** Test seam for the embedding canary drift check. */
  embeddingCanaryCheck?: (
    modelId: string | null,
    provider: string | null,
    modelName: string | null,
    binaryPath: string | null,
  ) => Promise<DoctorEmbeddingCanaryReport>;
}

export interface BuildEndpointReadinessReportOptions {
  fetchImpl?: typeof fetch;
  llmEndpointProbe?: LlmEndpointProbe;
}

export type BackendHealthCheck = (
  provider: string,
  modelName: string,
) => Promise<{ healthy: boolean; detail: string }>;
export type LlmEndpointProbe = (
  endpoint: string,
  probeOptions?: LlmProbeOptions,
) => Promise<LlmProbeResult>;

export async function runDoctor(rest: string[]): Promise<number> {
  let parsed: DoctorArgs;
  try {
    parsed = parseDoctorArgs(rest);
  } catch (err) {
    process.stderr.write(`kb doctor: ${(err as Error).message}\n`);
    return 2;
  }

  if (parsed.endpoints) {
    const report = await buildEndpointReadinessReport();
    if (parsed.format === 'json') {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(formatEndpointReadinessMarkdown(report));
    }
    return report.status === 'error' ? 1 : 0;
  }

  if (parsed.locks) {
    const report = await buildDoctorLocksReport();
    if (parsed.format === 'json') {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(formatDoctorLocksMarkdown(report));
    }
    return report.status === 'error' ? 1 : 0;
  }

  if (parsed.kbSymlinks) {
    const report = await buildDoctorKbSymlinksReport();
    if (parsed.format === 'json') {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(formatDoctorKbSymlinksMarkdown(report));
    }
    return report.status === 'error' ? 1 : 0;
  }

  if (parsed.bugReport !== null) {
    const result = await createDoctorBugReportBundle({
      outputParentDir: parsed.bugReport.outputParentDir,
      command: parsed.bugReport.command,
      buildDoctorReport: () => buildDoctorReport({ integrity: parsed.integrity }),
    });
    if (parsed.format === 'json') {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Bug report bundle: ${result.bundle_dir}\n`);
    }
    return 0;
  }

  const report = await buildDoctorReport({ integrity: parsed.integrity });
  if (parsed.format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatDoctorMarkdown(report));
  }
  return report.status === 'error' ? 1 : 0;
}

export function parseDoctorArgs(rest: string[]): DoctorArgs {
  const out: DoctorArgs = {
    format: 'md',
    reindexTrigger: false,
    endpoints: false,
    locks: false,
    kbSymlinks: false,
    integrity: false,
    bugReport: null,
  };
  let sawBugReport = false;
  for (let i = 0; i < rest.length; i++) {
    const raw = rest[i];
    if (raw === '--') {
      if (out.bugReport?.includeCommand !== true) {
        throw new Error('unexpected "--"; use --include-command before command arguments');
      }
      const command = rest.slice(i + 1);
      if (command.length === 0) throw new Error('missing command after "--"');
      out.bugReport.command = command;
      break;
    }
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
    if (raw === '--endpoints') {
      out.endpoints = true;
      continue;
    }
    if (raw === '--locks') {
      out.locks = true;
      continue;
    }
    if (raw === '--kb-symlinks') {
      out.kbSymlinks = true;
      continue;
    }
    if (raw === '--bug-report' || raw.startsWith('--bug-report=')) {
      sawBugReport = true;
      const outputParentDir = raw.includes('=')
        ? raw.slice('--bug-report='.length)
        : undefined;
      if (outputParentDir === '') throw new Error('empty --bug-report value');
      out.bugReport = {
        outputParentDir,
        includeCommand: out.bugReport?.includeCommand ?? false,
        command: out.bugReport?.command,
      };
      continue;
    }
    if (raw === '--include-command') {
      out.bugReport = {
        outputParentDir: out.bugReport?.outputParentDir,
        includeCommand: true,
        command: out.bugReport?.command,
      };
      continue;
    }
    if (raw === '--integrity' || raw === '--slow') {
      out.integrity = true;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
  }
  if (out.bugReport?.includeCommand === true && out.bugReport.command === undefined) {
    throw new Error('--include-command requires "--" followed by a command');
  }
  if (out.bugReport?.includeCommand === true && !sawBugReport) {
    throw new Error('--include-command requires --bug-report');
  }
  if (out.bugReport !== null && out.endpoints) {
    throw new Error('--bug-report cannot be combined with --endpoints');
  }
  if (out.bugReport !== null && out.locks) {
    throw new Error('--bug-report cannot be combined with --locks');
  }
  if (out.bugReport !== null && out.kbSymlinks) {
    throw new Error('--bug-report cannot be combined with --kb-symlinks');
  }
  const focused = [
    out.endpoints ? '--endpoints' : null,
    out.locks ? '--locks' : null,
    out.kbSymlinks ? '--kb-symlinks' : null,
  ].filter((flag): flag is string => flag !== null);
  if (focused.length > 1) {
    throw new Error(`${focused.join(' and ')} cannot be combined`);
  }
  return out;
}

export async function buildEndpointReadinessReport(
  options: BuildEndpointReadinessReportOptions = {},
): Promise<EndpointReadinessReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const llmEndpointProbe: LlmEndpointProbe = (options.llmEndpointProbe
    ?? ((endpoint, probeOptions) => probeLlmEndpoint(endpoint, fetchImpl, {
      healthTimeoutMs: DOCTOR_LLM_HEALTH_TIMEOUT_MS,
      chatTimeoutMs: DOCTOR_LLM_CHAT_TIMEOUT_MS,
      ...probeOptions,
    })));
  const entries: EndpointReadinessEntry[] = [];
  entries.push(await readMcpBindEndpointHealth());
  entries.push(await readKbDaemonEndpointHealth(fetchImpl));
  entries.push(await readOllamaEndpointHealth(fetchImpl));
  entries.push(await readConfiguredLlmEndpointHealth(llmEndpointProbe));
  entries.push(await readConfiguredGateLlmEndpointHealth(llmEndpointProbe));
  return {
    schema_version: 'kb.doctor.endpoints.v1',
    status: summarizeEndpointStatus(entries),
    endpoints: entries,
  };
}

async function readMcpBindEndpointHealth(): Promise<EndpointReadinessEntry> {
  const transport = process.env.MCP_TRANSPORT?.trim() ?? '';
  if (
    transport.length > 0 &&
    transport !== 'stdio' &&
    transport !== 'http' &&
    transport !== 'sse'
  ) {
    const bindAddr = process.env.MCP_BIND_ADDR?.trim() || DEFAULT_MCP_BIND_ADDR;
    const port = process.env.MCP_PORT?.trim() || String(DEFAULT_MCP_PORT);
    return {
      name: 'mcp_bind',
      kind: 'bind',
      status: 'error',
      configured: true,
      target: `${bindAddr}:${port}`,
      source: 'invalid',
      detail: `invalid MCP_TRANSPORT=${JSON.stringify(transport)}; expected one of stdio|sse|http`,
    };
  }
  const explicitlyConfigured = Boolean(
    transport === 'http' ||
    transport === 'sse' ||
    process.env.MCP_PORT?.trim() ||
    process.env.MCP_BIND_ADDR?.trim(),
  );
  const bindAddr = process.env.MCP_BIND_ADDR?.trim() || DEFAULT_MCP_BIND_ADDR;
  let port: number;
  try {
    port = parseEndpointPort(process.env.MCP_PORT, 'MCP_PORT', DEFAULT_MCP_PORT);
  } catch (err) {
    return {
      name: 'mcp_bind',
      kind: 'bind',
      status: 'error',
      configured: true,
      target: `${bindAddr}:${process.env.MCP_PORT ?? ''}`,
      source: 'invalid',
      detail: (err as Error).message,
    };
  }
  const target = `${bindAddr}:${port}`;
  if (!explicitlyConfigured) {
    return {
      name: 'mcp_bind',
      kind: 'bind',
      status: 'skipped',
      configured: false,
      target,
      source: 'not_configured',
      detail: 'MCP_TRANSPORT is stdio and no MCP_PORT/MCP_BIND_ADDR override is configured',
    };
  }

  try {
    await probeTcpBind(bindAddr, port);
    return {
      name: 'mcp_bind',
      kind: 'bind',
      status: 'ok',
      configured: true,
      target,
      source: process.env.MCP_PORT?.trim() || process.env.MCP_BIND_ADDR?.trim() ? 'env' : 'default',
      detail: 'bind target is available',
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const suffix = code ? `${code}: ${(err as Error).message}` : (err as Error).message;
    return {
      name: 'mcp_bind',
      kind: 'bind',
      status: 'error',
      configured: true,
      target,
      source: process.env.MCP_PORT?.trim() || process.env.MCP_BIND_ADDR?.trim() ? 'env' : 'default',
      detail: `bind target is not available: ${suffix}`,
    };
  }
}

async function readKbDaemonEndpointHealth(fetchImpl: typeof fetch): Promise<EndpointReadinessEntry> {
  if (process.env.KB_DAEMON_URL === undefined || process.env.KB_DAEMON_URL.trim() === '') {
    return {
      name: 'kb_daemon',
      kind: 'http',
      status: 'skipped',
      configured: false,
      target: null,
      source: 'not_configured',
      detail: 'KB_DAEMON_URL is not configured',
    };
  }
  let target: string;
  try {
    target = new URL('/health', daemonUrlFromEnv(process.env)).href;
  } catch (err) {
    return {
      name: 'kb_daemon',
      kind: 'http',
      status: 'error',
      configured: true,
      target: process.env.KB_DAEMON_URL,
      source: 'invalid',
      detail: `invalid KB_DAEMON_URL: ${(err as Error).message}`,
    };
  }
  try {
    const health = await fetchDaemonHealth({ env: process.env, fetchImpl, timeoutMs: 1500 });
    return {
      name: 'kb_daemon',
      kind: 'http',
      status: 'ok',
      configured: true,
      target,
      source: 'env',
      detail: `daemon health responded with status=${JSON.stringify(health.status)}`,
    };
  } catch (err) {
    return {
      name: 'kb_daemon',
      kind: 'http',
      status: 'error',
      configured: true,
      target,
      source: 'env',
      detail: `daemon health is not reachable: ${(err as Error).message}`,
    };
  }
}

async function readOllamaEndpointHealth(fetchImpl: typeof fetch): Promise<EndpointReadinessEntry> {
  const provider = process.env.EMBEDDING_PROVIDER?.trim() || 'huggingface';
  const configured = provider === 'ollama' || Boolean(process.env.OLLAMA_BASE_URL?.trim());
  if (!configured) {
    return {
      name: 'embedding_ollama',
      kind: 'http',
      status: 'skipped',
      configured: false,
      target: null,
      source: 'not_configured',
      detail: 'EMBEDDING_PROVIDER is not ollama and OLLAMA_BASE_URL is not configured',
    };
  }
  let target: string;
  try {
    target = new URL('/api/tags', OLLAMA_BASE_URL).href;
  } catch (err) {
    return {
      name: 'embedding_ollama',
      kind: 'http',
      status: 'error',
      configured: true,
      target: OLLAMA_BASE_URL,
      source: 'invalid',
      detail: `invalid OLLAMA_BASE_URL: ${(err as Error).message}`,
    };
  }
  return probeHttpGet('embedding_ollama', target, 'env', fetchImpl, 'Ollama tags endpoint');
}

async function readConfiguredLlmEndpointHealth(
  check: LlmEndpointProbe,
): Promise<EndpointReadinessEntry> {
  let target: { profile: LlmProfile; source: EndpointReadinessEntry['source'] } | null = null;
  try {
    if (process.env.KB_LLM_ENDPOINT?.trim()) {
      target = {
        profile: await createExternalProfile('env', process.env.KB_LLM_ENDPOINT),
        source: 'env',
      };
    } else {
      const activeProfileName = await readActiveProfileName();
      if (activeProfileName !== null) {
        const profile = await readProfile(activeProfileName);
        if (profile === null) {
          return {
            name: 'llm_endpoint',
            kind: 'http',
            status: 'error',
            configured: true,
            target: null,
            source: 'invalid',
            detail: `active LLM profile ${JSON.stringify(activeProfileName)} is configured but profile file is missing`,
          };
        }
        target = { profile, source: 'profile' };
      }
    }
  } catch (err) {
    return {
      name: 'llm_endpoint',
      kind: 'http',
      status: 'error',
      configured: true,
      target: process.env.KB_LLM_ENDPOINT ?? null,
      source: 'invalid',
      detail: `LLM endpoint configuration is invalid: ${(err as Error).message}`,
    };
  }

  if (target === null) {
    return {
      name: 'llm_endpoint',
      kind: 'http',
      status: 'skipped',
      configured: false,
      target: null,
      source: 'not_configured',
      detail: 'KB_LLM_ENDPOINT is not configured and no active LLM profile is set',
    };
  }

  try {
    const probe = await check(target.profile.endpoint);
    const status: HealthStatus = probe.health_ok && probe.chat_ok ? 'ok' : 'error';
    return {
      name: 'llm_endpoint',
      kind: 'http',
      status,
      configured: true,
      target: probe.endpoint,
      source: target.source,
      detail: formatLlmEndpointDetail(target.profile, target.source === 'profile' ? 'profile' : 'env', probe),
    };
  } catch (err) {
    return {
      name: 'llm_endpoint',
      kind: 'http',
      status: 'error',
      configured: true,
      target: target.profile.endpoint,
      source: target.source,
      detail: `LLM endpoint probe failed: ${(err as Error).message}`,
    };
  }
}

async function readConfiguredGateLlmEndpointHealth(
  check: LlmEndpointProbe,
): Promise<EndpointReadinessEntry> {
  const gateConfig = resolveRelevanceGateConfig();
  const gateEnabled = gateConfig.enabled;
  const fakeLlmEnabled = isFakeLlmEnabled();
  const endpoint = process.env.KB_GATE_LLM_ENDPOINT?.trim();
  if (!gateEnabled || !endpoint || fakeLlmEnabled) {
    return {
      name: 'gate_llm_endpoint',
      kind: 'http',
      status: 'skipped',
      configured: false,
      target: null,
      source: 'not_configured',
      detail: fakeLlmEnabled
        ? 'KB_LLM_FAKE is enabled; the gate uses the in-process fake judge'
        : !gateEnabled
          ? 'KB_RELEVANCE_GATE is not enabled'
          : 'KB_GATE_LLM_ENDPOINT is not configured',
    };
  }

  let profile: LlmProfile;
  try {
    profile = await createExternalProfile('gate', endpoint);
  } catch (err) {
    return {
      name: 'gate_llm_endpoint',
      kind: 'http',
      status: 'error',
      configured: true,
      target: endpoint,
      source: 'invalid',
      detail: `KB_GATE_LLM_ENDPOINT configuration is invalid: ${(err as Error).message}`,
    };
  }

  try {
    const probe = await check(profile.endpoint, {
      model: gateConfig.judgeModel,
      chatTimeoutMs: gateConfig.judgeTimeoutMs,
    });
    return {
      name: 'gate_llm_endpoint',
      kind: 'http',
      status: probe.health_ok && probe.chat_ok ? 'ok' : 'error',
      configured: true,
      target: probe.endpoint,
      source: 'env',
      detail: formatLlmEndpointDetail(profile, 'env', probe),
    };
  } catch (err) {
    return {
      name: 'gate_llm_endpoint',
      kind: 'http',
      status: 'error',
      configured: true,
      target: profile.endpoint,
      source: 'env',
      detail: `Gate LLM endpoint probe failed: ${(err as Error).message}`,
    };
  }
}

function parseEndpointPort(raw: string | undefined, envVar: string, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid ${envVar}=${JSON.stringify(raw)}; expected integer in [1, 65535]`);
  }
  return port;
}

function probeTcpBind(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      if (err) reject(err);
      else resolve();
    };
    server.once('error', finish);
    server.listen({ host, port }, () => {
      server.close((err) => finish(err ?? undefined));
    });
  });
}

async function probeHttpGet(
  name: EndpointReadinessEntry['name'],
  target: string,
  source: EndpointReadinessEntry['source'],
  fetchImpl: typeof fetch,
  label: string,
): Promise<EndpointReadinessEntry> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetchImpl(target, { method: 'GET', signal: controller.signal });
    return {
      name,
      kind: 'http',
      status: response.ok ? 'ok' : 'error',
      configured: true,
      target,
      source,
      detail: response.ok
        ? `${label} responded with HTTP ${response.status}`
        : `${label} returned HTTP ${response.status}`,
    };
  } catch (err) {
    const message = (err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message;
    return {
      name,
      kind: 'http',
      status: 'error',
      configured: true,
      target,
      source,
      detail: `${label} is not reachable: ${message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeEndpointStatus(entries: EndpointReadinessEntry[]): HealthStatus {
  if (entries.some((entry) => entry.status === 'error')) return 'error';
  if (entries.some((entry) => entry.status === 'warn')) return 'warn';
  return 'ok';
}

export function formatEndpointReadinessMarkdown(report: EndpointReadinessReport): string {
  const lines: string[] = [];
  lines.push(`Status: ${report.status.toUpperCase()}`);
  lines.push('');
  lines.push('Endpoint readiness:');
  for (const entry of report.endpoints) {
    const target = entry.target ?? '<not configured>';
    const configured = entry.configured ? 'configured' : 'not configured';
    lines.push(
      `  ${entry.status.toUpperCase().padEnd(7)} ${entry.name}: ${target} ` +
      `(${entry.kind}, ${entry.source}, ${configured}) - ${entry.detail}`,
    );
  }
  return lines.join('\n') + '\n';
}

export async function buildDoctorLocksReport(): Promise<DoctorLocksReport> {
  const generatedAt = new Date();
  const modelRows = await listDoctorLockModelRows();
  const locks = await Promise.all(modelRows.map((row) => readDoctorModelWriteLock(row, generatedAt)));
  const summary = {
    total: locks.length,
    held: locks.filter((entry) => entry.status === 'held').length,
    stale_suspected: locks.filter((entry) => entry.stale_suspected).length,
    unknown: locks.filter((entry) => entry.status === 'unknown').length,
  };
  const status: HealthStatus = summary.unknown > 0
    ? 'error'
    : summary.stale_suspected > 0
      ? 'warn'
      : 'ok';
  return {
    schema_version: 'kb.doctor.locks.v1',
    status,
    faiss_index_path: FAISS_INDEX_PATH,
    models_root: modelsRoot(),
    generated_at: generatedAt.toISOString(),
    stale_threshold_ms: WRITE_LOCK_STALE_MS,
    locks,
    summary,
  };
}

async function listDoctorLockModelRows(): Promise<Array<{
  model_id: string;
  model_name: string | null;
  resource_path: string;
}>> {
  const byId = new Map<string, { model_id: string; model_name: string | null; resource_path: string }>();
  try {
    for (const model of await listRegisteredModels()) {
      byId.set(model.model_id, {
        model_id: model.model_id,
        model_name: model.model_name,
        resource_path: path.join(modelsRoot(), model.model_id),
      });
    }
  } catch {
    // Fall back to the filesystem walk below.
  }

  try {
    const entries = await fsp.readdir(modelsRoot(), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (byId.has(entry.name)) continue;
      byId.set(entry.name, {
        model_id: entry.name,
        model_name: null,
        resource_path: path.join(modelsRoot(), entry.name),
      });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  return [...byId.values()].sort((a, b) => a.model_id.localeCompare(b.model_id));
}

async function readDoctorModelWriteLock(
  row: { model_id: string; model_name: string | null; resource_path: string },
  now: Date,
): Promise<DoctorLockEntry> {
  const lockPath = writeLockPathFor(row.resource_path);
  const ownerPath = writeLockOwnerPathFor(row.resource_path);
  const warnings: string[] = [];
  let present = false;
  let lockKind: DoctorLockEntry['lock_kind'] = 'missing';
  let mtime: string | null = null;
  let ageMs: number | null = null;

  try {
    const st = await fsp.lstat(lockPath);
    present = true;
    lockKind = st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other';
    mtime = new Date(st.mtimeMs).toISOString();
    ageMs = Math.max(0, now.getTime() - st.mtimeMs);
    if (lockKind !== 'directory') {
      warnings.push(`unexpected lock path kind: ${lockKind}`);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      lockKind = 'unknown';
      warnings.push(`stat_failed: ${(err as Error).message}`);
    }
  }

  const owner = present ? await readDoctorLockOwner(ownerPath) : emptyDoctorLockOwner();
  if (owner.source === 'invalid' && owner.detail !== null) {
    warnings.push(owner.detail);
  }

  const ownerDead = owner.pid !== null && owner.live === false;
  const heartbeatStale = ageMs !== null && ageMs > WRITE_LOCK_STALE_MS;
  const staleSuspected = present && (ownerDead || (heartbeatStale && owner.live !== true));
  const status: DoctorLockEntry['status'] = !present
    ? 'ok'
    : lockKind !== 'directory'
      ? 'unknown'
      : staleSuspected
        ? 'stale'
        : 'held';

  return {
    kind: 'model_write',
    model_id: row.model_id,
    model_name: row.model_name,
    resource_path: row.resource_path,
    lock_path: lockPath,
    owner_path: ownerPath,
    present,
    lock_kind: lockKind,
    mtime,
    age_ms: ageMs === null ? null : Math.round(ageMs),
    stale_threshold_ms: WRITE_LOCK_STALE_MS,
    stale_suspected: staleSuspected,
    owner,
    status,
    next_action: formatDoctorLockNextAction(status, owner, heartbeatStale),
    warnings,
  };
}

async function readDoctorLockOwner(ownerPath: string): Promise<DoctorLockOwner> {
  let raw: string;
  try {
    raw = await fsp.readFile(ownerPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyDoctorLockOwner();
    return {
      ...emptyDoctorLockOwner(),
      source: 'invalid',
      detail: `owner metadata read failed: ${(err as Error).message}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ...emptyDoctorLockOwner(),
      source: 'invalid',
      detail: 'owner metadata is not valid JSON',
    };
  }
  if (!isWriteLockOwnerMetadata(parsed)) {
    return {
      ...emptyDoctorLockOwner(),
      source: 'invalid',
      detail: `owner metadata does not match ${WRITE_LOCK_OWNER_SCHEMA_VERSION}`,
    };
  }

  return {
    pid: parsed.pid,
    live: isPidLive(parsed.pid),
    command: parsed.command,
    cwd: parsed.cwd,
    hostname: parsed.hostname,
    started_at: parsed.started_at,
    source: 'metadata',
    detail: null,
  };
}

function isWriteLockOwnerMetadata(value: unknown): value is WriteLockOwnerMetadata {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<WriteLockOwnerMetadata>;
  return candidate.schema_version === WRITE_LOCK_OWNER_SCHEMA_VERSION
    && Number.isSafeInteger(candidate.pid)
    && typeof candidate.pid === 'number'
    && candidate.pid > 0
    && typeof candidate.command === 'string'
    && (candidate.cwd === null || typeof candidate.cwd === 'string')
    && typeof candidate.hostname === 'string'
    && typeof candidate.started_at === 'string'
    && !Number.isNaN(Date.parse(candidate.started_at));
}

function emptyDoctorLockOwner(): DoctorLockOwner {
  return {
    pid: null,
    live: null,
    command: null,
    cwd: null,
    hostname: null,
    started_at: null,
    source: 'none',
    detail: null,
  };
}

function isPidLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function formatDoctorLockNextAction(
  status: DoctorLockEntry['status'],
  owner: DoctorLockOwner,
  heartbeatStale: boolean,
): string {
  if (status === 'ok') return 'No write lock is present for this model.';
  if (status === 'unknown') {
    return 'Inspect the lock path before retrying; do not remove it until its type and owner are understood.';
  }
  if (status === 'stale') {
    if (owner.pid !== null && owner.live === false) {
      return 'The recorded owner PID is no longer live; verify no writer is running before removing the lock path.';
    }
    return 'The lock heartbeat is older than the stale threshold; verify no writer is running before removing the lock path.';
  }
  if (owner.pid !== null && owner.live === true) {
    return 'A writer appears active; wait for it to finish or inspect the recorded command before restarting services.';
  }
  if (heartbeatStale) {
    return 'The heartbeat is old but no owner is known; inspect running kb processes before removing the lock path.';
  }
  return 'A write lock is present; wait and retry before considering manual recovery.';
}

export function formatDoctorLocksMarkdown(report: DoctorLocksReport): string {
  const lines: string[] = [];
  lines.push(`Status: ${report.status.toUpperCase()}`);
  lines.push(`FAISS index path: ${report.faiss_index_path}`);
  lines.push(`Models root: ${report.models_root}`);
  lines.push(
    `Summary: ${report.summary.held} held, ` +
    `${report.summary.stale_suspected} stale suspected, ` +
    `${report.summary.unknown} unknown across ${report.summary.total} model(s)`,
  );
  lines.push('');
  lines.push('Write locks:');
  if (report.locks.length === 0) {
    lines.push('  (no model directories found)');
  } else {
    for (const entry of report.locks) {
      const modelName = entry.model_name === null ? '' : ` (${entry.model_name})`;
      const age = entry.age_ms === null ? 'n/a' : `${entry.age_ms}ms`;
      lines.push(`  ${entry.status.toUpperCase()} ${entry.model_id}${modelName}`);
      lines.push(`    lock: ${entry.lock_path}`);
      lines.push(`    present: ${entry.present ? 'yes' : 'no'}, kind: ${entry.lock_kind}, age: ${age}`);
      if (entry.owner.pid !== null) {
        lines.push(
          `    owner: pid=${entry.owner.pid}, live=${formatNullableBoolean(entry.owner.live)}, ` +
          `source=${entry.owner.source}, command=${entry.owner.command ?? '<unknown>'}`,
        );
      } else {
        lines.push(`    owner: ${entry.owner.source}`);
      }
      if (entry.warnings.length > 0) {
        for (const warning of entry.warnings) lines.push(`    WARN ${warning}`);
      }
      lines.push(`    next: ${entry.next_action}`);
    }
  }
  return lines.join('\n') + '\n';
}

export async function buildDoctorKbSymlinksReport(): Promise<DoctorKbSymlinksReport> {
  const inventory = await inventoryKbSymlinks(KNOWLEDGE_BASES_ROOT_DIR);
  const status: HealthStatus = inventory.summary.scan_error_count > 0
    ? 'error'
    : inventory.summary.escaping > 0 ||
      inventory.summary.broken > 0 ||
      inventory.summary.loop_or_error > 0
      ? 'warn'
      : 'ok';
  return {
    schema_version: 'kb.doctor.kb_symlinks.v1',
    status,
    inventory,
  };
}

export function formatDoctorKbSymlinksMarkdown(report: DoctorKbSymlinksReport): string {
  const lines: string[] = [];
  const summary = report.inventory.summary;
  lines.push(`Status: ${report.status.toUpperCase()}`);
  lines.push(`KB root: ${report.inventory.root_dir}`);
  lines.push(`KB root realpath: ${report.inventory.root_realpath ?? '<unresolved>'}`);
  lines.push(
    `Symlinks: ${summary.total} total, ${summary.inside_root} inside-root, ` +
      `${summary.escaping} escaping, ${summary.broken} broken, ` +
      `${summary.loop_or_error} loop/error`,
  );
  if (summary.scan_error_count > 0) {
    lines.push(`Scan errors: ${summary.scan_error_count}`);
    for (const error of report.inventory.scan_errors) {
      const code = error.code ?? 'unknown';
      lines.push(`  ERROR ${error.path} (${code}) ${error.message}`);
    }
  }
  if (report.inventory.symlinks.length === 0) {
    lines.push('Examples: (none)');
  } else {
    lines.push(`Examples (capped at ${summary.sample_limit}):`);
    for (const link of report.inventory.symlinks) {
      const resolved = link.resolved_target ?? '<unresolved>';
      const target = link.link_target ?? '<unreadable>';
      const error = link.error_message === null
        ? ''
        : `; ${link.error_code ?? 'unknown'} ${link.error_message}`;
      lines.push(
        `  ${link.classification} ${link.relative_path} -> ${target} ` +
          `(resolved=${resolved}${error})`,
      );
    }
  }
  return lines.join('\n') + '\n';
}

export async function buildDoctorReport(
  options: BuildDoctorReportOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorReport['checks'] = [];
  const configValidation = validateConfigEnv(process.env);
  checks.push({
    name: 'config',
    status: configValidation.status,
    detail: formatConfigValidationCheckDetail(configValidation),
  });
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
  const embeddingCanary = await (
    options.embeddingCanaryCheck ?? readEmbeddingCanaryHealth
  )(activeModelId, activeProvider, activeModelName, index.binary_path);
  checks.push({
    name: 'embedding_canary',
    status: embeddingCanary.status === 'warn' || embeddingCanary.status === 'error'
      ? embeddingCanary.status
      : 'ok',
    detail: embeddingCanary.detail,
  });
  const extractionCache = await readExtractionCacheHealth();
  checks.push({
    name: 'extraction_cache',
    status: extractionCache.error_count > 0 ? 'warn' : 'ok',
    detail: formatExtractionCacheCheckDetail(extractionCache),
  });

  const lastIndexUpdate = options.lastIndexUpdateSummary
    ?? (await FaissIndexManager.readPersistedIndexUpdateSummary(activeModelId))
    ?? createNeverRunIndexUpdateSummary(activeModelId);
  const indexUpdateStatus = indexUpdateCheckStatus(lastIndexUpdate);
  checks.push({
    name: 'index_update',
    status: indexUpdateStatus,
    detail: formatIndexUpdateCheckDetail(lastIndexUpdate),
  });

  const staleResult = await computeStaleCountsByKb(
    activeModelId,
    index.mtime === null ? null : Date.parse(index.mtime),
  );
  const staleCounts = staleResult.stale_counts_by_kb;
  const staleTotal = Object.values(staleCounts)
    .reduce((sum, row) => sum + row.modified_files + row.new_files, 0);
  const enumerationFailureCount = staleResult.filesystem.enumeration_failures.failure_count;
  const indexUpdateNeedsAttention = indexUpdateStatus !== 'ok';
  checks.push({
    name: 'staleness',
    status: staleTotal === 0 && enumerationFailureCount === 0 && !indexUpdateNeedsAttention
      ? 'ok'
      : 'warn',
    detail: [
      staleTotal === 0
        ? 'no modified or new ingestable files detected'
        : `${staleTotal} modified/new ingestable file(s) detected`,
      ...(enumerationFailureCount === 0
        ? []
        : [`${enumerationFailureCount} filesystem enumeration failure(s)`]),
      ...(indexUpdateNeedsAttention
        ? [formatIndexUpdateAttentionDetail(lastIndexUpdate)]
        : []),
    ].join('; '),
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
  const gateLlmEndpoint = await readConfiguredGateLlmEndpointHealth(
    options.llmEndpointProbe ?? defaultLlmEndpointProbe,
  );
  checks.push({
    name: 'gate_llm_endpoint',
    status: gateLlmEndpoint.status === 'error' ? 'warn' : 'ok',
    detail: gateLlmEndpoint.detail,
  });

  const reranker = await readRerankerHealth();
  checks.push({
    name: 'reranker',
    status: reranker.status,
    detail: reranker.detail,
  });

  const metricsSource = options.providerCallMetrics ?? providerCallMetrics;
  const providerCalls = metricsSource.snapshot();
  const llmMetricsSource = options.llmCallMetrics ?? llmCallMetrics;
  const llmCalls = llmMetricsSource.snapshot();
  const answerCacheSource = options.answerCache ?? defaultAnswerCache;
  const answerCache = await answerCacheSource.stats();
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

  // Issue #747 — surface any tripped provider breaker before users hit
  // failing searches. Breakers are process-local, so a one-shot `kb doctor`
  // usually sees an empty snapshot; only emit the row when at least one
  // breaker has tracked a call, mirroring the provider_calls row above.
  const providerCircuits = (options.providerBreaker ?? providerBreakerRegistry).snapshot();
  if (providerCircuits.length > 0) {
    const tripped = providerCircuits.filter((c) => c.state !== 'closed');
    if (tripped.length > 0) {
      const summary = tripped
        .map((c) => formatProviderCircuitDetail(c))
        .join('; ');
      checks.push({
        name: 'provider_circuit',
        status: 'warn',
        detail: `${tripped.length} provider breaker(s) not closed: ${summary}`,
      });
    } else {
      checks.push({
        name: 'provider_circuit',
        status: 'ok',
        detail: `${providerCircuits.length} provider breaker(s) tracked, all closed`,
      });
    }
  }

  const searchMetricsSource = options.searchMetrics ?? searchLatencyMetrics;
  const daemonStats = await (options.daemonStatsPayload ?? (() => tryReadDaemonStatsPayload()))();
  const denseSearchLatency = daemonStats?.dense_search_latency
    ?? (
      index.type === null
        ? null
        : summarizeDenseSearchLatency(
            searchMetricsSource.snapshot(),
            index.type,
            resolveFlatSearchP95AdvisoryMs(),
          )
    );
  if (denseSearchLatency?.advisory !== null && denseSearchLatency?.advisory !== undefined) {
    checks.push({
      name: 'flat_search_latency',
      status: 'warn',
      detail: denseSearchLatency.advisory.message,
    });
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
  const reindexTrigger = await readReindexTriggerHealth(index.mtime);
  checks.push({
    name: 'reindex_trigger',
    status: reindexTrigger.status,
    detail: formatReindexTriggerCheckDetail(reindexTrigger),
  });

  const integrity = options.integrity === true ? await verifyIntegrity({ modelId: activeModelId }) : null;
  if (integrity !== null) {
    const findingCount = integrity.findings.length;
    checks.push({
      name: 'integrity',
      status: integrity.status === 'corruption'
        ? 'error'
        : integrity.status === 'drift'
          ? 'warn'
          : 'ok',
      detail: integrity.status === 'clean'
        ? 'deep integrity audit found no drift'
        : `${findingCount} integrity finding(s); verify exit code ${integrityExitCode(integrity)}`,
    });
  }

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
    embedding_canary: embeddingCanary,
    extraction_cache: extractionCache,
    stale_counts_by_kb: staleCounts,
    filesystem: staleResult.filesystem,
    quarantine_counts_by_kb: quarantineCounts,
    age_budgets: ageBudgetResult.byKb,
    age_budget_config_errors: ageBudgetResult.configErrors,
    incomplete_models: incompleteModels,
    backend,
    llm_endpoint: llmEndpoint,
    gate_llm_endpoint: gateLlmEndpoint,
    reranker,
    cli,
    git,
    last_index_update: lastIndexUpdate,
    reindex_trigger: reindexTrigger,
    provider_calls: providerCalls,
    llm_calls: llmCalls,
    answer_cache: answerCache,
    provider_circuits: providerCircuits,
    dense_search_latency: denseSearchLatency,
    integrity,
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

/**
 * Issue #747 — one-line operator summary for a non-closed provider
 * breaker: which provider/kind, its state, when it last tripped, and how
 * much cooldown remains before it admits a probe.
 */
function formatProviderCircuitDetail(circuit: ProviderCircuitSnapshot): string {
  const { kind, provider } = parseProviderCircuitKey(circuit.key);
  const openedAt = circuit.opened_at_ms === null
    ? 'unknown'
    : new Date(circuit.opened_at_ms).toISOString();
  const cooldown = circuit.state === 'open'
    ? `, cooldown=${Math.round(circuit.retry_after_ms / 1000)}s`
    : '';
  return `${kind}/${provider} ${circuit.state} (opened ${openedAt}, ` +
    `opens=${circuit.opened_total}${cooldown})`;
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
    return {
      path: FAISS_INDEX_PATH,
      binary_path: null,
      version: null,
      mtime: null,
      type: null,
      factory: null,
      storage: emptyStorage,
    };
  }
  const indexType = await readStoredIndexType(activeModelId);
  const indexFactory = indexFactoryForType(indexType);
  const storage = await readModelIndexStorage(activeModelId);
  const storageSummary: DoctorReport['index']['storage'] = {
    active_version_bytes: storage.active_version_bytes,
    inactive_version_count: storage.inactive_version_count,
    inactive_version_bytes: storage.inactive_version_bytes,
    total_version_bytes: storage.total_version_bytes,
    retention_previous_versions: storage.retention_previous_versions,
  };
  const binaryPath = await resolveActiveIndexFilePath(
    modelDir(activeModelId),
    backendForIndexType(indexType),
  );
  if (binaryPath === null) {
    return {
      path: FAISS_INDEX_PATH,
      binary_path: null,
      version: null,
      mtime: null,
      type: indexType,
      factory: indexFactory,
      storage: storageSummary,
    };
  }
  try {
    const st = await fsp.stat(binaryPath);
    return {
      path: FAISS_INDEX_PATH,
      binary_path: binaryPath,
      version: indexVersionFromPath(binaryPath),
      mtime: new Date(st.mtimeMs).toISOString(),
      type: indexType,
      factory: indexFactory,
      storage: storageSummary,
    };
  } catch {
    return {
      path: FAISS_INDEX_PATH,
      binary_path: null,
      version: null,
      mtime: null,
      type: indexType,
      factory: indexFactory,
      storage: storageSummary,
    };
  }
}

async function readEmbeddingCanaryHealth(
  activeModelId: string | null,
  provider: string | null,
  modelName: string | null,
  binaryPath: string | null,
): Promise<DoctorEmbeddingCanaryReport> {
  const base = (): Omit<DoctorEmbeddingCanaryReport, 'status' | 'detail'> => ({
    canary_id: null,
    recorded_at: null,
    dimensions: null,
    similarity: null,
    threshold: EMBEDDING_CANARY_COSINE_WARN_THRESHOLD,
    next_action: null,
  });

  if (activeModelId === null || binaryPath === null) {
    return {
      ...base(),
      status: 'skipped',
      detail: 'embedding canary skipped because the active model index is not built',
    };
  }

  let manifest: Awaited<ReturnType<typeof readIndexIntegrityManifest>>;
  try {
    manifest = await readIndexIntegrityManifest(path.dirname(binaryPath));
  } catch (err) {
    return {
      ...base(),
      status: 'error',
      detail: `could not read embedding canary manifest: ${(err as Error).message}`,
      next_action: 'Run kb verify --integrity, then rebuild the affected index if the manifest is corrupt.',
    };
  }
  const canary = manifest?.embedding_canary;
  if (canary === undefined) {
    return {
      ...base(),
      status: 'not_recorded',
      detail: 'embedding canary not recorded for this index; rebuild the index to capture a canary fingerprint',
      next_action: 'Run a forced reindex with this version before relying on drift detection for this model.',
    };
  }

  if (
    canary.canary_id !== EMBEDDING_CANARY_ID ||
    !Array.isArray(canary.vector) ||
    canary.vector.length === 0 ||
    canary.dimensions !== canary.vector.length
  ) {
    return {
      ...base(),
      status: 'warn',
      canary_id: typeof canary.canary_id === 'string' ? canary.canary_id : null,
      recorded_at: typeof canary.captured_at === 'string' ? canary.captured_at : null,
      dimensions: typeof canary.dimensions === 'number' ? canary.dimensions : null,
      detail: 'embedding canary metadata is invalid or was written with an unsupported canary id',
      next_action: 'Rebuild the index with the current CLI; see docs/operations/switching-embedding-models.md for model-switch validation steps.',
    };
  }

  if (provider === null || modelName === null || !isEmbeddingsProvider(provider)) {
    return {
      ...base(),
      status: 'error',
      canary_id: canary.canary_id,
      recorded_at: canary.captured_at,
      dimensions: canary.dimensions,
      detail: 'embedding canary could not run because the active embedding provider is unresolved',
      next_action: 'Fix the active model metadata, then rerun kb doctor.',
    };
  }

  try {
    const embeddings = await createEmbeddingsClient({ provider, modelName });
    const current = await createEmbeddingCanaryFingerprint(embeddings);
    const similarity = cosineSimilarity(canary.vector, current.vector);
    if (similarity === null) {
      return {
        ...base(),
        status: 'warn',
        canary_id: canary.canary_id,
        recorded_at: canary.captured_at,
        dimensions: canary.dimensions,
        detail: `embedding canary dimensions are incompatible: recorded=${canary.vector.length}, current=${current.vector.length}`,
        next_action: 'Review docs/operations/switching-embedding-models.md, then rebuild or switch back to a matching embedding model.',
      };
    }
    const common = {
      canary_id: canary.canary_id,
      recorded_at: canary.captured_at,
      dimensions: canary.dimensions,
      similarity,
      threshold: EMBEDDING_CANARY_COSINE_WARN_THRESHOLD,
    };
    if (similarity < EMBEDDING_CANARY_COSINE_WARN_THRESHOLD) {
      return {
        ...common,
        status: 'warn',
        detail: `embedding canary drift detected: cosine=${formatSimilarity(similarity)} below threshold=${EMBEDDING_CANARY_COSINE_WARN_THRESHOLD}`,
        next_action: 'Review docs/operations/switching-embedding-models.md, then rebuild the index for the intended model or restore the original embedding backend.',
      };
    }
    return {
      ...common,
      status: 'ok',
      detail: `embedding canary matches persisted fingerprint: cosine=${formatSimilarity(similarity)}`,
      next_action: null,
    };
  } catch (err) {
    return {
      ...base(),
      status: 'error',
      canary_id: canary.canary_id,
      recorded_at: canary.captured_at,
      dimensions: canary.dimensions,
      detail: `embedding canary re-embed failed: ${(err as Error).message}`,
      next_action: 'Fix embedding provider credentials/connectivity, then rerun kb doctor.',
    };
  }
}

function isEmbeddingsProvider(value: string): value is EmbeddingProvider | 'fake' {
  return value === 'huggingface' ||
    value === 'ollama' ||
    value === 'openai' ||
    value === 'fake';
}

function formatSimilarity(value: number): string {
  return value.toFixed(6);
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

async function readExtractionCacheHealth(): Promise<DoctorReport['extraction_cache']> {
  const inventory = await inventoryExtractionCache();
  return {
    cache_dir: inventory.cache_dir,
    exists: inventory.exists,
    entry_count: inventory.summary.entry_count,
    total_bytes: inventory.summary.total_bytes,
    oldest_mtime: inventory.summary.oldest_mtime,
    newest_mtime: inventory.summary.newest_mtime,
    ignored_entry_count: inventory.summary.ignored_entry_count,
    error_count: inventory.summary.error_count,
    errors: inventory.errors,
  };
}

function formatExtractionCacheCheckDetail(
  report: DoctorReport['extraction_cache'],
): string {
  const presence = report.exists ? 'present' : 'not present';
  const ignored = report.ignored_entry_count === 0
    ? ''
    : `; ${report.ignored_entry_count} non-cache entr${report.ignored_entry_count === 1 ? 'y' : 'ies'} ignored`;
  const errors = report.error_count === 0
    ? ''
    : `; ${report.error_count} inventory error(s)`;
  return `${presence}; ${report.entry_count} cache entr${report.entry_count === 1 ? 'y' : 'ies'}, ` +
    `${formatBytes(report.total_bytes)}${ignored}${errors}`;
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
): Promise<{
  stale_counts_by_kb: DoctorReport['stale_counts_by_kb'];
  filesystem: DoctorReport['filesystem'];
}> {
  let kbs: string[];
  try {
    kbs = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
  } catch {
    return {
      stale_counts_by_kb: {},
      filesystem: {
        enumeration_failures: { failure_count: 0, failures: [] },
      },
    };
  }

  const enumerations = await enumerateIngestableKbFiles(
    KNOWLEDGE_BASES_ROOT_DIR,
    kbs,
    {
      extraExtensions: INGEST_EXTRA_EXTENSIONS,
      excludePaths: INGEST_EXCLUDE_PATHS,
    },
  );
  const enumerationFailures = aggregateEnumerationDiagnostics(enumerations);

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
  return {
    stale_counts_by_kb: out,
    filesystem: {
      enumeration_failures: enumerationFailures,
    },
  };
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

async function defaultLlmEndpointProbe(
  endpoint: string,
  probeOptions?: LlmProbeOptions,
): Promise<LlmProbeResult> {
  return probeLlmEndpoint(endpoint, fetch, {
    healthTimeoutMs: DOCTOR_LLM_HEALTH_TIMEOUT_MS,
    chatTimeoutMs: DOCTOR_LLM_CHAT_TIMEOUT_MS,
    ...probeOptions,
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
      const res = await fetch(new URL('/api/embed', OLLAMA_BASE_URL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          input: 'kb doctor backend smoke test',
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        return {
          healthy: false,
          detail: `Ollama ${OLLAMA_BASE_URL} failed embedding probe for ${modelName}: ` +
            `HTTP ${res.status}${await formatOllamaResponseDetail(res)}`,
        };
      }
      return { healthy: true, detail: `Ollama ${OLLAMA_BASE_URL} embedded smoke query with ${modelName}` };
    } catch (err) {
      const message = (err as Error).name === 'AbortError'
        ? 'timed out'
        : (err as Error).message;
      return { healthy: false, detail: `Ollama ${OLLAMA_BASE_URL} embedding probe failed: ${message}` };
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

async function formatOllamaResponseDetail(res: Response): Promise<string> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return '';
  }
  const trimmed = text.trim();
  if (trimmed === '') return '';
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim() !== '') {
      return `: ${parsed.error.trim().slice(0, 300)}`;
    }
  } catch {
    // Fall through to plain text below.
  }
  return `: ${trimmed.slice(0, 300)}`;
}

function summarizeStatus(checks: DoctorReport['checks']): HealthStatus {
  if (checks.some((c) => c.status === 'error')) return 'error';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}

function formatConfigValidationCheckDetail(report: ConfigValidateReport): string {
  if (report.status === 'ok') {
    return `configuration schema validation passed (${report.counts.ok} finding(s))`;
  }
  const problems = report.findings
    .filter((finding) => finding.status !== 'ok')
    .map((finding) => `${finding.name}: ${finding.message}`)
    .slice(0, 8);
  const omitted = report.counts.warn + report.counts.error - problems.length;
  return [
    `configuration schema validation ${report.status}`,
    problems.join('; '),
    omitted > 0 ? `(${omitted} additional finding(s) omitted)` : '',
  ].filter((part) => part !== '').join(': ');
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
  lines.push(`Index type: ${report.index.type ?? '<unknown>'}`);
  lines.push(`Index factory: ${report.index.factory ?? '<unknown>'}`);
  lines.push(`Index mtime: ${report.index.mtime ?? '<none>'}`);
  lines.push(
    `Index storage: ${formatBytes(report.index.storage.total_version_bytes)} total ` +
      `(${formatBytes(report.index.storage.active_version_bytes)} active, ` +
      `${formatBytes(report.index.storage.inactive_version_bytes)} inactive across ` +
      `${report.index.storage.inactive_version_count} retained inactive version(s); ` +
      `retention=${report.index.storage.retention_previous_versions})`,
  );
  lines.push('Embedding canary:');
  lines.push(`  status: ${report.embedding_canary.status}`);
  lines.push(`  canary_id: ${report.embedding_canary.canary_id ?? '<not recorded>'}`);
  lines.push(`  recorded_at: ${report.embedding_canary.recorded_at ?? '<not recorded>'}`);
  lines.push(
    `  cosine: ${report.embedding_canary.similarity === null
      ? 'n/a'
      : formatSimilarity(report.embedding_canary.similarity)} ` +
      `(threshold=${report.embedding_canary.threshold})`,
  );
  lines.push(`  detail: ${report.embedding_canary.detail}`);
  if (report.embedding_canary.next_action !== null) {
    lines.push(`  next_action: ${report.embedding_canary.next_action}`);
  }
  lines.push('Extracted-text cache:');
  lines.push(`  path: ${report.extraction_cache.cache_dir}`);
  lines.push(
    `  entries: ${report.extraction_cache.entry_count}, ` +
    `bytes=${formatBytes(report.extraction_cache.total_bytes)}, ` +
    `exists=${report.extraction_cache.exists ? 'yes' : 'no'}`,
  );
  lines.push(
    `  oldest: ${report.extraction_cache.oldest_mtime ?? 'n/a'}, ` +
    `newest: ${report.extraction_cache.newest_mtime ?? 'n/a'}`,
  );
  lines.push(`  ignored non-cache entries: ${report.extraction_cache.ignored_entry_count}`);
  if (report.extraction_cache.errors.length === 0) {
    lines.push('  errors: (none)');
  } else {
    for (const err of report.extraction_cache.errors) {
      lines.push(`  ERROR ${err.path}: ${err.message}`);
    }
  }
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
  lines.push('Gate LLM endpoint:');
  lines.push(`  status: ${report.gate_llm_endpoint.status}`);
  lines.push(`  configured: ${report.gate_llm_endpoint.configured ? 'yes' : 'no'}`);
  lines.push(`  source: ${report.gate_llm_endpoint.source}`);
  lines.push(`  endpoint: ${report.gate_llm_endpoint.target ?? '<unconfigured>'}`);
  lines.push(`  detail: ${report.gate_llm_endpoint.detail}`);
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
  if (report.integrity !== null) {
    lines.push('');
    lines.push('Integrity:');
    for (const line of formatIntegrityMarkdown(report.integrity).trimEnd().split('\n')) {
      lines.push(`  ${line}`);
    }
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
  lines.push('Filesystem enumeration:');
  const enumerationFailures = report.filesystem.enumeration_failures;
  if (enumerationFailures.failure_count === 0) {
    lines.push('  0 failures');
  } else {
    lines.push(`  ${enumerationFailures.failure_count} failure(s); stale counts may be partial`);
    for (const failure of enumerationFailures.failures) {
      const code = failure.code === null ? 'unknown' : failure.code;
      lines.push(`  ${failure.kbName}: ${failure.path} (${code}) ${failure.message}`);
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
  lines.push('LLM calls:');
  const llmCalls = Object.entries(report.llm_calls ?? {})
    .filter((entry): entry is [string, NonNullable<typeof entry[1]>] => entry[1] !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  if (llmCalls.length === 0) {
    lines.push('  (no LLM calls observed)');
  } else {
    for (const [operation, row] of llmCalls) {
      const p95 = quantileFromBuckets(row.latency_ms.buckets, row.latency_ms.count, 0.95);
      const promptTokens = row.prompt_tokens === null ? 'n/a' : String(row.prompt_tokens);
      const completionTokens = row.completion_tokens === null ? 'n/a' : String(row.completion_tokens);
      lines.push(
        `  operation=${operation} calls=${row.count} errors=${row.errors} ` +
        `p95=${p95}ms prompt_tokens=${promptTokens} completion_tokens=${completionTokens} ` +
        `attempts=${row.attempts ?? row.count} ` +
        `retries=${row.retries ?? Math.max(0, (row.attempts ?? row.count) - row.count)} ` +
        `cache_outcomes=${formatBoundedCounts(row.cache_outcomes)} ` +
        `answer_impact=${formatBoundedCounts(row.answer_impact)} ` +
        `attribution=${(row.attribution ?? [])
          .map((entry) => `${entry.provider}/${entry.model}:${entry.count}/${entry.attempts}/${entry.retries}`)
          .join(',') || 'none'}`,
      );
    }
  }
  lines.push('');
  if (report.answer_cache !== undefined) {
    const cache = report.answer_cache;
    lines.push(
      `Answer cache: hits=${cache.hits} misses=${cache.misses} writes=${cache.writes} ` +
      `outcomes=${formatBoundedCounts(cache.outcomes)} disk_size_bytes=${cache.disk_size_bytes}`,
    );
    lines.push('');
  }
  lines.push('Provider circuit breakers:');
  if (report.provider_circuits.length === 0) {
    lines.push('  (no provider breakers tracked)');
  } else {
    for (const circuit of report.provider_circuits) {
      const marker = circuit.state === 'closed' ? '' : ', WARN';
      lines.push(`  ${formatProviderCircuitDetail(circuit)}${marker}`);
    }
  }
  lines.push('');
  lines.push('Dense search latency:');
  if (report.dense_search_latency === null) {
    lines.push('  (no dense faiss_search latency observed)');
  } else {
    const row = report.dense_search_latency;
    lines.push(
      `  active_index=${row.active_index.type} factory=${row.active_index.factory} ` +
      `samples=${row.sample_count} p50=${row.p50_ms}ms p95=${row.p95_ms}ms ` +
      `threshold=${row.threshold_ms}ms`,
    );
    if (row.advisory !== null) {
      lines.push(`  HINT ${row.advisory.message}`);
      lines.push(`  docs: ${row.advisory.docs.join(', ')}`);
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

function formatBoundedCounts(counts: Record<string, number> | undefined): string {
  if (counts === undefined) return 'none';
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? 'none' : entries.map(([key, value]) => `${key}=${value}`).join(',');
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

function indexUpdateCheckStatus(summary: IndexUpdateSummary): HealthStatus {
  if (summary.status === 'failed') return 'error';
  if (
    summary.status === 'partial' ||
    summary.failure_count > 0 ||
    summary.warning_count > 0 ||
    summary.files_skipped > 0
  ) return 'warn';
  return 'ok';
}

function formatIndexUpdateCheckDetail(summary: IndexUpdateSummary): string {
  if (summary.status === 'never_run') {
    return 'no completed index update recorded';
  }
  const scope = summary.scope ?? '<unknown scope>';
  return `latest index update is ${summary.status} (scope=${scope}, ${formatIndexUpdateCounts(summary)})`;
}

function formatIndexUpdateAttentionDetail(summary: IndexUpdateSummary): string {
  return `latest index update is ${summary.status} with ${formatIndexUpdateCounts(summary)}`;
}

function formatIndexUpdateCounts(summary: IndexUpdateSummary): string {
  return [
    `${summary.failure_count} failure(s)`,
    ...(summary.warning_count > 0 ? [`${summary.warning_count} warning(s)`] : []),
    ...(summary.files_skipped > 0 ? [`${summary.files_skipped} skipped file(s)`] : []),
  ].join(', ');
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
