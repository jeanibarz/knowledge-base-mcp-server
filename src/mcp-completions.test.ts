import { describe, expect, it } from '@jest/globals';
import {
  CompleteRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  KB_RESOURCE_TEMPLATE_URI,
  MAX_COMPLETION_VALUES,
  completeMcpArgument,
  registerCompletions,
} from './mcp-completions.js';

describe('completeMcpArgument', () => {
  it('completes kb:// resource-template KB authority values', async () => {
    const result = await completeMcpArgument({
      ref: { type: 'ref/resource', uri: KB_RESOURCE_TEMPLATE_URI },
      argument: { name: 'kb', value: 'wo' },
    }, {
      listKnowledgeBaseNames: async () => ['work', 'research', 'work-archive'],
    });

    expect(result).toEqual({
      completion: {
        values: ['work', 'work-archive'],
        total: 2,
        hasMore: false,
      },
    });
  });

  it('completes kb:// resource-template paths inside the selected KB', async () => {
    const calls: Array<{ kbName: string; prefix: string; limit: number }> = [];
    const result = await completeMcpArgument({
      ref: { type: 'ref/resource', uri: KB_RESOURCE_TEMPLATE_URI },
      argument: { name: 'path', value: 'run' },
      context: { arguments: { kb: 'work' } },
    }, {
      listResourcePaths: async (kbName, prefix, limit) => {
        calls.push({ kbName, prefix, limit });
        return {
          values: ['runbooks/deploy.md', 'runbooks/rollback.md'],
          hasMore: false,
        };
      },
    });

    expect(calls).toEqual([{ kbName: 'work', prefix: 'run', limit: MAX_COMPLETION_VALUES + 1 }]);
    expect(result.completion.values).toEqual(['runbooks/deploy.md', 'runbooks/rollback.md']);
    expect(result.completion.hasMore).toBe(false);
  });

  it('reports hasMore and caps path completion values at the MCP limit', async () => {
    const values = Array.from({ length: MAX_COMPLETION_VALUES + 1 }, (_, i) => `notes/${i}.md`);
    const result = await completeMcpArgument({
      ref: { type: 'ref/resource', uri: KB_RESOURCE_TEMPLATE_URI },
      argument: { name: 'path', value: 'notes/' },
      context: { arguments: { kb: 'research' } },
    }, {
      listResourcePaths: async () => ({ values, hasMore: true }),
    });

    expect(result.completion.values).toHaveLength(MAX_COMPLETION_VALUES);
    expect(result.completion.hasMore).toBe(true);
  });

  it('returns an empty completion for missing KB context or unknown resource refs', async () => {
    await expect(completeMcpArgument({
      ref: { type: 'ref/resource', uri: KB_RESOURCE_TEMPLATE_URI },
      argument: { name: 'path', value: '' },
    })).resolves.toEqual({ completion: { values: [], hasMore: false } });

    await expect(completeMcpArgument({
      ref: { type: 'ref/resource', uri: 'kb://{other}/{path}' },
      argument: { name: 'kb', value: '' },
    })).resolves.toEqual({ completion: { values: [], hasMore: false } });
  });

  it('completes prompt knowledge_base_name arguments from KB names', async () => {
    const result = await completeMcpArgument({
      ref: { type: 'ref/prompt', name: 'cite_sources' },
      argument: { name: 'knowledge_base_name', value: 're' },
    }, {
      listKnowledgeBaseNames: async () => ['work', 'research', 'reference'],
    });

    expect(result.completion.values).toEqual(['reference', 'research']);
    expect(result.completion.total).toBe(2);
  });

  it('returns empty completions for unknown prompt refs, including model-style arguments', async () => {
    const result = await completeMcpArgument({
      ref: { type: 'ref/prompt', name: 'model_probe' },
      argument: { name: 'model_id', value: 'ollama' },
    }, {
      listModelIds: async () => [
        'huggingface__BAAI-bge-small-en-v1.5',
        'ollama__nomic-embed-text-latest',
      ],
    });

    expect(result.completion.values).toEqual([]);
  });

  it('returns empty completions for non-completable prompt arguments', async () => {
    const result = await completeMcpArgument({
      ref: { type: 'ref/prompt', name: 'cite_sources' },
      argument: { name: 'question', value: 'how' },
    }, {
      listKnowledgeBaseNames: async () => ['work'],
      listModelIds: async () => ['ollama__nomic-embed-text-latest'],
    });

    expect(result).toEqual({ completion: { values: [], hasMore: false } });
  });
});

describe('registerCompletions', () => {
  it('declares completions and wires completion/complete', () => {
    const capabilities: Array<Record<string, unknown>> = [];
    const handlers = new Map<unknown, unknown>();
    const fakeMcp = {
      server: {
        registerCapabilities: (cap: Record<string, unknown>) => capabilities.push(cap),
        setRequestHandler: (schema: unknown, handler: unknown) => handlers.set(schema, handler),
      },
    } as unknown as McpServer;

    registerCompletions(fakeMcp);

    expect(capabilities).toContainEqual({ completions: {} });
    expect(handlers.has(CompleteRequestSchema)).toBe(true);
  });
});
