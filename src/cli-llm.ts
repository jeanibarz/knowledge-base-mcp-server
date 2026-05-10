import {
  probeLlmEndpoint,
} from './llm-client.js';
import {
  createExternalProfile,
  createManagedProfile,
  listProfiles,
  readProfile,
  removeProfile,
  writeActiveProfile,
  writeProfile,
  type ManagedLlmProfile,
} from './llm-profiles.js';
import {
  installManagedUnit,
  reapManagedProfiles,
  restartManagedUnit,
  startManagedUnit,
  stopManagedUnit,
  uninstallManagedProfiles,
} from './llm-service.js';

export const LLM_HELP = `kb llm — manage local LLM endpoints for kb ask

Usage:
  kb llm status [--profile=<name>] [--format=md|json]
  kb llm probe [--endpoint=<url>]
  kb llm use-endpoint <url> [--profile=<name>]
  kb llm install --profile=<name> --runner=llama-server --bin=<path> --model=<gguf-path> [--port=8091] [--ctx=32768] [--ngl=99] [--start]
  kb llm start [--profile=<name>]
  kb llm stop [--profile=<name>]
  kb llm restart [--profile=<name>]
  kb llm set-model --profile=<name> --model=<gguf-path> [--start]
  kb llm uninstall [--profile=<name>|--all]
  kb llm reap

External profiles are reuse-only. Stop, restart, uninstall, and reap never
touch external services such as local-research-agent's llama-server.
`;

export async function runLlm(rest: string[]): Promise<number> {
  const verb = rest[0];
  if (!verb) {
    process.stderr.write('kb llm: missing subcommand\n');
    return 2;
  }
  try {
    switch (verb) {
      case 'status': return runStatus(rest.slice(1));
      case 'probe': return runProbe(rest.slice(1));
      case 'use-endpoint': return runUseEndpoint(rest.slice(1));
      case 'install': return runInstall(rest.slice(1));
      case 'start': return runServiceVerb(rest.slice(1), 'start');
      case 'stop': return runServiceVerb(rest.slice(1), 'stop');
      case 'restart': return runServiceVerb(rest.slice(1), 'restart');
      case 'set-model': return runSetModel(rest.slice(1));
      case 'uninstall': return runUninstall(rest.slice(1));
      case 'reap': return runReap(rest.slice(1));
      default:
        process.stderr.write(`kb llm: unknown subcommand '${verb}'\n`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`kb llm: ${(err as Error).message}\n`);
    return 1;
  }
}

async function runStatus(rest: string[]): Promise<number> {
  let profileFilter: string | undefined;
  let format: 'md' | 'json' = 'md';
  for (const raw of rest) {
    if (raw.startsWith('--profile=')) { profileFilter = raw.slice('--profile='.length); continue; }
    if (raw.startsWith('--format=')) {
      const v = raw.slice('--format='.length);
      if (v !== 'md' && v !== 'json') throw new Error(`invalid --format: ${raw}`);
      format = v; continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${raw}`);
  }
  const profiles = profileFilter
    ? [await readProfile(profileFilter)].filter((p) => p !== null)
    : await listProfiles();
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify({ profiles }, null, 2)}\n`);
  } else if (profiles.length === 0) {
    process.stdout.write('(no LLM profiles configured)\n');
  } else {
    for (const p of profiles) {
      const owner = p.mode === 'external' ? `external${p.managed_by ? ` (${p.managed_by})` : ''}` : `managed ${p.unit_name}`;
      process.stdout.write(`${p.name.padEnd(24)}  ${owner.padEnd(34)}  ${p.endpoint}\n`);
    }
  }
  return 0;
}

async function runProbe(rest: string[]): Promise<number> {
  let endpoint = process.env.KB_LLM_ENDPOINT || 'http://127.0.0.1:8080/v1/chat/completions';
  for (const raw of rest) {
    if (raw.startsWith('--endpoint=')) { endpoint = raw.slice('--endpoint='.length); continue; }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${raw}`);
  }
  const result = await probeLlmEndpoint(endpoint);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.chat_ok ? 0 : 1;
}

async function runUseEndpoint(rest: string[]): Promise<number> {
  let profileName = 'local-research-agent';
  const positionals: string[] = [];
  for (const raw of rest) {
    if (raw.startsWith('--profile=')) { profileName = raw.slice('--profile='.length); continue; }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    positionals.push(raw);
  }
  if (positionals.length !== 1) throw new Error('use-endpoint expects <url>');
  const profile = await createExternalProfile(profileName, positionals[0], profileName === 'local-research-agent' ? 'local-research-agent' : undefined);
  await writeProfile(profile);
  await writeActiveProfile(profile.name);
  process.stdout.write(`Active LLM profile: ${profile.name} -> ${profile.endpoint}\n`);
  return 0;
}

async function runInstall(rest: string[]): Promise<number> {
  const opts = parseInstallArgs(rest);
  const profile = await createManagedProfile(opts);
  const installed = await installManagedUnit(profile);
  await writeProfile(installed);
  await writeActiveProfile(installed.name);
  if (opts.start) await startManagedUnit(installed);
  process.stdout.write(`Installed managed LLM profile ${installed.name} (${installed.unit_name}) at ${installed.endpoint}\n`);
  return 0;
}

async function runServiceVerb(rest: string[], verb: 'start' | 'stop' | 'restart'): Promise<number> {
  const name = parseProfileOnly(rest);
  const profile = await requireManagedProfile(name);
  if (verb === 'start') await startManagedUnit(profile);
  if (verb === 'stop') await stopManagedUnit(profile);
  if (verb === 'restart') await restartManagedUnit(profile);
  process.stdout.write(`${verb}ed ${profile.name}\n`);
  return 0;
}

async function runSetModel(rest: string[]): Promise<number> {
  let profileName: string | undefined;
  let modelPath: string | undefined;
  let start = false;
  for (const raw of rest) {
    if (raw === '--start') { start = true; continue; }
    if (raw.startsWith('--profile=')) { profileName = raw.slice('--profile='.length); continue; }
    if (raw.startsWith('--model=')) { modelPath = raw.slice('--model='.length); continue; }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${raw}`);
  }
  if (!profileName) throw new Error('set-model requires --profile=<name>');
  if (!modelPath) throw new Error('set-model requires --model=<gguf-path>');
  const current = await requireManagedProfile(profileName);
  await stopManagedUnit(current).catch(() => {});
  const updated = await createManagedProfile({
    name: current.name,
    runnerBin: current.runner_bin,
    modelPath,
    port: current.port,
    ctx: current.ctx,
    ngl: current.ngl,
    extraArgs: current.extra_args,
    keepalive: current.keepalive,
    owner: current.owner,
  });
  const installed = await installManagedUnit(updated);
  await writeProfile(installed);
  if (start) await startManagedUnit(installed);
  process.stdout.write(`Updated ${installed.name} to ${installed.model_path}\n`);
  return 0;
}

async function runUninstall(rest: string[]): Promise<number> {
  let all = false;
  let profileName: string | undefined;
  for (const raw of rest) {
    if (raw === '--all') { all = true; continue; }
    if (raw.startsWith('--profile=')) { profileName = raw.slice('--profile='.length); continue; }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${raw}`);
  }
  if (!all && !profileName) throw new Error('uninstall requires --profile=<name> or --all');
  const removed = await uninstallManagedProfiles(all ? 'all' : [profileName!]);
  if (!all && removed.length === 0) {
    const profile = await readProfile(profileName!);
    if (profile?.mode === 'external') {
      await removeProfile(profile.name);
      process.stdout.write(`Removed external profile ${profile.name}; external service left running.\n`);
      return 0;
    }
  }
  process.stdout.write(`Removed managed profile(s): ${removed.length === 0 ? '<none>' : removed.join(', ')}\n`);
  return 0;
}

async function runReap(rest: string[]): Promise<number> {
  if (rest.length > 0) throw new Error(`unexpected argument: ${rest[0]}`);
  const result = await reapManagedProfiles();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

function parseInstallArgs(rest: string[]) {
  let name: string | undefined;
  let runner: string | undefined;
  let runnerBin: string | undefined;
  let modelPath: string | undefined;
  let port = 8091;
  let ctx: number | undefined;
  let ngl: number | undefined;
  let start = false;
  let keepalive: 'lease' | 'always' = 'lease';
  const extraArgs: string[] = [];
  for (const raw of rest) {
    if (raw === '--start') { start = true; continue; }
    if (raw.startsWith('--profile=')) { name = raw.slice('--profile='.length); continue; }
    if (raw.startsWith('--runner=')) { runner = raw.slice('--runner='.length); continue; }
    if (raw.startsWith('--bin=')) { runnerBin = raw.slice('--bin='.length); continue; }
    if (raw.startsWith('--model=')) { modelPath = raw.slice('--model='.length); continue; }
    if (raw.startsWith('--port=')) { port = parsePositiveInt(raw, '--port='); continue; }
    if (raw.startsWith('--ctx=')) { ctx = parsePositiveInt(raw, '--ctx='); continue; }
    if (raw.startsWith('--ngl=')) { ngl = parsePositiveInt(raw, '--ngl='); continue; }
    if (raw.startsWith('--keepalive=')) {
      const v = raw.slice('--keepalive='.length);
      if (v !== 'lease' && v !== 'always') throw new Error(`invalid --keepalive: ${raw}`);
      keepalive = v; continue;
    }
    if (raw.startsWith('--runner-arg=')) { extraArgs.push(raw.slice('--runner-arg='.length)); continue; }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${raw}`);
  }
  if (!name) throw new Error('install requires --profile=<name>');
  if (runner !== 'llama-server') throw new Error('install requires --runner=llama-server');
  if (!runnerBin) throw new Error('install requires --bin=<path>');
  if (!modelPath) throw new Error('install requires --model=<gguf-path>');
  return { name, runnerBin, modelPath, port, ctx, ngl, extraArgs, keepalive, start };
}

function parseProfileOnly(rest: string[]): string {
  let profileName: string | undefined;
  for (const raw of rest) {
    if (raw.startsWith('--profile=')) { profileName = raw.slice('--profile='.length); continue; }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${raw}`);
  }
  if (!profileName) throw new Error('expected --profile=<name>');
  return profileName;
}

async function requireManagedProfile(name: string): Promise<ManagedLlmProfile> {
  const profile = await readProfile(name);
  if (!profile) throw new Error(`profile "${name}" not found`);
  if (profile.mode !== 'managed') {
    throw new Error(`profile "${name}" is external; refusing to manage someone else's service`);
  }
  return profile;
}

function parsePositiveInt(raw: string, prefix: string): number {
  const n = Number(raw.slice(prefix.length));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid ${prefix.slice(0, -1)}: ${raw}`);
  return n;
}
