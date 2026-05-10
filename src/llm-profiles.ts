import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathExists } from './file-utils.js';
import { deriveHealthUrl, normalizeChatEndpoint } from './llm-client.js';

export const LLM_PROFILE_SCHEMA_VERSION = 'kb-llm-profile.v1';

export type LlmProfileMode = 'managed' | 'external';

export interface LlmProfileBase {
  schema_version: typeof LLM_PROFILE_SCHEMA_VERSION;
  name: string;
  mode: LlmProfileMode;
  endpoint: string;
  health_url: string;
}

export interface ExternalLlmProfile extends LlmProfileBase {
  mode: 'external';
  managed_by?: string;
}

export interface ManagedLlmProfile extends LlmProfileBase {
  mode: 'managed';
  unit_name: string;
  runner: 'llama-server';
  runner_bin: string;
  model_path: string;
  port: number;
  ctx?: number;
  ngl?: number;
  extra_args: string[];
  model_fingerprint: {
    path: string;
    size: number;
    mtime_ms: number;
    sha256_prefix?: string;
  };
  keepalive: 'lease' | 'always';
  owner: {
    package: string;
    install_root: string;
    bin_path: string;
  };
  unit_hash: string;
}

export type LlmProfile = ExternalLlmProfile | ManagedLlmProfile;

export interface LlmLease {
  schema_version: 'kb-llm-lease.v1';
  profile: string;
  unit_name: string | null;
  endpoint: string;
  mode: LlmProfileMode;
  cli_version: string;
  bin_path: string;
  install_root: string;
  last_used_at: string;
  keepalive: 'lease' | 'always';
  unit_hash: string | null;
}

export function llmConfigDir(): string {
  return process.env.KB_LLM_CONFIG_DIR
    || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'kb', 'llm');
}

export function llmStateDir(): string {
  return process.env.KB_LLM_STATE_DIR
    || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'kb', 'llm');
}

export function profilesDir(): string {
  return path.join(llmConfigDir(), 'profiles');
}

export function leasesDir(): string {
  return path.join(llmStateDir(), 'leases');
}

export function activeProfilePath(): string {
  return path.join(llmConfigDir(), 'active.txt');
}

export function profilePath(name: string): string {
  assertProfileName(name);
  return path.join(profilesDir(), `${name}.json`);
}

export function leasePath(name: string): string {
  assertProfileName(name);
  return path.join(leasesDir(), `${name}.json`);
}

export function assertProfileName(name: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(`invalid LLM profile name "${name}" (expected letters, numbers, dot, underscore, or dash)`);
  }
}

export async function createExternalProfile(
  name: string,
  endpoint: string,
  managedBy?: string,
): Promise<ExternalLlmProfile> {
  assertProfileName(name);
  const normalized = normalizeChatEndpoint(endpoint);
  return {
    schema_version: LLM_PROFILE_SCHEMA_VERSION,
    name,
    mode: 'external',
    endpoint: normalized,
    health_url: deriveHealthUrl(normalized),
    ...(managedBy ? { managed_by: managedBy } : {}),
  };
}

export async function createManagedProfile(options: {
  name: string;
  runnerBin: string;
  modelPath: string;
  port: number;
  ctx?: number;
  ngl?: number;
  extraArgs?: string[];
  keepalive?: 'lease' | 'always';
  owner?: ManagedLlmProfile['owner'];
  unitHash?: string;
}): Promise<ManagedLlmProfile> {
  assertProfileName(options.name);
  const stat = await fsp.stat(options.modelPath);
  const endpoint = normalizeChatEndpoint(`http://127.0.0.1:${options.port}`);
  return {
    schema_version: LLM_PROFILE_SCHEMA_VERSION,
    name: options.name,
    mode: 'managed',
    endpoint,
    health_url: deriveHealthUrl(endpoint),
    unit_name: managedUnitName(options.name),
    runner: 'llama-server',
    runner_bin: options.runnerBin,
    model_path: options.modelPath,
    port: options.port,
    ...(options.ctx !== undefined ? { ctx: options.ctx } : {}),
    ...(options.ngl !== undefined ? { ngl: options.ngl } : {}),
    extra_args: options.extraArgs ?? [],
    model_fingerprint: {
      path: options.modelPath,
      size: stat.size,
      mtime_ms: stat.mtimeMs,
    },
    keepalive: options.keepalive ?? 'lease',
    owner: options.owner ?? defaultOwner(),
    unit_hash: options.unitHash ?? '',
  };
}

export function managedUnitName(profileName: string): string {
  assertProfileName(profileName);
  return `kb-llm@${profileName}.service`;
}

export async function writeProfile(profile: LlmProfile): Promise<void> {
  await fsp.mkdir(profilesDir(), { recursive: true });
  await writeJsonAtomic(profilePath(profile.name), profile);
}

export async function readProfile(name: string): Promise<LlmProfile | null> {
  try {
    const raw = await fsp.readFile(profilePath(name), 'utf-8');
    return parseProfile(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function listProfiles(): Promise<LlmProfile[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(profilesDir());
  } catch {
    return [];
  }
  const out: LlmProfile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const name = entry.slice(0, -'.json'.length);
    try {
      const profile = await readProfile(name);
      if (profile) out.push(profile);
    } catch {
      // Ignore malformed profiles in list/status; commands that target one
      // profile surface the parse error directly.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function writeActiveProfile(name: string): Promise<void> {
  assertProfileName(name);
  await fsp.mkdir(llmConfigDir(), { recursive: true });
  const target = activeProfilePath();
  const tmp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${name}\n`, 'utf-8');
  await fsp.rename(tmp, target);
}

export async function readActiveProfileName(): Promise<string | null> {
  try {
    const raw = (await fsp.readFile(activeProfilePath(), 'utf-8')).trim();
    if (raw === '') return null;
    assertProfileName(raw);
    return raw;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function resolveProfile(name?: string): Promise<LlmProfile | null> {
  const profileName = name ?? await readActiveProfileName();
  if (!profileName) return null;
  return readProfile(profileName);
}

export async function writeLease(profile: LlmProfile, opts: {
  cliVersion: string;
  binPath: string;
  installRoot: string;
}): Promise<void> {
  await fsp.mkdir(leasesDir(), { recursive: true });
  const lease: LlmLease = {
    schema_version: 'kb-llm-lease.v1',
    profile: profile.name,
    unit_name: profile.mode === 'managed' ? profile.unit_name : null,
    endpoint: profile.endpoint,
    mode: profile.mode,
    cli_version: opts.cliVersion,
    bin_path: opts.binPath,
    install_root: opts.installRoot,
    last_used_at: new Date().toISOString(),
    keepalive: profile.mode === 'managed' ? profile.keepalive : 'lease',
    unit_hash: profile.mode === 'managed' ? profile.unit_hash : null,
  };
  await writeJsonAtomic(leasePath(profile.name), lease);
}

export async function readLease(name: string): Promise<LlmLease | null> {
  try {
    return JSON.parse(await fsp.readFile(leasePath(name), 'utf-8')) as LlmLease;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function removeProfile(name: string): Promise<void> {
  await fsp.rm(profilePath(name), { force: true });
  await fsp.rm(leasePath(name), { force: true });
  const active = await readActiveProfileName().catch(() => null);
  if (active === name) {
    await fsp.rm(activeProfilePath(), { force: true });
  }
}

export async function unmanagedInstallDisappeared(profile: ManagedLlmProfile): Promise<boolean> {
  return !(await pathExists(profile.owner.bin_path)) || !(await pathExists(profile.owner.install_root));
}

function parseProfile(value: unknown): LlmProfile {
  const p = value as Partial<LlmProfile>;
  if (p.schema_version !== LLM_PROFILE_SCHEMA_VERSION) {
    throw new Error('invalid LLM profile schema_version');
  }
  if (typeof p.name !== 'string') throw new Error('invalid LLM profile name');
  assertProfileName(p.name);
  if (p.mode !== 'managed' && p.mode !== 'external') throw new Error('invalid LLM profile mode');
  if (typeof p.endpoint !== 'string') throw new Error('invalid LLM profile endpoint');
  if (typeof p.health_url !== 'string') throw new Error('invalid LLM profile health_url');
  return p as LlmProfile;
}

function defaultOwner(): ManagedLlmProfile['owner'] {
  return {
    package: '@jeanibarz/knowledge-base-mcp-server',
    install_root: process.cwd(),
    bin_path: process.argv[1] ?? 'kb',
  };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  await fsp.rename(tmp, filePath);
}
