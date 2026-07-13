import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as path from 'path';
import {
  executeAsk,
  redactOutboundMessages,
  resolveOutboundRedactionEnabled,
  type AskExecutionArgs,
  type RunAskCoreDeps,
} from './ask-core.js';
import { logger } from './logger.js';
import { nowMs } from './timing-core.js';

const ELIGIBLE_SOURCE = path.join(process.cwd(), 'package.json');

// A fake GitHub personal-access token shaped to match redactSecrets'
// provider_token pattern. It must never survive to the outbound payload nor
// appear in any log argument on the remote path.
const FAKE_SECRET = 'ghp_FAKE000111222333444555666777888999';

function buildDeps(capture: { messages?: Array<{ role: string; content: string }> }): RunAskCoreDeps {
  const manager = {
    modelDir: '/tmp/kb-ask-redact-model',
    initialize: jest.fn(async () => {}),
    updateIndex: jest.fn(async () => {}),
    similaritySearch: jest.fn(async () => [
      {
        // Chunk text carries a leaked credential straight from the index.
        pageContent: `Deploy notes: export GITHUB_TOKEN=${FAKE_SECRET} then run.`,
        metadata: { knowledgeBase: 'ops', relativePath: 'deploy.md', source: ELIGIBLE_SOURCE },
        score: 0.9,
      },
    ]),
  };
  return {
    bootstrapLayout: jest.fn(async () => {}),
    resolveActiveModel: jest.fn(async () => 'ollama__nomic-embed-text-latest'),
    loadManagerForModel: jest.fn(async () => manager as never),
    loadReadOnlyIndex: jest.fn(async () => {}),
    withWriteLock: jest.fn(async <T>(_resource: string, action: () => Promise<T>) => action()) as RunAskCoreDeps['withWriteLock'],
    callChatCompletion: jest.fn(async (options: Parameters<RunAskCoreDeps['callChatCompletion']>[0]) => {
      capture.messages = options.messages as Array<{ role: string; content: string }>;
      return { content: 'ok', model: 'remote-model', raw: {} };
    }),
  };
}

function baseArgs(): AskExecutionArgs {
  return {
    question: 'How do we deploy?',
    // An explicit endpoint routes resolveLlmTarget through createExternalProfile
    // (FS-free, mode 'external') so the test never touches the filesystem.
    endpoint: 'http://127.0.0.1:9999/v1/chat/completions',
    k: 4,
    contextBudgetTokens: 2000,
    refresh: false,
    timing: true,
  };
}

describe('outbound redaction (#650)', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.KB_LLM_PROVIDER;
    delete process.env.KB_ASK_REDACT_OUTBOUND;
    delete process.env.KB_LLM_ENDPOINT;
    delete process.env.KB_OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it('scrubs the outbound payload on the remote path and logs only a count', async () => {
    process.env.KB_LLM_PROVIDER = 'openrouter';
    const infoSpy = jest.spyOn(logger, 'info');
    const capture: { messages?: Array<{ role: string; content: string }> } = {};
    const deps = buildDeps(capture);

    const result = await executeAsk(baseArgs(), deps, nowMs());

    // The transmitted prompt is redacted, secret gone.
    const userMessage = capture.messages!.find((m) => m.role === 'user')!;
    expect(userMessage.content).toContain('[REDACTED]');
    expect(userMessage.content).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(capture.messages)).not.toContain(FAKE_SECRET);

    // Count-only summary surfaces on the result and timing.
    expect(result.redaction.enabled).toBe(true);
    expect(result.redaction.total).toBeGreaterThanOrEqual(1);
    expect(result.timing?.outbound_redactions).toBe(result.redaction.total);

    // A log line records the count but never the secret.
    expect(infoSpy).toHaveBeenCalled();
    const loggedRedaction = infoSpy.mock.calls.find((call) =>
      String(call[0]).includes('redacted'),
    );
    expect(loggedRedaction).toBeDefined();
    expect(loggedRedaction!.join(' ')).toContain('1');
    for (const call of infoSpy.mock.calls) {
      expect(call.map(String).join(' ')).not.toContain(FAKE_SECRET);
    }
  });

  it('leaves the local path untouched and does not redact', async () => {
    // KB_LLM_PROVIDER unset → local provider → redaction off by default.
    const infoSpy = jest.spyOn(logger, 'info');
    const capture: { messages?: Array<{ role: string; content: string }> } = {};
    const deps = buildDeps(capture);

    const result = await executeAsk(baseArgs(), deps, nowMs());

    const userMessage = capture.messages!.find((m) => m.role === 'user')!;
    expect(userMessage.content).toContain(FAKE_SECRET);
    expect(userMessage.content).not.toContain('[REDACTED]');
    expect(result.redaction.enabled).toBe(false);
    expect(result.redaction.total).toBe(0);

    const loggedRedaction = infoSpy.mock.calls.find((call) =>
      String(call[0]).includes('redacted'),
    );
    expect(loggedRedaction).toBeUndefined();
  });

  it('honors an explicit opt-in on the local path', async () => {
    process.env.KB_ASK_REDACT_OUTBOUND = 'on';
    const capture: { messages?: Array<{ role: string; content: string }> } = {};
    const deps = buildDeps(capture);

    const result = await executeAsk(baseArgs(), deps, nowMs());

    const userMessage = capture.messages!.find((m) => m.role === 'user')!;
    expect(userMessage.content).toContain('[REDACTED]');
    expect(userMessage.content).not.toContain(FAKE_SECRET);
    expect(result.redaction.enabled).toBe(true);
    expect(result.redaction.total).toBeGreaterThanOrEqual(1);
  });
});

describe('resolveOutboundRedactionEnabled', () => {
  it('defaults ON for a remote provider and OFF for local', () => {
    expect(resolveOutboundRedactionEnabled({ KB_LLM_PROVIDER: 'openrouter' } as NodeJS.ProcessEnv)).toBe(true);
    expect(resolveOutboundRedactionEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('lets an explicit value win for any provider', () => {
    // Remote user opts out.
    expect(
      resolveOutboundRedactionEnabled({ KB_LLM_PROVIDER: 'openrouter', KB_ASK_REDACT_OUTBOUND: 'off' } as NodeJS.ProcessEnv),
    ).toBe(false);
    // Local user opts in.
    expect(resolveOutboundRedactionEnabled({ KB_ASK_REDACT_OUTBOUND: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('ignores blank/garbage values and falls back to provider remoteness', () => {
    expect(resolveOutboundRedactionEnabled({ KB_ASK_REDACT_OUTBOUND: '   ' } as NodeJS.ProcessEnv)).toBe(false);
    expect(
      resolveOutboundRedactionEnabled({ KB_LLM_PROVIDER: 'openrouter', KB_ASK_REDACT_OUTBOUND: 'maybe' } as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe('redactOutboundMessages', () => {
  const messages = [
    { role: 'system' as const, content: 'no secrets here' },
    { role: 'user' as const, content: `token is ${FAKE_SECRET}` },
  ];

  it('passes messages through verbatim with a disabled summary when off', () => {
    const out = redactOutboundMessages(messages, false);
    expect(out.messages).toBe(messages);
    expect(out.summary.enabled).toBe(false);
    expect(out.summary.total).toBe(0);
  });

  it('scrubs every message and returns a combined count when on', () => {
    const out = redactOutboundMessages(messages, true);
    expect(out.summary.enabled).toBe(true);
    expect(out.summary.total).toBeGreaterThanOrEqual(1);
    expect(out.messages[1].content).toContain('[REDACTED]');
    expect(out.messages[1].content).not.toContain(FAKE_SECRET);
    // The original array is not mutated.
    expect(messages[1].content).toContain(FAKE_SECRET);
  });
});
