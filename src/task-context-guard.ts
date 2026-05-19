// Issue #412 — strict and warning modes for untrusted relevance-gate task
// context.
//
// The relevance gate (`src/relevance-gate.ts`, RFC 018 §10) takes an optional
// `task_context` string and concatenates it into an LLM judge prompt — a
// trust-boundary input. `kb search` accepts that text through `--task-context`
// (argv) and `--task-context-file` (a file path). Argv is the riskier surface:
// prompt-like text on the command line is exposed in `ps` output, shell
// history, and process hooks, so prior KB notes recommend preferring a file.
//
// This module is a small, pure input-boundary policy applied by `kb search`
// before the gate runs. It does not change retrieval or the JSON contract — it
// only emits stderr advisories (`warn`) and, in `strict` mode, refuses task
// context that carries known prompt-injection signals.
//
// Design contract:
//   * Pure. No I/O, no global state. The same input yields the same result.
//   * Reuses the ADR 0006 injection-guard detector (`detectInjectionSignals`)
//     that the gate already runs over `task_context` — no new ruleset.
//   * Off by opt-out: `KB_GATE_TASK_CONTEXT_MODE=off` restores the exact
//     prior behaviour (no warnings, no refusal).

import { detectInjectionSignals, type InjectionSignal } from './injection-guard.js';

/**
 * Policy applied to task context handed to the relevance gate:
 *   * `off`    — no inspection (exact pre-#412 behaviour).
 *   * `warn`   — emit stderr advisories; never change the exit code (default).
 *   * `strict` — additionally refuse task context carrying injection signals.
 */
export type TaskContextPolicyMode = 'off' | 'warn' | 'strict';

/** Where `kb search` obtained the task context. */
export type TaskContextSource = 'argv' | 'file';

/** Default `KB_GATE_TASK_CONTEXT_ARGV_MAX` — argv task context above this many
 * characters is flagged as prompt-like and better passed via a file. */
export const DEFAULT_TASK_CONTEXT_ARGV_MAX = 600;

export interface TaskContextInspection {
  /** Non-fatal advisories. Printed to stderr in `warn` and `strict` modes. */
  warnings: string[];
  /** ADR 0006 injection-guard signals found in the task context. */
  injectionSignals: InjectionSignal[];
  /** True when `strict` mode rejects this task context. */
  refused: boolean;
  /** One-line operator-facing reason, populated only when `refused`. */
  refuseReason: string | null;
}

/**
 * Reads `KB_GATE_TASK_CONTEXT_MODE`. Unrecognised or unset values fall back to
 * `warn` so the advisories are on by default; `off` is an explicit opt-out.
 */
export function resolveTaskContextPolicyMode(
  env: NodeJS.ProcessEnv = process.env,
): TaskContextPolicyMode {
  const normalized = env.KB_GATE_TASK_CONTEXT_MODE?.trim().toLowerCase();
  if (normalized === 'off' || normalized === 'warn' || normalized === 'strict') {
    return normalized;
  }
  return 'warn';
}

/**
 * Reads `KB_GATE_TASK_CONTEXT_ARGV_MAX`. Non-positive or non-integer values
 * fall back to {@link DEFAULT_TASK_CONTEXT_ARGV_MAX}.
 */
export function resolveTaskContextArgvMax(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.KB_GATE_TASK_CONTEXT_ARGV_MAX;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TASK_CONTEXT_ARGV_MAX;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_TASK_CONTEXT_ARGV_MAX;
}

/** Distinct injection-signal kinds, sorted, for stable messages. */
function describeSignalKinds(signals: InjectionSignal[]): string {
  return Array.from(new Set(signals.map((signal) => signal.kind))).sort().join(', ');
}

/**
 * Inspects task context against the configured policy. Pure: the result is a
 * function of `(text, source, mode, argvMax)` alone. `kb search` prints
 * `warnings` to stderr and, when `refused`, prints `refuseReason` and exits 2.
 */
export function inspectTaskContext(input: {
  text: string;
  source: TaskContextSource;
  mode: TaskContextPolicyMode;
  argvMax?: number;
}): TaskContextInspection {
  const empty: TaskContextInspection = {
    warnings: [],
    injectionSignals: [],
    refused: false,
    refuseReason: null,
  };
  if (input.mode === 'off' || input.text.trim() === '') return empty;

  const argvMax = input.argvMax ?? DEFAULT_TASK_CONTEXT_ARGV_MAX;
  const injectionSignals = detectInjectionSignals(input.text);
  const warnings: string[] = [];

  // Argv exposure: large or multi-line `--task-context` is prompt-like and
  // leaks into `ps`, shell history, and process hooks. Recommend a file.
  if (input.source === 'argv') {
    const triggers: string[] = [];
    if (input.text.length > argvMax) {
      triggers.push(`${input.text.length} chars (over the ${argvMax}-char argv limit)`);
    }
    if (/[\r\n]/.test(input.text)) {
      triggers.push('multi-line');
    }
    if (triggers.length > 0) {
      warnings.push(
        `task context passed via --task-context is ${triggers.join(' and ')}; ` +
          'prefer --task-context-file=<path> so prompt-like text is not exposed in ' +
          "process arguments (visible via 'ps', shell history, and process hooks)",
      );
    }
  }

  // Injection signals are high-risk. `strict` refuses; `warn` advises. The
  // refusal supersedes the advisory, so they are never both emitted.
  if (injectionSignals.length > 0) {
    const kinds = describeSignalKinds(injectionSignals);
    if (input.mode === 'strict') {
      return {
        warnings,
        injectionSignals,
        refused: true,
        refuseReason:
          `task context contains prompt-injection signals (${kinds}) and ` +
          'KB_GATE_TASK_CONTEXT_MODE=strict refuses it; supply a reviewed task ' +
          'context or set KB_GATE_TASK_CONTEXT_MODE=warn to downgrade this to a warning',
      };
    }
    warnings.push(
      `task context contains prompt-injection signals (${kinds}); the relevance ` +
        'judge treats task context as data, but verify the source is trusted',
    );
  }

  return { warnings, injectionSignals, refused: false, refuseReason: null };
}
