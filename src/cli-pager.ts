import { spawn } from 'child_process';
import { constants as fsConstants } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { Writable } from 'stream';

export type PagerFlag = boolean | null;

export interface SearchPagerOptions {
  flag: PagerFlag;
  format: 'md' | 'compact' | 'json' | 'vimgrep';
  env?: NodeJS.ProcessEnv;
  stdoutIsTTY?: boolean;
  stdout?: Writable;
  stderr?: Writable;
  capturePagerStdout?: boolean;
  /** Overrides `process.platform`; lets the Windows lookup rules be tested anywhere. */
  platform?: NodeJS.Platform;
}

export interface PagerResolution {
  command: string;
  args: string[];
}

const DEFAULT_PAGER = 'less -R';
/**
 * Windows rarely has `less`, but `%SystemRoot%\System32\more.com` ships with
 * every install and System32 is always on PATH, so it is a dependency-free
 * default of last resort. Only used when the operator configured no pager of
 * their own -- an explicit KB_PAGER/PAGER is never silently substituted.
 */
const WINDOWS_FALLBACK_PAGER = 'more';
/** What cmd.exe assumes when PATHEXT is unset. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const DISABLED_PAGER_VALUES = new Set(['', '0', 'false', 'off', 'none', 'no']);

interface PagerLookup {
  pager: PagerResolution | null;
  /**
   * Pager command lines actually probed on PATH. Empty when paging was never
   * eligible (structured format, no TTY, --no-pager, `cat`, ...), which is how
   * callers tell "operator asked for a pager we could not find" -- worth a
   * warning -- from "paging simply does not apply here".
   */
  tried: string[];
}

export async function writeMaybePagedOutput(
  output: string,
  options: SearchPagerOptions,
): Promise<void> {
  const stdout: Writable = options.stdout ?? process.stdout;
  const { pager, tried } = await lookupSearchPager(options);
  if (pager === null) {
    if (tried.length > 0) warnPagerUnavailable(tried, options);
    writeChunk(stdout, output);
    return;
  }

  const usedPager = await writeToPager(output, pager, options);
  if (!usedPager) {
    writeChunk(stdout, output);
  }
}

/** Silent probe: resolves the pager to use, or null to write output directly. */
export async function resolveSearchPager(
  options: SearchPagerOptions,
): Promise<PagerResolution | null> {
  return (await lookupSearchPager(options)).pager;
}

async function lookupSearchPager(options: SearchPagerOptions): Promise<PagerLookup> {
  const direct: PagerLookup = { pager: null, tried: [] };
  if (options.format !== 'md' && options.format !== 'compact') return direct;
  if (options.flag === false) return direct;

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY === true;
  if (!stdoutIsTTY) return direct;
  if (env.TERM === 'dumb') return direct;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return direct;

  const kbPager = env.KB_PAGER;
  const envEnabled = kbPager !== undefined && kbPager.trim() !== '';
  if (options.flag !== true && !envEnabled) return direct;

  const configured = envEnabled
    ? kbPager
    : (env.PAGER !== undefined && env.PAGER.trim() !== '' ? env.PAGER : undefined);
  if (configured !== undefined && isPagerDisabledValue(configured)) return direct;

  const tried: string[] = [];
  for (const candidate of pagerCandidates(configured, platform)) {
    const argv = splitPagerCommand(candidate);
    if (argv.length === 0) continue;
    const [command, ...args] = argv;
    // `cat` is the conventional way to say "never page"; not a missing binary.
    if (isCatPager(command)) return direct;
    tried.push(candidate);
    if (await commandExists(command, env, platform)) return { pager: { command, args }, tried };
  }
  return { pager: null, tried };
}

/**
 * The pager command lines to try, best first. An operator-configured pager is
 * the only candidate -- we never quietly run something they did not ask for.
 */
function pagerCandidates(
  configured: string | undefined,
  platform: NodeJS.Platform,
): string[] {
  if (configured !== undefined) return [configured];
  return platform === 'win32' ? [DEFAULT_PAGER, WINDOWS_FALLBACK_PAGER] : [DEFAULT_PAGER];
}

export function buildDaemonSearchArgs(args: readonly string[]): string[] {
  const out = args.filter((arg) => arg !== '--pager' && arg !== '--no-pager');
  out.push('--no-pager');
  return out;
}

async function writeToPager(
  output: string,
  pager: PagerResolution,
  options: SearchPagerOptions,
): Promise<boolean> {
  const stderr = options.stderr ?? process.stderr;
  const stdout: Writable = options.stdout ?? process.stdout;
  const child = spawn(pager.command, pager.args, {
    stdio: ['pipe', options.capturePagerStdout ? 'pipe' : stdout, stderr],
  });

  if (child.stdout) {
    child.stdout.on('data', (chunk) => {
      writeChunk(stdout, chunk);
    });
  }

  let spawnFailed = false;
  child.on('error', () => {
    spawnFailed = true;
  });

  await Promise.all([
    new Promise<void>((resolve) => {
      if (child.stdin === null) {
        resolve();
        return;
      }
      child.stdin.on('error', () => resolve());
      child.stdin.end(output, () => resolve());
    }),
    new Promise<void>((resolve) => {
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    }),
  ]);

  return !spawnFailed;
}

function writeChunk(stream: Writable, chunk: string | Buffer): void {
  stream.write(chunk);
}

function isPagerDisabledValue(value: string): boolean {
  return DISABLED_PAGER_VALUES.has(value.trim().toLowerCase());
}

function isCatPager(command: string): boolean {
  return path.basename(command).toLowerCase() === 'cat';
}

function splitPagerCommand(commandLine: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of commandLine.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      if (current !== '') {
        out.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += '\\';
  if (current !== '') out.push(current);
  return out;
}

async function commandExists(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (containsPathSeparator(command, platform)) {
    return anyExecutable(command, env, platform);
  }
  // `Path` is the canonical spelling on Windows; process.env lookups there are
  // case-insensitive, but an injected plain object is not.
  const pathEnv = env.PATH ?? env.Path ?? process.env.PATH ?? '';
  for (const dir of pathEnv.split(platform === 'win32' ? ';' : ':')) {
    // cmd.exe tolerates quoted PATH entries; strip them before joining.
    const trimmed = platform === 'win32' ? dir.replace(/^"(.*)"$/, '$1') : dir;
    if (trimmed === '') continue;
    if (await anyExecutable(path.join(trimmed, command), env, platform)) return true;
  }
  return false;
}

async function anyExecutable(
  base: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<boolean> {
  for (const candidate of executableCandidates(base, env, platform)) {
    if (await isExecutable(candidate, platform)) return true;
  }
  return false;
}

/**
 * Filenames to probe for a command. On POSIX that is the name itself; on
 * Windows a bare `less` on PATH is really `less.exe`, and which suffixes count
 * is spelled out by PATHEXT. Probing only the extensionless name is why
 * --pager and KB_PAGER were silent no-ops on Windows (#934). The bare name
 * stays first so an already-qualified `less.exe` -- or an extensionless script
 * under a POSIX-ish shell -- still matches.
 */
function executableCandidates(
  base: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  if (platform !== 'win32') return [base];
  const raw = env.PATHEXT ?? process.env.PATHEXT ?? DEFAULT_PATHEXT;
  const suffixes = raw
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext !== '')
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));
  // PATHEXT is spelled upper-case by convention while the files on disk are
  // lower-case; that only lines up for free on a case-insensitive volume, so
  // probe both spellings. Order is preserved, so .COM still beats .EXE.
  const spellings = [...new Set(suffixes.flatMap((ext) => [ext, ext.toLowerCase()]))];
  return [base, ...spellings.map((ext) => `${base}${ext}`)];
}

function containsPathSeparator(command: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32'
    ? command.includes('\\') || command.includes('/')
    : command.includes('/');
}

async function isExecutable(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    // stat, not access: a *directory* named `less` satisfies access(X_OK) on
    // POSIX (search permission) and F_OK on Windows.
    if (!(await fsp.stat(file)).isFile()) return false;
  } catch {
    return false;
  }
  // Windows has no POSIX execute bit; Node maps X_OK to a bare existence check
  // there, so the extension match above is the real test.
  if (platform === 'win32') return true;
  try {
    await fsp.access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The operator explicitly asked for paging and we found nothing to page with.
 * Saying so turns a flag that looks broken into one that is merely unsupported
 * here -- the actual complaint behind #934.
 */
function warnPagerUnavailable(tried: readonly string[], options: SearchPagerOptions): void {
  const stderr: Writable = options.stderr ?? process.stderr;
  stderr.write(
    `kb: no pager found on PATH (tried ${tried.map((c) => `"${c}"`).join(', ')}); `
    + 'wrote output directly. Set KB_PAGER to choose one.\n',
  );
}
