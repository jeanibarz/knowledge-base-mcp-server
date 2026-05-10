import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  listProfiles,
  readLease,
  removeProfile,
  type ManagedLlmProfile,
} from './llm-profiles.js';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (cmd: string, args: string[]) => Promise<CommandResult>;

export const defaultCommandRunner: CommandRunner = async (cmd, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { encoding: 'utf-8' });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message,
    };
  }
};

export function systemdUserDir(): string {
  return process.env.KB_LLM_SYSTEMD_USER_DIR
    || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
}

export function renderManagedUnit(profile: ManagedLlmProfile): string {
  const args = [
    profile.runner_bin,
    '-m', profile.model_path,
    '--host', '127.0.0.1',
    '--port', String(profile.port),
    ...(profile.ctx !== undefined ? ['-c', String(profile.ctx)] : []),
    ...(profile.ngl !== undefined ? ['-ngl', String(profile.ngl)] : []),
    ...profile.extra_args,
  ];
  return `[Unit]
Description=knowledge-base CLI local LLM (${profile.name})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${args.map(systemdQuote).join(' ')}
Restart=on-failure
RestartSec=10
TimeoutStartSec=180
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

export function hashUnit(unitText: string): string {
  return crypto.createHash('sha256').update(unitText).digest('hex');
}

export async function installManagedUnit(
  profile: ManagedLlmProfile,
  runner: CommandRunner = defaultCommandRunner,
): Promise<ManagedLlmProfile> {
  const unitWithoutHash = renderManagedUnit({ ...profile, unit_hash: '' });
  const unitHash = hashUnit(unitWithoutHash);
  const finalProfile = { ...profile, unit_hash: unitHash };
  const unitText = renderManagedUnit(finalProfile);
  await fsp.mkdir(systemdUserDir(), { recursive: true });
  await fsp.writeFile(path.join(systemdUserDir(), finalProfile.unit_name), unitText, 'utf-8');
  await assertSystemctl(runner, ['--user', 'daemon-reload']);
  return finalProfile;
}

export async function startManagedUnit(profile: ManagedLlmProfile, runner: CommandRunner = defaultCommandRunner): Promise<void> {
  await assertSystemctl(runner, ['--user', 'start', profile.unit_name]);
}

export async function stopManagedUnit(profile: ManagedLlmProfile, runner: CommandRunner = defaultCommandRunner): Promise<void> {
  await assertSystemctl(runner, ['--user', 'stop', profile.unit_name]);
}

export async function restartManagedUnit(profile: ManagedLlmProfile, runner: CommandRunner = defaultCommandRunner): Promise<void> {
  await assertSystemctl(runner, ['--user', 'restart', profile.unit_name]);
}

export async function disableAndRemoveManagedUnit(
  profile: ManagedLlmProfile,
  runner: CommandRunner = defaultCommandRunner,
): Promise<void> {
  await runner('systemctl', ['--user', 'stop', profile.unit_name]);
  await runner('systemctl', ['--user', 'disable', profile.unit_name]);
  await fsp.rm(path.join(systemdUserDir(), profile.unit_name), { force: true });
  await runner('systemctl', ['--user', 'daemon-reload']);
}

export interface ReapOptions {
  now?: Date;
  ttlMs?: number;
  runner?: CommandRunner;
}

export interface ReapResult {
  stopped: string[];
  skipped: string[];
}

export async function reapManagedProfiles(options: ReapOptions = {}): Promise<ReapResult> {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000;
  const runner = options.runner ?? defaultCommandRunner;
  const stopped: string[] = [];
  const skipped: string[] = [];
  for (const profile of await listProfiles()) {
    if (profile.mode !== 'managed') {
      skipped.push(`${profile.name}: external`);
      continue;
    }
    if (profile.keepalive === 'always') {
      skipped.push(`${profile.name}: keepalive=always`);
      continue;
    }
    const lease = await readLease(profile.name);
    const lastUsed = lease?.last_used_at ? Date.parse(lease.last_used_at) : 0;
    const staleLease = !Number.isFinite(lastUsed) || now.getTime() - lastUsed > ttlMs;
    const installGone = !(await exists(profile.owner.bin_path)) || !(await exists(profile.owner.install_root));
    const unitDrift = lease?.unit_hash !== undefined && lease.unit_hash !== null && lease.unit_hash !== profile.unit_hash;
    if (!staleLease && !installGone && !unitDrift) {
      skipped.push(`${profile.name}: fresh`);
      continue;
    }
    await stopManagedUnit(profile, runner).catch(() => {});
    stopped.push(profile.name);
  }
  return { stopped, skipped };
}

export async function uninstallManagedProfiles(
  names: string[] | 'all',
  runner: CommandRunner = defaultCommandRunner,
): Promise<string[]> {
  const profiles = await listProfiles();
  const selected = profiles.filter((p) => p.mode === 'managed' && (names === 'all' || names.includes(p.name)));
  for (const p of selected) {
    await disableAndRemoveManagedUnit(p as ManagedLlmProfile, runner);
    await removeProfile(p.name);
  }
  return selected.map((p) => p.name);
}

async function assertSystemctl(runner: CommandRunner, args: string[]): Promise<void> {
  const result = await runner('systemctl', args);
  if (result.code !== 0) {
    throw new Error(`systemctl ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

function systemdQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}
