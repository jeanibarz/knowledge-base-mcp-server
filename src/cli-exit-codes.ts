// Centralized `kb` CLI exit-code taxonomy (issue #733).
//
// Historically exit codes were ad-hoc: most commands collapsed every failure to
// `1`, the top-level `kb --help` documented a 0/1/2/3 scheme in prose, and
// `src/cli.ts` regex-parsed those codes back out of the help text to build its
// JSON help manifest. That let the runtime literals and the documented codes
// drift apart.
//
// This module is the single source of truth. The runtime references the named
// constants, and both the top-level help prose and the help manifest are
// rendered from `EXIT` / `EXIT_DESCRIPTIONS` here — so adding or changing a code
// is a one-line edit that stays consistent everywhere by construction.
//
// Backward compatibility: `0` (success) and `1` (generic/internal failure) keep
// their historical meanings. Codes `2`-`5` name the failure classes callers in
// scripts and CI gates want to branch on without scraping stderr.

/**
 * Frozen map of exit-code names to their numeric values.
 *
 * Semantic meanings:
 * - `OK` (0)                  — success (results found or empty).
 * - `INTERNAL` (1)            — generic runtime / index error (the catch-all).
 * - `USAGE` (2)               — bad argv / env / model-resolution.
 * - `CONFIG` (3)              — missing or invalid environment / configuration.
 * - `NO_RESULTS` (4)          — the operation ran but produced no matching results.
 * - `BACKEND_UNAVAILABLE` (5) — a transient / retryable backend was unreachable.
 */
export const EXIT = Object.freeze({
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  CONFIG: 3,
  NO_RESULTS: 4,
  BACKEND_UNAVAILABLE: 5,
} as const);

export type ExitCodeName = keyof typeof EXIT;
export type ExitCode = (typeof EXIT)[ExitCodeName];

/**
 * Human-readable descriptions for each exit code. Kept alongside `EXIT` so the
 * help prose and the JSON manifest render from one source and cannot drift.
 */
export const EXIT_DESCRIPTIONS: Readonly<Record<ExitCodeName, string>> = Object.freeze({
  OK: 'success (results found or empty)',
  INTERNAL: 'runtime / index error',
  USAGE: 'argv / env / model-resolution error',
  CONFIG: 'configuration error (missing or invalid environment / config)',
  NO_RESULTS: 'no matching results',
  BACKEND_UNAVAILABLE: 'backend unavailable (transient / retryable)',
});

export interface ExitCodeDoc {
  code: number;
  description: string;
}

/**
 * The taxonomy as ordered `{ code, description }` entries (ascending by code).
 * Consumed by the top-level help manifest and the help-prose renderer.
 */
export function exitCodeDocs(): ExitCodeDoc[] {
  return (Object.keys(EXIT) as ExitCodeName[])
    .map((name) => ({ code: EXIT[name], description: EXIT_DESCRIPTIONS[name] }))
    .sort((a, b) => a.code - b.code);
}

/**
 * Render the taxonomy as the indented body of the top-level `Exit codes:`
 * help section (without the heading), aligning the numeric codes.
 */
export function formatExitCodesHelp(): string {
  const docs = exitCodeDocs();
  const width = docs.reduce((max, doc) => Math.max(max, String(doc.code).length), 0);
  return docs
    .map((doc) => `  ${String(doc.code).padStart(width)}   ${doc.description}`)
    .join('\n');
}
