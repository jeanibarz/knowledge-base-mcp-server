import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) {
    throw new Error('Cannot compute a percentile of an empty array');
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return Number(sorted[index].toFixed(3));
}

export function resultFileName(prefix: string, provider: string): string {
  return `${prefix}-${provider}-${nodeMajorLabel(process.version)}-${os.platform()}-${os.arch()}.json`;
}

export function nodeMajorLabel(nodeVersion: string): string {
  const match = /^v(\d+)/.exec(nodeVersion);
  return `node${match?.[1] ?? 'unknown'}`;
}

export async function resetDirectory(directoryPath: string): Promise<void> {
  await fsp.rm(directoryPath, { force: true, recursive: true });
  await fsp.mkdir(directoryPath, { recursive: true });
}

export async function ensureDirectory(directoryPath: string): Promise<void> {
  await fsp.mkdir(directoryPath, { recursive: true });
}

export async function gitSha(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: repoRoot,
  });
  return stdout.trim();
}

export function durationMs(start: bigint, end: bigint): number {
  return Number(end - start) / 1_000_000;
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDirectory(path.dirname(filePath));
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

export async function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
