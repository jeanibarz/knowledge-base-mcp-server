// Per-KB time-based age budget (issue #218).
//
// Operators set `KB_AGE_BUDGET_HOURS_<KB>=N` (or the unsuffixed
// `KB_AGE_BUDGET_HOURS=N` as a global fallback) to declare the maximum
// acceptable wall-clock age, in hours, between an index pass and the
// current retrieval. Unset = no budget; `0`/negative/non-integer values
// are rejected as malformed config.
//
// This module is intentionally pure: no filesystem reads, no clock
// reads except as a caller-supplied parameter. Consumers wire it into
// `kb doctor` and `kb search` (freshness footer).

const ENV_PREFIX = 'KB_AGE_BUDGET_HOURS_';
const ENV_DEFAULT = 'KB_AGE_BUDGET_HOURS';
const MS_PER_HOUR = 3_600_000;

export class AgeBudgetConfigError extends Error {
  readonly code = 'KB_AGE_BUDGET_INVALID';
  constructor(
    readonly envVar: string,
    readonly rawValue: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgeBudgetConfigError';
  }
}

/**
 * Map a KB name to its env-var suffix. The KB name is NFC-normalised,
 * upper-cased, and any character outside `[A-Z0-9_]` is replaced with
 * `_`. The mapping is one-way; two distinct KB names that collapse to
 * the same suffix would share a budget (operator-visible if either
 * `kb doctor` or the freshness footer is consulted).
 */
export function kbNameToEnvSuffix(kbName: string): string {
  return kbName.normalize('NFC').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

function parseAgeBudgetHours(
  raw: string | undefined,
  envVar: string,
): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
    throw new AgeBudgetConfigError(
      envVar,
      raw,
      `${envVar}=${JSON.stringify(raw)} must be a positive integer (hours); ` +
        `unset to disable, or set a value > 0.`,
    );
  }
  return num;
}

/**
 * Resolve the configured age budget for a KB. Resolution order:
 *   1. `KB_AGE_BUDGET_HOURS_<suffix>` where `<suffix>` is the value
 *      from `kbNameToEnvSuffix(kbName)`.
 *   2. `KB_AGE_BUDGET_HOURS` (unsuffixed global fallback).
 *   3. `null` (no budget configured).
 *
 * Throws `AgeBudgetConfigError` when either env var is set to a
 * non-positive-integer value (`0`, `-1`, `12.5`, `abc`, etc.). The
 * caller decides how to surface the error (typically: log + treat as
 * "no budget" for the affected KB, then escalate via `kb doctor`).
 */
export function resolveAgeBudgetHours(
  kbName: string,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const suffix = kbNameToEnvSuffix(kbName);
  const perKbVar = `${ENV_PREFIX}${suffix}`;
  const perKb = parseAgeBudgetHours(env[perKbVar], perKbVar);
  if (perKb !== null) return perKb;
  return parseAgeBudgetHours(env[ENV_DEFAULT], ENV_DEFAULT);
}

export interface AgeBudgetStatus {
  kb: string;
  configuredHours: number | null;
  currentAgeHours: number | null;
  breach: boolean;
}

/**
 * Compute the age-budget status for a KB. `lastIndexAtMs` is the
 * per-KB last-index timestamp in epoch milliseconds (typically derived
 * from sidecar mtimes under `<kb>/.index/`); pass `null` when the KB
 * has never been indexed. `nowMs` defaults to `Date.now()` and is
 * injectable for testing.
 *
 * The "never indexed" case is treated as "no breach" rather than
 * "infinite age" per the issue spec — an empty KB has no observable
 * staleness signal until at least one pass has run.
 */
export function computeAgeBudgetStatus(
  kbName: string,
  lastIndexAtMs: number | null,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): AgeBudgetStatus {
  const configuredHours = resolveAgeBudgetHours(kbName, env);
  if (lastIndexAtMs === null) {
    return { kb: kbName, configuredHours, currentAgeHours: null, breach: false };
  }
  const currentAgeHours = Math.max(0, (nowMs - lastIndexAtMs) / MS_PER_HOUR);
  const breach =
    configuredHours !== null && currentAgeHours > configuredHours;
  return { kb: kbName, configuredHours, currentAgeHours, breach };
}

/**
 * Floor `currentAgeHours` for human-facing display. Returns `null`
 * when the input is null (KB has never been indexed).
 */
export function formatAgeHours(currentAgeHours: number | null): number | null {
  if (currentAgeHours === null) return null;
  return Math.floor(currentAgeHours);
}

/**
 * Format an `AGE_BUDGET_BREACH` row for `kb doctor`. Returns `null`
 * when the KB is not in breach (so callers can `.filter` to keep
 * configured-but-fresh KBs out of the warning surface).
 */
export function formatAgeBudgetBreachRow(
  status: AgeBudgetStatus,
): string | null {
  if (
    !status.breach ||
    status.configuredHours === null ||
    status.currentAgeHours === null
  ) {
    return null;
  }
  const ageH = formatAgeHours(status.currentAgeHours);
  return `AGE_BUDGET_BREACH: kb=${status.kb}, age=${ageH}h, budget=${status.configuredHours}h`;
}
