// Issue #659 — single color-control resolver for all ANSI output.
//
// One precedence rule governs every ANSI emitter (the formatter's query-term
// highlighting / bold) so color is predictable and standards compliant instead
// of each feature deciding on its own ad-hoc TTY check.
//
// Precedence, highest first:
//   1. An explicit `--color=always|never` flag — a per-invocation override that
//      beats everything, including NO_COLOR. The NO_COLOR standard explicitly
//      permits command-line options to re-enable color.
//   2. The NO_COLOR environment standard (https://no-color.org): when set to a
//      non-empty value, ANSI color is disabled.
//   3. `KB_COLOR=auto|always|never` — an app-level default in env form, weaker
//      than both the flag and the NO_COLOR standard.
//   4. `auto` (the default, and what `--color=auto` / `KB_COLOR=auto` request):
//      colorize only when the target stream is a TTY.

export type ColorMode = 'auto' | 'always' | 'never';

export const KB_COLOR_ENV = 'KB_COLOR';

/** Shared ANSI emphasis codes — the single home for the bold escape sequence. */
export const ANSI_BOLD = '\x1b[1m';
export const ANSI_BOLD_OFF = '\x1b[22m';

/**
 * Validates a `--color` value, throwing a flag-shaped error on anything other
 * than the three accepted modes so the CLI can report it like its peers.
 */
export function parseColorMode(value: string, flagName = '--color'): ColorMode {
  if (value === 'auto' || value === 'always' || value === 'never') return value;
  throw new Error(`invalid ${flagName}: ${value} (expected 'auto', 'always', or 'never')`);
}

export interface ColorDecisionInput {
  /** Mode from an explicit `--color` flag; `undefined` when the flag is absent. */
  flag?: ColorMode;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
}

/**
 * NO_COLOR is honored when present and non-empty. The no-color.org FAQ treats an
 * empty string as "unset", which also matches how a user clears the variable
 * with `NO_COLOR=`.
 */
export function isNoColorSet(env: NodeJS.ProcessEnv): boolean {
  const value = env.NO_COLOR;
  return value !== undefined && value !== '';
}

/**
 * Reads `KB_COLOR` as a `ColorMode`. An unset, empty, or unrecognized value
 * yields `undefined` so a typo degrades to the default rather than crashing a
 * search.
 */
export function readKbColorMode(env: NodeJS.ProcessEnv): ColorMode | undefined {
  const raw = env[KB_COLOR_ENV];
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'always' || normalized === 'never') {
    return normalized;
  }
  return undefined;
}

/**
 * Resolves whether ANSI color should be emitted, applying the precedence rule
 * documented at the top of this module. This is the single decision every ANSI
 * emitter should route through.
 */
export function resolveColorEnabled(input: ColorDecisionInput = {}): boolean {
  const env = input.env ?? process.env;
  const isTTY = input.isTTY ?? false;

  // 1. An explicit `--color` flag is authoritative — it overrides NO_COLOR and
  //    the KB_COLOR default. `auto` means "auto-detect" and skips KB_COLOR.
  if (input.flag === 'always') return true;
  if (input.flag === 'never') return false;
  if (input.flag === 'auto') return autoColorEnabled(env, isTTY);

  // 2. No `--color` flag: the NO_COLOR standard wins over the KB_COLOR default.
  if (isNoColorSet(env)) return false;

  // 3. KB_COLOR app-level default.
  const kbColor = readKbColorMode(env);
  if (kbColor === 'always') return true;
  if (kbColor === 'never') return false;

  // 4. `auto` (KB_COLOR=auto or unset): TTY only.
  return isTTY;
}

/** `auto` resolution: honor NO_COLOR, otherwise colorize only on a TTY. */
function autoColorEnabled(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (isNoColorSet(env)) return false;
  return isTTY;
}
