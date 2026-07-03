import { execFileSync } from 'child_process';
import { existsSync, readFileSync, realpathSync } from 'fs';
import * as path from 'path';

export interface BuildInfo {
  version: string;
  commit: string;
}

const BUILD_COMMIT_ENV_KEYS = [
  'KB_BUILD_COMMIT',
  'SOURCE_VERSION',
  'GIT_COMMIT',
] as const;
const PACKAGE_NAME = '@jeanibarz/knowledge-base-mcp-server';

export function readBuildInfo(packageRoot: string = resolvePackageRoot()): BuildInfo {
  return {
    version: readPackageVersion(packageRoot),
    commit: resolveBuildCommit(packageRoot),
  };
}

export function readPackageVersion(packageRoot: string = resolvePackageRoot()): string {
  try {
    const raw = readFileSync(path.join(packageRoot, 'package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.trim() !== ''
      ? parsed.version
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function resolveBuildCommit(packageRoot: string = resolvePackageRoot()): string {
  for (const key of BUILD_COMMIT_ENV_KEYS) {
    const value = normalizeCommit(process.env[key]);
    if (value !== null) return value;
  }

  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: packageRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
  } catch {
    return 'unknown';
  }
}

export function resolvePackageRoot(invokedPath: string | undefined = process.argv[1]): string {
  if (invokedPath !== undefined) {
    try {
      const root = findPackageRoot(path.dirname(realpathSync(invokedPath)));
      if (root !== null) return root;
    } catch {
      // Fall through to the current working directory lookup below.
    }
  }

  return findPackageRoot(process.cwd()) ?? process.cwd();
}

function normalizeCommit(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === '') return null;
  return /^[0-9a-f]{7,40}$/i.test(trimmed) ? trimmed : 'unknown';
}

function findPackageRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    const pkgPath = path.join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: unknown };
        if (parsed.name === PACKAGE_NAME) return dir;
      } catch {
        // Keep walking; an unreadable package file should not hide a parent match.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
