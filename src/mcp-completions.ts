// mcp-completions.ts — MCP completion/complete support (#684).
//
// This module owns server-driven completions for argument values. It keeps the
// resolver pure and dependency-injected for tests, while the registered server
// path uses the same KB, resource, and model registries as the existing MCP
// surfaces.

import {
  CompleteRequestSchema,
  type CompleteRequest,
  type CompleteResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listRegisteredModels } from './active-model.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { KB_PROMPT_TEMPLATES } from './config/mcp-descriptions.js';
import { listKnowledgeBases } from './kb-fs.js';
import { listResources, parseKnowledgeBaseResourceUri } from './mcp-resources.js';

const KB_RESOURCE_TEMPLATE_URI = 'kb://{kb}/{path}';
const MAX_COMPLETION_VALUES = 100;

type CompletionParams = CompleteRequest['params'];

interface PathCompletionPage {
  values: string[];
  hasMore: boolean;
  total?: number;
}

export interface McpCompletionDependencies {
  listKnowledgeBaseNames?: () => Promise<string[]>;
  listModelIds?: () => Promise<string[]>;
  listResourcePaths?: (kbName: string, prefix: string, limit: number) => Promise<PathCompletionPage>;
}

const EMPTY_COMPLETION: CompleteResult = {
  completion: {
    values: [],
    hasMore: false,
  },
};

function resultFromValues(values: readonly string[], options: { total?: number; hasMore?: boolean } = {}): CompleteResult {
  const page = values.slice(0, MAX_COMPLETION_VALUES);
  return {
    completion: {
      values: page,
      ...(options.total !== undefined ? { total: options.total } : {}),
      hasMore: options.hasMore ?? values.length > MAX_COMPLETION_VALUES,
    },
  };
}

function filterPrefix(values: readonly string[], prefix: string): string[] {
  return [...values]
    .filter((value) => value.startsWith(prefix))
    .sort((a, b) => a.localeCompare(b));
}

function isKnowledgeBaseArgument(name: string): boolean {
  return name === 'kb' || name === 'kbName' || name === 'knowledge_base_name' || name === 'knowledgeBase';
}

function isModelArgument(name: string): boolean {
  return name === 'model_id' || name === 'model_name' || name === 'modelId' || name === 'modelName';
}

function knownPromptArgument(promptName: string, argumentName: string): boolean {
  const template = KB_PROMPT_TEMPLATES.find((prompt) => prompt.name === promptName);
  if (template === undefined) return false;
  return template.arguments.some((arg) => arg.name === argumentName);
}

async function defaultListKnowledgeBaseNames(): Promise<string[]> {
  return listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
}

async function defaultListModelIds(): Promise<string[]> {
  return (await listRegisteredModels()).map((model) => model.model_id);
}

async function defaultListResourcePaths(kbName: string, prefix: string, limit: number): Promise<PathCompletionPage> {
  const listed = await listResources({
    kbName,
    prefix,
    limit,
  });
  const values: string[] = [];
  for (const resource of listed.resources) {
    try {
      values.push(parseKnowledgeBaseResourceUri(resource.uri).relativePath);
    } catch {
      // listResources only returns kb:// URIs from this process. If a future
      // resource slips through, omit it from completion rather than failing the
      // entire completion request.
    }
  }
  return {
    values,
    hasMore: listed.nextCursor !== undefined,
  };
}

async function completeKnowledgeBaseName(prefix: string, deps: Required<McpCompletionDependencies>): Promise<CompleteResult> {
  const matches = filterPrefix(await deps.listKnowledgeBaseNames(), prefix);
  return resultFromValues(matches, { total: matches.length });
}

async function completeModelId(prefix: string, deps: Required<McpCompletionDependencies>): Promise<CompleteResult> {
  const matches = filterPrefix(await deps.listModelIds(), prefix);
  return resultFromValues(matches, { total: matches.length });
}

async function completeResourcePath(
  params: CompletionParams,
  deps: Required<McpCompletionDependencies>,
): Promise<CompleteResult> {
  const kbName = params.context?.arguments?.kb;
  if (kbName === undefined || kbName.trim() === '') return EMPTY_COMPLETION;

  const page = await deps.listResourcePaths(kbName, params.argument.value, MAX_COMPLETION_VALUES + 1);
  return resultFromValues(page.values, {
    total: page.total,
    hasMore: page.hasMore || page.values.length > MAX_COMPLETION_VALUES,
  });
}

function requiredDependencies(deps: McpCompletionDependencies): Required<McpCompletionDependencies> {
  return {
    listKnowledgeBaseNames: deps.listKnowledgeBaseNames ?? defaultListKnowledgeBaseNames,
    listModelIds: deps.listModelIds ?? defaultListModelIds,
    listResourcePaths: deps.listResourcePaths ?? defaultListResourcePaths,
  };
}

export async function completeMcpArgument(
  params: CompletionParams,
  deps: McpCompletionDependencies = {},
): Promise<CompleteResult> {
  const resolvedDeps = requiredDependencies(deps);
  const argumentName = params.argument.name;
  const argumentValue = params.argument.value;

  if (params.ref.type === 'ref/resource') {
    if (params.ref.uri !== KB_RESOURCE_TEMPLATE_URI) return EMPTY_COMPLETION;
    if (isKnowledgeBaseArgument(argumentName)) {
      return completeKnowledgeBaseName(argumentValue, resolvedDeps);
    }
    if (argumentName === 'path') {
      return completeResourcePath(params, resolvedDeps);
    }
    return EMPTY_COMPLETION;
  }

  if (params.ref.type === 'ref/prompt') {
    if (!knownPromptArgument(params.ref.name, argumentName)) return EMPTY_COMPLETION;
    if (isKnowledgeBaseArgument(argumentName)) {
      return completeKnowledgeBaseName(argumentValue, resolvedDeps);
    }
    if (isModelArgument(argumentName)) {
      return completeModelId(argumentValue, resolvedDeps);
    }
  }

  return EMPTY_COMPLETION;
}

export function registerCompletions(mcp: McpServer): void {
  mcp.server.registerCapabilities({
    completions: {},
  });

  mcp.server.setRequestHandler(CompleteRequestSchema, async (request) =>
    completeMcpArgument(request.params),
  );
}

export { KB_RESOURCE_TEMPLATE_URI, MAX_COMPLETION_VALUES };
