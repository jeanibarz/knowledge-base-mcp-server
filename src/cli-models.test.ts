import { describe, expect, it } from '@jest/globals';
import { formatAddCostAndWallTime } from './cli-models.js';
import { classifyOpenAiEndpoint } from './cost-estimates.js';

// Issue #1267 — `kb models add openai <model>` must only quote OpenAI pricing
// and hosted-API wall time when OPENAI_BASE_URL actually points at OpenAI.

describe('classifyOpenAiEndpoint', () => {
  it.each([
    'https://api.openai.com/v1',
    'https://API.OpenAI.com/v1/',
    'https://api.openai.com./v1',
  ])('treats %s as the hosted OpenAI API', (url) => {
    expect(classifyOpenAiEndpoint(url)).toBe('hosted');
  });

  it.each([
    'http://127.0.0.1:18102/v1',
    'http://127.5.0.1:8080/v1',
    'http://localhost:8080/v1',
    'http://tei.localhost/v1',
    'http://[::1]:8080/v1',
    'http://0.0.0.0:8080/v1',
    'http://10.0.0.5/v1',
    'http://172.16.0.1/v1',
    'http://172.31.255.255/v1',
    'http://192.168.1.20:8080/v1',
    'http://169.254.1.1/v1',
    'http://[fd12:3456::1]/v1',
    'http://[fe80::1]/v1',
    'http://gpu-box.local:8080/v1',
    'http://host.docker.internal:8080/v1',
  ])('treats %s as a local/self-hosted endpoint', (url) => {
    expect(classifyOpenAiEndpoint(url)).toBe('local');
  });

  it.each([
    'https://openrouter.ai/api/v1',
    'https://my-gateway.example.com/openai/v1',
    'https://api.openai.com.evil.example/v1',
    'https://notapi.openai.com/v1',
    'http://172.32.0.1/v1',
    'http://8.8.8.8/v1',
    'not a url',
  ])('treats %s as a custom (non-OpenAI, non-local) endpoint', (url) => {
    expect(classifyOpenAiEndpoint(url)).toBe('custom');
  });
});

describe('formatAddCostAndWallTime', () => {
  // ~417k tokens / ~2084 chunks — the TEI measurement from issue #1267.
  const base = { modelName: 'Qwen/Qwen3-Embedding-0.6B', estTokens: 417_000, estChunks: 2084 };

  it('quotes OpenAI pricing and hosted wall time for api.openai.com', () => {
    const out = formatAddCostAndWallTime({
      ...base,
      provider: 'openai',
      modelName: 'text-embedding-3-small',
      openaiBaseUrl: 'https://api.openai.com/v1',
    });
    expect(out).toBe(
      'Estimated cost: ~$0.0083 (OpenAI text-embedding-3-small at $0.02/1M tokens)\n' +
      'See provider pricing: https://openai.com/api/pricing\n' +
      'Estimated wall time: ~6.9 min (HTTP latency dominated)\n',
    );
  });

  it('prints no OpenAI price or hosted wall time for a loopback TEI endpoint', () => {
    const out = formatAddCostAndWallTime({
      ...base,
      provider: 'openai',
      openaiBaseUrl: 'http://127.0.0.1:18102/v1',
    });
    expect(out).toContain('Cost: local/self-hosted endpoint (no OpenAI pricing)');
    expect(out).not.toMatch(/\$|openai\.com\/api\/pricing|HTTP latency dominated|6\.9 min/);
    expect(out).toContain('Estimated wall time: not estimated');
  });

  it('points a third-party OpenAI-compatible host at its own pricing', () => {
    const out = formatAddCostAndWallTime({
      ...base,
      provider: 'openai',
      openaiBaseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(out).toContain('OpenAI pricing does not apply');
    expect(out).not.toMatch(/\$|HTTP latency dominated/);
  });

  it('keeps the existing lines for huggingface and ollama regardless of OPENAI_BASE_URL', () => {
    const local = 'http://127.0.0.1:18102/v1';
    expect(formatAddCostAndWallTime({ ...base, provider: 'huggingface', openaiBaseUrl: local })).toBe(
      'Cost: free tier (rate-limited). See https://huggingface.co/docs/inference-providers/pricing\n' +
      'Estimated wall time: ~10.4 min (HTTP latency dominated)\n',
    );
    expect(formatAddCostAndWallTime({ ...base, provider: 'ollama', openaiBaseUrl: local })).toBe(
      'Cost: free (Ollama is local).\n' +
      'Estimated wall time: ~1.7 min (HTTP latency dominated)\n',
    );
  });
});
