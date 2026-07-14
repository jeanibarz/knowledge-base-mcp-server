import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { runLlm } from './cli-llm.js';

const ORIGINAL_ENV = { ...process.env };
let stdout = '';
let stderr = '';

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    KB_LLM_FAKE: 'on',
    KB_LOG_FORMAT: 'text',
  };
  delete process.env.KB_LLM_PROVIDER;
  delete process.env.KB_LLM_MODEL;
  stdout = '';
  stderr = '';
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  });
  jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

describe('kb llm probe', () => {
  it('reports the resolved fake provider/model and accepts space-delimited expectations', async () => {
    await expect(runLlm([
      'probe',
      '--expect-provider', 'fake',
      '--expect-model', 'kb-fake-llm',
    ])).resolves.toBe(0);

    expect(JSON.parse(stdout)).toMatchObject({
      provider: 'fake',
      model: 'kb-fake-llm',
      chat_ok: true,
    });
  });

  it('returns exit 1 and explains a resolved provider/model mismatch', async () => {
    await expect(runLlm([
      'probe',
      '--expect-provider=openrouter',
      '--expect-model=deepseek/deepseek-v4-flash',
    ])).resolves.toBe(1);

    const output = JSON.parse(stdout) as { detail: string };
    expect(output.detail).toContain("expected provider 'openrouter', resolved 'fake'");
    expect(output.detail).toContain("expected model 'deepseek/deepseek-v4-flash', resolved 'kb-fake-llm'");
  });
});
