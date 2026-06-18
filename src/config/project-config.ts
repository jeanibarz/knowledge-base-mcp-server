import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import yaml from 'js-yaml';

export const PROJECT_CONFIG_FILE_NAMES = [
  '.kbrc',
  '.kbrc.json',
  'kb.config.yaml',
  'kb.config.yml',
  'kb.config.json',
] as const;

export interface ProjectConfigLoadResult {
  path: string | null;
  env: Record<string, string>;
  overriddenByEnv: string[];
}

export class ProjectConfigError extends Error {
  readonly file: string;
  readonly key?: string;

  constructor(file: string, message: string, key?: string) {
    super(`invalid project config ${file}${key === undefined ? '' : ` (${key})`}: ${message}`);
    this.name = 'ProjectConfigError';
    this.file = file;
    this.key = key;
  }
}

let cached: ProjectConfigLoadResult | null = null;
let injectedKeys = new Set<string>();

export function loadProjectConfig(cwd = process.cwd()): ProjectConfigLoadResult {
  const configPath = findProjectConfig(cwd);
  if (configPath === null) {
    return { path: null, env: {}, overriddenByEnv: [] };
  }
  const env = readProjectConfigEnv(configPath);
  const overriddenByEnv = Object.keys(env).filter((name) => process.env[name] !== undefined);
  return { path: configPath, env, overriddenByEnv };
}

export function getProjectConfig(): ProjectConfigLoadResult {
  if (cached === null) {
    cached = loadProjectConfig();
    applyProjectConfigDefaults(cached);
  }
  return cached;
}

export function initializeProjectConfig(): void {
  try {
    getProjectConfig();
  } catch {
    // Import-time bootstrap must not break --help or explicit --file validation.
    // Commands that inspect runtime config call getProjectConfig() directly and
    // surface the parse error with command context.
  }
}

export function projectConfigAppliedSources(
  config = getProjectConfig(),
): Record<string, 'file'> {
  const overridden = new Set(config.overriddenByEnv);
  return Object.fromEntries(
    Object.keys(config.env)
      .filter((name) => !overridden.has(name))
      .map((name) => [name, 'file' as const]),
  );
}

export function applyProjectConfigDefaults(config = getProjectConfig()): void {
  for (const [name, value] of Object.entries(config.env)) {
    if (process.env[name] !== undefined) continue;
    process.env[name] = value;
    injectedKeys.add(name);
  }
}

export function resetProjectConfigForTests(): void {
  for (const name of injectedKeys) {
    delete process.env[name];
  }
  injectedKeys = new Set<string>();
  cached = null;
}

export function findProjectConfig(cwd = process.cwd()): string | null {
  for (const dir of parentDirs(path.resolve(cwd))) {
    const found = firstExistingConfigFile(dir, PROJECT_CONFIG_FILE_NAMES);
    if (found !== null) return found;
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return firstExistingConfigFile(path.join(xdgConfigHome, 'kb'), [
    'kb.config.yaml',
    'kb.config.yml',
    'kb.config.json',
    '.kbrc',
    '.kbrc.json',
  ]);
}

function firstExistingConfigFile(dir: string, names: readonly string[]): string | null {
  for (const name of names) {
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return null;
}

function parentDirs(start: string): string[] {
  const dirs: string[] = [];
  let current = start;
  while (true) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
}

function readProjectConfigEnv(file: string): Record<string, string> {
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    parsed = file.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw);
  } catch (err) {
    throw new ProjectConfigError(file, (err as Error).message);
  }

  if (!isPlainObject(parsed)) {
    throw new ProjectConfigError(file, 'expected a top-level object');
  }

  const source = isPlainObject(parsed.env) ? parsed.env : parsed;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new ProjectConfigError(file, 'expected environment-style uppercase keys', key);
    }
    if (typeof value === 'string') {
      env[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      env[key] = String(value);
    } else {
      throw new ProjectConfigError(file, 'expected a string, number, or boolean value', key);
    }
  }
  return env;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
