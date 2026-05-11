// `kb search` freshness-footer helpers driven by the per-KB time-based
// age budget (issue #218).
//
// Content-modification staleness (`modified_files` / `new_files`) is
// handled by `cli-search.ts:formatFreshnessFooter`; this module is a
// separate, orthogonal layer that surfaces a wall-clock age breach
// when `KB_AGE_BUDGET_HOURS_<KB>` (or the unsuffixed global default)
// is configured. The two layers compose: a KB can be content-fresh
// but age-budget-stale, or vice versa.

import {
  AgeBudgetConfigError,
  computeAgeBudgetStatus,
  formatAgeHours,
  type AgeBudgetStatus,
} from './age-budget.js';

export interface AgeBudgetFooterInput {
  /** KB name scoped by the search. The footer is per-KB, so callers
   *  in the unscoped (all-KBs) path should iterate and emit one
   *  line per breached KB. */
  kb: string;
  /** Last-index timestamp for the scoped KB in epoch milliseconds.
   *  Typically derived from sidecar mtimes under `<kb>/.index/`; pass
   *  `null` when the KB has never been indexed. */
  lastIndexAtMs: number | null;
  /** Injectable clock for testing. Defaults to `Date.now()`. */
  nowMs?: number;
  /** Injectable env for testing. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface AgeBudgetFooterResult {
  status: AgeBudgetStatus;
  /** The footer line to append to `kb search` markdown output, or
   *  `null` when there is nothing to surface (no budget configured,
   *  KB never indexed, or within budget). */
  line: string | null;
  /** Set when env-var parsing failed (e.g. `KB_AGE_BUDGET_HOURS_<KB>=0`).
   *  Callers can surface this as a warning footer line. The
   *  underlying `status` falls back to "no budget configured". */
  configError: AgeBudgetConfigError | null;
}

/**
 * Compute the age-budget footer line for a scoped `kb search` run.
 *
 * Returns `{ status, line, configError }`. When no budget is
 * configured, when the KB has never been indexed, or when the KB is
 * within budget, `line` is `null`. When a budget is configured and
 * the wall-clock age exceeds it, `line` is the rendered footer line.
 * When env-var parsing throws `AgeBudgetConfigError`, the error is
 * returned in `configError` and `line` carries a malformed-config
 * warning so the operator notices.
 */
export function buildAgeBudgetFooter(
  input: AgeBudgetFooterInput,
): AgeBudgetFooterResult {
  const nowMs = input.nowMs ?? Date.now();
  const env = input.env ?? process.env;
  let status: AgeBudgetStatus;
  let configError: AgeBudgetConfigError | null = null;
  try {
    status = computeAgeBudgetStatus(input.kb, input.lastIndexAtMs, nowMs, env);
  } catch (err) {
    if (!(err instanceof AgeBudgetConfigError)) throw err;
    configError = err;
    status = {
      kb: input.kb,
      configuredHours: null,
      currentAgeHours:
        input.lastIndexAtMs === null
          ? null
          : Math.max(0, (nowMs - input.lastIndexAtMs) / 3_600_000),
      breach: false,
    };
  }
  if (configError !== null) {
    return {
      status,
      line:
        `> _Age-budget config error: ${configError.envVar}=` +
        `${JSON.stringify(configError.rawValue)} is not a positive ` +
        `integer; age budget for KB "${input.kb}" is disabled until ` +
        `the value is fixed._`,
      configError,
    };
  }
  if (!status.breach) {
    return { status, line: null, configError: null };
  }
  const ageH = formatAgeHours(status.currentAgeHours);
  return {
    status,
    line:
      `> _Served from index aged ${ageH}h, budget ${status.configuredHours}h. ` +
      `Run \`kb search --refresh\` to update._`,
    configError: null,
  };
}
