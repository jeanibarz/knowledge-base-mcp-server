import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createManagedProfile, writeLease, writeProfile } from './llm-profiles.js';
import {
  installManagedUnit,
  reapManagedProfiles,
  renderManagedUnit,
  type CommandRunner,
} from './llm-service.js';

describe('llm-service', () => {
  it('renders loopback-only llama-server units', async () => {
    await withTempLlmState(async (dir) => {
      const modelPath = path.join(dir, 'model.gguf');
      await fsp.writeFile(modelPath, 'model', 'utf-8');
      const profile = await createManagedProfile({
        name: 'qwen',
        runnerBin: '/opt/llama-server',
        modelPath,
        port: 8091,
        ctx: 32768,
        ngl: 99,
      });

      const unit = renderManagedUnit(profile);
      expect(unit).toContain('--host 127.0.0.1');
      expect(unit).toContain('--port 8091');
      expect(unit).toContain('-m ');
      expect(unit).toContain('Restart=on-failure');
    });
  });

  it('installs unit files through injected systemctl runner', async () => {
    await withTempLlmState(async (dir) => {
      const calls: string[] = [];
      const runner: CommandRunner = async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        return { code: 0, stdout: '', stderr: '' };
      };
      const modelPath = path.join(dir, 'model.gguf');
      await fsp.writeFile(modelPath, 'model', 'utf-8');
      const profile = await createManagedProfile({
        name: 'qwen',
        runnerBin: '/opt/llama-server',
        modelPath,
        port: 8091,
      });

      const installed = await installManagedUnit(profile, runner);
      expect(installed.unit_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(calls).toContain('systemctl --user daemon-reload');
      await expect(fsp.readFile(path.join(process.env.KB_LLM_SYSTEMD_USER_DIR!, 'kb-llm@qwen.service'), 'utf-8'))
        .resolves.toContain('knowledge-base CLI local LLM');
    });
  });

  it('reaps stale managed profiles but skips fresh leases', async () => {
    await withTempLlmState(async (dir) => {
      const stopped: string[] = [];
      const runner: CommandRunner = async (_cmd, args) => {
        if (args.includes('stop')) stopped.push(args[args.length - 1]);
        return { code: 0, stdout: '', stderr: '' };
      };
      const modelPath = path.join(dir, 'model.gguf');
      const kbBin = path.join(dir, 'kb');
      const installRoot = path.join(dir, 'pkg');
      await fsp.writeFile(modelPath, 'model', 'utf-8');
      await fsp.writeFile(kbBin, '', 'utf-8');
      await fsp.mkdir(installRoot);
      const profile = await createManagedProfile({
        name: 'qwen',
        runnerBin: '/opt/llama-server',
        modelPath,
        port: 8091,
        owner: { package: 'pkg', bin_path: kbBin, install_root: installRoot },
      });
      await writeProfile(profile);
      await writeLease(profile, { cliVersion: '0.0.0', binPath: kbBin, installRoot });

      const fresh = await reapManagedProfiles({ runner, now: new Date(), ttlMs: 60_000 });
      expect(fresh.stopped).toEqual([]);

      await fsp.rm(kbBin);
      const stale = await reapManagedProfiles({ runner, now: new Date(), ttlMs: 60_000 });
      expect(stale.stopped).toEqual(['qwen']);
      expect(stopped).toContain('kb-llm@qwen.service');
    });
  });
});

async function withTempLlmState(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-llm-service-test-'));
  const oldConfig = process.env.KB_LLM_CONFIG_DIR;
  const oldState = process.env.KB_LLM_STATE_DIR;
  const oldSystemd = process.env.KB_LLM_SYSTEMD_USER_DIR;
  process.env.KB_LLM_CONFIG_DIR = path.join(dir, 'config');
  process.env.KB_LLM_STATE_DIR = path.join(dir, 'state');
  process.env.KB_LLM_SYSTEMD_USER_DIR = path.join(dir, 'systemd');
  try {
    await fn(dir);
  } finally {
    if (oldConfig === undefined) delete process.env.KB_LLM_CONFIG_DIR;
    else process.env.KB_LLM_CONFIG_DIR = oldConfig;
    if (oldState === undefined) delete process.env.KB_LLM_STATE_DIR;
    else process.env.KB_LLM_STATE_DIR = oldState;
    if (oldSystemd === undefined) delete process.env.KB_LLM_SYSTEMD_USER_DIR;
    else process.env.KB_LLM_SYSTEMD_USER_DIR = oldSystemd;
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
