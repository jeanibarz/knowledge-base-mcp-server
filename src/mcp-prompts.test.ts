import { describe, expect, it } from '@jest/globals';
import {
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getPrompt,
  listPrompts,
  mcpPromptsEnabled,
  registerPrompts,
} from './mcp-prompts.js';
import { KB_PROMPT_TEMPLATES } from './config/mcp-descriptions.js';

// #642 — unit coverage for the MCP prompts surface. These exercise the pure
// list/get bodies (the wire handlers are thin delegates) plus the env gate and
// the capability/handler registration. No retrieval or LLM I/O happens here:
// the surface is read-only and rendering is pure string substitution.

describe('mcpPromptsEnabled', () => {
  it.each([
    ['on', true],
    ['1', true],
    ['true', true],
    ['yes', true],
    ['ON', true],
    ['off', false],
    ['0', false],
    ['no', false],
    ['', false],
  ])('treats KB_MCP_PROMPTS=%j as %s', (value, expected) => {
    expect(mcpPromptsEnabled({ KB_MCP_PROMPTS: value })).toBe(expected);
  });

  it('defaults to off when unset', () => {
    expect(mcpPromptsEnabled({})).toBe(false);
  });
});

describe('listPrompts', () => {
  it('returns every registered template with name, description, and argument specs', () => {
    const { prompts } = listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(
      ['cite_sources', 'compare_notes', 'research_brief', 'summarize_kb'],
    );
    for (const prompt of prompts) {
      expect(typeof prompt.description).toBe('string');
      expect(prompt.description?.length ?? 0).toBeGreaterThan(0);
      expect(Array.isArray(prompt.arguments)).toBe(true);
    }
  });

  it('marks required arguments as required and optional ones as not', () => {
    const cite = listPrompts().prompts.find((p) => p.name === 'cite_sources');
    const question = cite?.arguments?.find((a) => a.name === 'question');
    const kb = cite?.arguments?.find((a) => a.name === 'knowledge_base_name');
    expect(question?.required).toBe(true);
    expect(kb?.required).toBe(false);
  });

  it('list metadata matches the centralized registry', () => {
    expect(listPrompts().prompts).toHaveLength(KB_PROMPT_TEMPLATES.length);
  });
});

describe('getPrompt', () => {
  it('renders cite_sources with the substituted question and KB scope', () => {
    const result = getPrompt('cite_sources', {
      question: 'How does the relevance gate work?',
      knowledge_base_name: 'notes',
    });
    expect(result.messages).toHaveLength(1);
    const message = result.messages[0];
    expect(message.role).toBe('user');
    expect(message.content.type).toBe('text');
    const text = message.content.type === 'text' ? message.content.text : '';
    expect(text).toContain('How does the relevance gate work?');
    expect(text).toContain('knowledge_base_name="notes"');
    expect(text).toContain('retrieve_knowledge');
  });

  it('renders compare_notes with both topics substituted', () => {
    const text = renderText('compare_notes', { topic_a: 'dense search', topic_b: 'hybrid search' });
    expect(text).toContain('dense search');
    expect(text).toContain('hybrid search');
  });

  it('falls back to an all-KBs scope when knowledge_base_name is omitted', () => {
    const text = renderText('summarize_kb', {});
    expect(text).toContain('all available knowledge bases');
    expect(text).not.toContain('knowledge_base_name="');
  });

  it('uses the focus argument as the retrieval query when provided', () => {
    const text = renderText('summarize_kb', { focus: 'incident runbooks' });
    expect(text).toContain('query="incident runbooks"');
  });

  it('substitutes the k argument into research_brief when provided', () => {
    const text = renderText('research_brief', { topic: 'caching', k: '12' });
    expect(text).toContain('query="caching"');
    expect(text).toContain('up to 12 results');
  });

  it('throws on an unknown prompt name', () => {
    expect(() => getPrompt('does_not_exist')).toThrow(/unknown prompt/);
  });

  it('throws when a required argument is missing', () => {
    expect(() => getPrompt('cite_sources', { knowledge_base_name: 'notes' })).toThrow(
      /missing required argument/,
    );
  });

  it('treats a blank required argument as missing', () => {
    expect(() => getPrompt('compare_notes', { topic_a: 'x', topic_b: '   ' })).toThrow(
      /missing required argument/,
    );
  });
});

describe('registerPrompts', () => {
  it('declares the prompts capability and wires both handlers', () => {
    const capabilities: Array<Record<string, unknown>> = [];
    const handlers = new Map<unknown, unknown>();
    const fakeMcp = {
      server: {
        registerCapabilities: (cap: Record<string, unknown>) => capabilities.push(cap),
        setRequestHandler: (schema: unknown, handler: unknown) => handlers.set(schema, handler),
      },
    } as unknown as McpServer;

    registerPrompts(fakeMcp);

    expect(capabilities).toContainEqual({ prompts: { listChanged: false } });
    expect(handlers.has(ListPromptsRequestSchema)).toBe(true);
    expect(handlers.has(GetPromptRequestSchema)).toBe(true);
  });
});

function renderText(name: string, args: Record<string, string>): string {
  const message = getPrompt(name, args).messages[0];
  return message.content.type === 'text' ? message.content.text : '';
}
