// mcp-prompts.ts — MCP prompts surface (#642) for the knowledge-base server.
// Implements the third first-class MCP primitive (alongside tools in
// `KnowledgeBaseServer.ts` and resources in `mcp-resources.ts`): the
// `prompts/list` + `prompts/get` capability backed by a small, fixed registry
// of read-only, parameterized templates.
//
// The template text lives in `config/mcp-descriptions.ts` (next to the tool
// descriptions); this module owns the wire surface: capability declaration,
// the two request handlers, argument validation, and rendering into MCP
// `PromptMessage[]`. Gated behind `KB_MCP_PROMPTS` (default off) consistent
// with the repo's feature-flag culture.
//
// v1 is intentionally minimal: a fixed registry, no user-defined-prompt store,
// and no retrieval/LLM calls while answering — the rendered messages instruct
// the client/agent to call `retrieve_knowledge` itself, so the surface stays
// read-only.

import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  type GetPromptResult,
  type ListPromptsResult,
  type Prompt,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KB_PROMPT_TEMPLATES, type KbPromptTemplate } from './config/mcp-descriptions.js';

/**
 * Whether the MCP prompts surface is enabled. Mirrors the `KB_INGEST_ENABLED`
 * pattern: a process-level gate read from the environment. Default off so the
 * capability is opt-in. Accepts the repo's yes/no boolean spellings.
 */
export function mcpPromptsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const normalized = env.KB_MCP_PROMPTS?.trim().toLowerCase();
  return normalized === 'on' || normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export const KB_MCP_PROMPTS: boolean = mcpPromptsEnabled();

function templateByName(name: string): KbPromptTemplate | undefined {
  return KB_PROMPT_TEMPLATES.find((template) => template.name === name);
}

/**
 * `prompts/list` body. Returns the fixed template registry as MCP `Prompt`
 * metadata (name, description, argument specs). Pure — no I/O, no flag check
 * (registration is gated upstream).
 */
export function listPrompts(): ListPromptsResult {
  const prompts: Prompt[] = KB_PROMPT_TEMPLATES.map((template) => ({
    name: template.name,
    description: template.description,
    arguments: template.arguments.map((arg) => ({
      name: arg.name,
      description: arg.description,
      required: arg.required ?? false,
    })),
  }));
  return { prompts };
}

/**
 * `prompts/get` body. Looks up the named template, validates that all required
 * arguments are present, and renders a single user message with the
 * substituted instruction text. Throws on an unknown name or a missing
 * required argument so the SDK surfaces a protocol error to the client.
 */
export function getPrompt(name: string, rawArgs?: Record<string, string>): GetPromptResult {
  const template = templateByName(name);
  if (template === undefined) {
    const known = KB_PROMPT_TEMPLATES.map((t) => t.name).join(', ');
    throw new Error(`unknown prompt: ${JSON.stringify(name)} (known prompts: ${known})`);
  }

  const args: Record<string, string> = { ...(rawArgs ?? {}) };
  const missing = template.arguments
    .filter((arg) => arg.required === true)
    .map((arg) => arg.name)
    .filter((argName) => {
      const value = args[argName];
      return value === undefined || value.trim() === '';
    });
  if (missing.length > 0) {
    throw new Error(
      `prompt ${JSON.stringify(name)} is missing required argument(s): ${missing.join(', ')}`,
    );
  }

  const text = template.render(args);
  return {
    description: template.description,
    messages: [
      {
        role: 'user',
        content: { type: 'text', text },
      },
    ],
  };
}

/**
 * Wire the prompts surface onto an `McpServer`. Declares the `prompts`
 * capability and registers `prompts/list` + `prompts/get`. Called from
 * `KnowledgeBaseServer.buildMcpServer` only when `KB_MCP_PROMPTS` is on.
 */
export function registerPrompts(mcp: McpServer): void {
  mcp.server.registerCapabilities({
    prompts: {
      listChanged: false,
    },
  });

  mcp.server.setRequestHandler(ListPromptsRequestSchema, async () => listPrompts());
  mcp.server.setRequestHandler(GetPromptRequestSchema, async (request) =>
    getPrompt(request.params.name, request.params.arguments),
  );
}
