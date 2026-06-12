import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  callFakeChatCompletion,
  fakeOpenAiChatCompletionResponse,
  generateFakeChatContent,
  isFakeLlmEnabled,
} from './llm-fake-stub.js';

describe('llm fake stub', () => {
  it('parses on/off environment values', () => {
    expect(isFakeLlmEnabled({ KB_LLM_FAKE: 'on' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isFakeLlmEnabled({ KB_LLM_FAKE: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isFakeLlmEnabled({ KB_LLM_FAKE: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isFakeLlmEnabled({ KB_LLM_FAKE: 'off' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('returns deterministic relevance judge JSON from prompt content', () => {
    const content = generateFakeChatContent([
      {
        role: 'system',
        content: 'You judge whether retrieved knowledge-base chunks are relevant to the user task.',
      },
      {
        role: 'user',
        content: [
          'Task context:',
          'answer a deployment rollback question',
          '',
          'Query:',
          'rollback approval',
          '',
          'Candidates:',
          'Candidate 1',
          'id: ops.md#0',
          'source: ops.md',
          'content:',
          'Rollback approval requires the release lead.',
          '',
          '---',
          '',
          'Candidate 2',
          'id: dns.md#0',
          'source: dns.md',
          'content:',
          'DNS cutovers use a 300 second TTL.',
          '',
          'JSON shape: {"overall":"relevant|partial|no-relevant-context","verdicts":[]}',
        ].join('\n'),
      },
    ]);

    expect(JSON.parse(content)).toEqual({
      overall: 'relevant',
      verdicts: [
        { id: 'ops.md#0', decision: 'keep', reason: 'rollback match' },
        { id: 'dns.md#0', decision: 'drop', reason: 'dns lacks query match' },
      ],
    });
  });

  it('derives contextual prefaces from the nearest markdown heading', () => {
    const content = generateFakeChatContent([
      {
        role: 'system',
        content: 'You generate short retrieval-aware context strings. Reply with the context only.',
      },
      {
        role: 'user',
        content: [
          '<document>',
          '# Runbook',
          '',
          '## Rollback',
          '',
          'Rollback approval requires the release lead.',
          '</document>',
          '',
          'Here is one chunk from the document above:',
          '<chunk>',
          'Rollback approval requires the release lead.',
          '</chunk>',
        ].join('\n'),
      },
    ]);

    expect(content).toBe('In section "Rollback", this chunk discusses Rollback approval requires the release lead.');
  });

  it('returns an OpenAI-compatible response envelope for the mock server', () => {
    const response = fakeOpenAiChatCompletionResponse({
      messages: [
        { role: 'system', content: 'Reply with exactly: ok' },
        { role: 'user', content: 'health check' },
      ],
    });

    expect(response).toMatchObject({
      object: 'chat.completion',
      model: 'kb-fake-llm',
      choices: [
        {
          message: { role: 'assistant', content: 'ok' },
        },
      ],
    });
  });

  it('loads KB_LLM_FAKE_RULES overrides for fake chat completions', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-fake-llm-rules-'));
    try {
      const rulesPath = path.join(dir, 'rules.json');
      await fsp.writeFile(rulesPath, JSON.stringify({
        answers: [
          { question_contains: 'release owner', answer: 'The release owner is Ada.' },
        ],
      }));

      const result = await callFakeChatCompletion({
        endpoint: 'mock://ignored',
        model: 'ignored',
        messages: [
          {
            role: 'system',
            content: 'Answer only from the provided knowledge-base snippets.',
          },
          {
            role: 'user',
            content: [
              'Question:',
              'Who is the release owner?',
              '',
              'Retrieved snippets:',
              'Snippet 1',
              'Score: 0.9',
              'Metadata: {"relativePath":"runbook.md"}',
              'Content:',
              'The fallback owner is Grace.',
            ].join('\n'),
          },
        ],
      }, { KB_LLM_FAKE_RULES: rulesPath } as NodeJS.ProcessEnv);

      expect(result.content).toBe('The release owner is Ada.');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('streams fake chat content when the caller opts in', async () => {
    const tokens: string[] = [];
    let firstTokenCount = 0;

    const result = await callFakeChatCompletion({
      endpoint: 'mock://ignored',
      messages: [{ role: 'user', content: 'plain prompt' }],
      stream: {
        onFirstToken: () => { firstTokenCount += 1; },
        onToken: (token) => { tokens.push(token); },
      },
    }, { KB_LOG_FORMAT: 'text' } as NodeJS.ProcessEnv);

    expect(result.content).toBe('Fake LLM response from kb-fake-llm.');
    expect(tokens.join('')).toBe(result.content);
    expect(firstTokenCount).toBe(1);
  });
});
