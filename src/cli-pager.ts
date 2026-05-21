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
}

export interface PagerResolution {
  command: string;
  args: string[];
}

const DEFAULT_PAGER = 'less -R';
const DISABLED_PAGER_VALUES = new Set(['', '0', 'false', 'off', 'none', 'no']);

export async function writeMaybePagedOutput(
  output: string,
  options: SearchPagerOptions,
): Promise<void> {
  const stdout: Writable = options.stdout ?? process.stdout;
  const pager = await resolveSearchPager(options);
  if (pager === null) {
    writeChunk(stdout, output);
    return;
  }

  const usedPager = await writeToPager(output, pager, options);
  if (!usedPager) {
    writeChunk(stdout, output);
  }
}

export async function resolveSearchPager(
  options: SearchPagerOptions,
): Promise<PagerResolution | null> {
  if (options.format !== 'md' && options.format !== 'compact') return null;
  if (options.flag === false) return null;

  const env = options.env ?? process.env;
  const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY === true;
  if (!stdoutIsTTY) return null;
  if (env.TERM === 'dumb') return null;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return null;

  const kbPager = env.KB_PAGER;
  const envEnabled = kbPager !== undefined && kbPager.trim() !== '';
  if (options.flag !== true && !envEnabled) return null;

  const raw = (envEnabled ? kbPager : (env.PAGER && env.PAGER.trim() !== '' ? env.PAGER : DEFAULT_PAGER)) ?? DEFAULT_PAGER;
  if (isPagerDisabledValue(raw)) return null;

  const argv = splitPagerCommand(raw);
  if (argv.length === 0) return null;
  const [command, ...args] = argv;
  if (isCatPager(command)) return null;
  if (!(await commandExists(command, env))) return null;
  return { command, args };
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

async function commandExists(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (command.includes(path.sep)) {
    return isExecutable(command);
  }
  const pathEnv = env.PATH ?? process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir === '') continue;
    if (await isExecutable(path.join(dir, command))) return true;
  }
  return false;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await fsp.access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
