import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  createExternalProfile,
  createManagedProfile,
  listProfiles,
  readActiveProfileName,
  readProfile,
  removeProfile,
  writeActiveProfile,
  writeLease,
  writeProfile,
} from './llm-profiles.js';

describe('llm-profiles', () => {
  it('stores external profiles and active profile state', async () => {
    await withTempLlmState(async () => {
      const profile = await createExternalProfile('local-research-agent', 'http://127.0.0.1:8080', 'local-research-agent');
      await writeProfile(profile);
      await writeActiveProfile(profile.name);

      expect(await readActiveProfileName()).toBe('local-research-agent');
      expect(await readProfile('local-research-agent')).toMatchObject({
        mode: 'external',
        endpoint: 'http://127.0.0.1:8080/v1/chat/completions',
        managed_by: 'local-research-agent',
      });
      expect(await listProfiles()).toHaveLength(1);
    });
  });

  it('stores managed profiles with a model fingerprint and lease', async () => {
    await withTempLlmState(async (dir) => {
      const modelPath = path.join(dir, 'model.gguf');
      await fsp.writeFile(modelPath, 'model-bytes', 'utf-8');
      const profile = await createManagedProfile({
        name: 'qwen',
        runnerBin: '/bin/llama-server',
        modelPath,
        port: 8091,
        ctx: 32768,
      });
      await writeProfile(profile);
      await writeLease(profile, { cliVersion: '0.0.0', binPath: '/bin/kb', installRoot: '/pkg' });

      expect(profile.unit_name).toBe('kb-llm@qwen.service');
      expect(profile.model_fingerprint.size).toBe('model-bytes'.length);
      expect(await readProfile('qwen')).toMatchObject({ mode: 'managed', port: 8091 });

      await removeProfile('qwen');
      expect(await readProfile('qwen')).toBeNull();
    });
  });
});

async function withTempLlmState(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-llm-profile-test-'));
  const oldConfig = process.env.KB_LLM_CONFIG_DIR;
  const oldState = process.env.KB_LLM_STATE_DIR;
  process.env.KB_LLM_CONFIG_DIR = path.join(dir, 'config');
  process.env.KB_LLM_STATE_DIR = path.join(dir, 'state');
  try {
    await fn(dir);
  } finally {
    if (oldConfig === undefined) delete process.env.KB_LLM_CONFIG_DIR;
    else process.env.KB_LLM_CONFIG_DIR = oldConfig;
    if (oldState === undefined) delete process.env.KB_LLM_STATE_DIR;
    else process.env.KB_LLM_STATE_DIR = oldState;
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
