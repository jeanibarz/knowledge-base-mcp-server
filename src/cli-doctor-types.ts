// cli-doctor-types.ts — issue #1006. Leaf module for the `DoctorReport`
// shape (and the small set of status/entry types it is built from) so
// cli-bug-report.ts can depend on the shape of a doctor report without
// statically importing cli-doctor.ts, which itself does a runtime (value)
// import of cli-bug-report.ts to build the bug-report bundle. cli-doctor.ts
// re-exports everything here so its own internal `DoctorReport[...]`
// usages keep compiling unchanged.

import type { ExtractionCacheInventory } from './extraction-cache.js';
import type { KbFilesystemEnumerationDiagnostics } from './kb-fs.js';
import type { IndexUpdateSummary } from './FaissIndexManager.js';
import type { KbStatsDenseSearchLatencySummary } from './kb-stats.js';
import type { AnswerCacheStats } from './ask-answer-cache.js';
import type { LlmCallMetricsSnapshot, ProviderCallSnapshot } from './metrics-recording.js';
import type { ProviderCircuitSnapshot } from './provider-breaker.js';
import type { SearchIndexType } from './config/indexing.js';
import type { IntegrityReport } from './cli-verify.js';

export type HealthStatus = 'ok' | 'warn' | 'error';
export type EndpointHealthStatus = HealthStatus | 'skipped';
export type EmbeddingCanaryHealthStatus = HealthStatus | 'not_recorded' | 'skipped';

export interface EndpointReadinessEntry {
  name: 'mcp_bind' | 'kb_daemon' | 'embedding_ollama' | 'llm_endpoint' | 'gate_llm_endpoint';
  kind: 'bind' | 'http';
  status: EndpointHealthStatus;
  configured: boolean;
  target: string | null;
  source: 'env' | 'profile' | 'default' | 'not_configured' | 'invalid';
  detail: string;
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
  /**
   * Issue #886 — disk-space preflight for `kb reindex`, computed from the
   * SAME estimator the reindex guard (`assertSufficientDiskSpace`) uses so
   * the two can never disagree about whether a rebuild is possible. FAIL
   * (error) means a reindex against `$FAISS_INDEX_PATH` would be refused up
   * front; WARN means free space clears the estimate but by less than the
   * headroom factor, so the next corpus growth is likely to break it. When
   * `statfs` is unavailable (older runtimes / exotic filesystems) the check
   * degrades to OK exactly as the guard degrades to permissive, and
   * `statfs_checked` is false.
   */
  disk_space: {
    status: HealthStatus;
    path: string;
    current_bytes: number;
    estimate_factor: number;
    estimated_bytes: number;
    /**
     * Free bytes on the target filesystem, or `null` when `statfs` could not
     * be read (`statfs_checked: false`). Deliberately not a sentinel number:
     * `Infinity` would serialize to `null` under `JSON.stringify` anyway, and
     * `0` would read as "disk full" to a numeric consumer — the opposite of
     * the permissive degrade this represents.
     */
    available_bytes: number | null;
    margin_bytes: number;
    required_bytes: number;
    sufficient: boolean;
    warn_headroom_factor: number;
    statfs_checked: boolean;
    detail: string;
    next_action: string | null;
  };
  llm_endpoint: {
    /**
     * Issue #966 — `'skipped'` when the aggregate report ran without the
     * opt-in chat probe (the default), so a liveness probe never loads a
     * chat model on the GPU.
     */
    status: HealthStatus | 'skipped';
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
