// Issue #759 — opt-out, TTY-only progress indicator for long-running CLI
// commands (`kb reindex --with-context`, `kb ask`).
//
// Both commands can run for many seconds — a whole-corpus rebuild or an LLM
// generation — while emitting nothing until they finish, so the user cannot
// tell whether the process is working or hung. This renders a lightweight
// spinner + elapsed clock to stderr while the slow work runs, then erases it
// before any real output prints.
//
// Suppression rules (mirroring `src/color.ts`, so a piped or scripted
// invocation is byte-identical to before this feature existed):
//   - never when the target stream is not a TTY (piped / redirected output);
//   - never for `--format=json` output;
//   - honor NO_COLOR / `--color` / `KB_COLOR` via the shared color resolver.
//
// The renderer writes ONLY to its stderr stream and clears its own line on
// stop, so it can never corrupt stdout (the JSON / markdown answer) or piped
// output. Every method is a no-op when disabled.

import { resolveColorEnabled, type ColorMode } from './color.js';

// Braille spinner frames — the widely-used cli-spinners "dots" set. Single
// display-width glyphs so the `\r`-rewrite stays on one column.
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const DEFAULT_INTERVAL_MS = 100;

// Carriage-return + erase-to-end-of-line: return to column 0 and clear the
// previously-rendered frame so the next frame (or the caller's output) starts
// from a clean line.
const CLEAR_LINE = '\r\x1b[K';

interface Scheduler {
  set: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clear: (handle: ReturnType<typeof setInterval>) => void;
}

export interface TtyProgressOptions {
  /** Human label rendered before the spinner + elapsed clock. */
  label: string;
  /** When false, every method is a no-op (nothing is ever written). */
  enabled: boolean;
  /** Frame sink. Defaults to `process.stderr.write`. Tests pass a capture. */
  write?: (text: string) => void;
  /** Monotonic-ish clock for the elapsed counter. Defaults to `Date.now`. */
  now?: () => number;
  /** Frame cadence in milliseconds. Defaults to 100ms. */
  intervalMs?: number;
  /** Timer seam. Defaults to global `setInterval`/`clearInterval`. */
  scheduler?: Scheduler;
}

/**
 * A minimal start/tick/stop spinner. Construct it via {@link createTtyProgress}
 * so enablement is resolved consistently; the class is exported for tests that
 * want to drive frames deterministically.
 */
export class TtyProgress {
  private readonly label: string;
  private readonly enabled: boolean;
  private readonly write: (text: string) => void;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly scheduler: Scheduler;

  private frame = 0;
  private startedAtMs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;

  constructor(options: TtyProgressOptions) {
    this.label = options.label;
    this.enabled = options.enabled;
    this.write = options.write ?? ((text) => void process.stderr.write(text));
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.scheduler = options.scheduler ?? {
      set: (cb, ms) => setInterval(cb, ms),
      clear: (handle) => clearInterval(handle),
    };
  }

  /** Begin animating. No-op when disabled or already running. */
  start(): void {
    if (!this.enabled || this.active) return;
    this.active = true;
    this.startedAtMs = this.now();
    this.render();
    // Guard the timer callback on `active` too: a stale fire that races a
    // `stop()` (or a test scheduler that ignores `clear`) must not repaint the
    // line after it was erased.
    this.timer = this.scheduler.set(() => {
      if (this.active) this.render();
    }, this.intervalMs);
    // Never keep the process alive just for the spinner — the awaited work
    // owns the event loop; the spinner is decoration on top of it.
    const timer = this.timer as unknown as { unref?: () => void };
    if (typeof timer.unref === 'function') timer.unref();
  }

  /** Render the next frame immediately. No-op when disabled or stopped. */
  tick(): void {
    if (!this.enabled || !this.active) return;
    this.render();
  }

  /** Erase the spinner line and stop animating. Idempotent; safe to call
   * before any stdout/stderr write so real output starts on a clean line. */
  stop(): void {
    if (!this.enabled || !this.active) return;
    if (this.timer !== null) {
      this.scheduler.clear(this.timer);
      this.timer = null;
    }
    this.active = false;
    this.write(CLEAR_LINE);
  }

  private render(): void {
    const elapsedS = Math.floor((this.now() - this.startedAtMs) / 1000);
    const glyph = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
    this.frame += 1;
    this.write(`${CLEAR_LINE}${glyph} ${this.label} (${elapsedS}s)`);
  }
}

export interface TtyProgressResolveInput {
  /** Human label rendered before the spinner + elapsed clock. */
  label: string;
  /** Output format of the command; `json` always suppresses the spinner. */
  format?: 'md' | 'json';
  /** Target stream. Defaults to `process.stderr`. */
  stream?: Pick<NodeJS.WriteStream, 'isTTY' | 'write'>;
  /** Explicit `--color` mode when the command parses one. */
  colorFlag?: ColorMode;
  /** Environment for NO_COLOR / KB_COLOR resolution. Defaults to process env. */
  env?: NodeJS.ProcessEnv;
  /** Clock seam forwarded to {@link TtyProgress}. */
  now?: () => number;
}

/**
 * Decide whether a progress spinner should render. The stream must be a TTY
 * (a hard gate — even `--color=always` must not spray ANSI into a pipe), the
 * format must not be `json`, and color must be enabled per the shared
 * precedence rule in `src/color.ts` (which honors NO_COLOR / KB_COLOR).
 */
export function ttyProgressEnabled(input: TtyProgressResolveInput): boolean {
  if (input.format === 'json') return false;
  const stream = input.stream ?? process.stderr;
  if (!stream.isTTY) return false;
  return resolveColorEnabled({
    ...(input.colorFlag !== undefined ? { flag: input.colorFlag } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    isTTY: true,
  });
}

/**
 * Build a {@link TtyProgress} whose enablement is resolved from the stream,
 * format, and color settings. When suppressed, the returned instance is an
 * inert no-op — callers can unconditionally `start()`/`stop()` it.
 */
export function createTtyProgress(input: TtyProgressResolveInput): TtyProgress {
  const stream = input.stream ?? process.stderr;
  return new TtyProgress({
    label: input.label,
    enabled: ttyProgressEnabled(input),
    write: (text) => void stream.write(text),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
}
