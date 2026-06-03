// src/e2e/mcp-binary.e2e.test.ts
//
// Issue #222 — v0 of the spawn-the-binary MCP-client end-to-end harness.
//
// These tests boot the real `build/index.js` over stdio (the same way
// every production MCP client launches it) and drive the server through
// `@modelcontextprotocol/sdk`'s `Client` + `StdioClientTransport`. They
// are the FIRST tests in the repo that exercise the binary itself; all
// 30+ in-process Jest tests stop short of `process.spawn`.
//
// The original v0 suite covered only handlers that do not need an embedder
// (`tools/list`, `list_knowledge_bases`, `list_models`). Retrieval parity now
// uses the deterministic fake provider and a temp active model registration so
// `retrieve_knowledge` can run through the real binary without network.
//
// The suite is gated behind `KB_RUN_E2E=1` (also enforced by
// `jest.config.js` testPathIgnorePatterns) so the default `npm test`
// inner-loop stays fast and stays buildless. Anyone running this suite
// must first `npm run build`; the harness asserts the binary exists and
// fails loudly otherwise.

import { spawnSync } from 'child_process';
import * as path from 'path';
import {
  startMcpBinaryHarness,
  parseToolJsonText,
  type E2eHarness,
} from './test-fixtures.js';

const RUN_E2E = process.env.KB_RUN_E2E === '1';
const REPO_ROOT = path.resolve(process.cwd());
const CLI_BINARY = path.join(REPO_ROOT, 'build', 'cli.js');
const FAKE_PARITY_MODEL_ID = 'fake__parity-32d';
const FAKE_PARITY_MODEL_NAME = 'parity-32d';

interface RetrievalIdentity {
  chunkId: string;
  source: string;
  relativePath: string;
  knowledgeBase: string;
  chunkIndex: number;
}

interface CliSearchPayload {
  results: Array<{
    chunk_id?: unknown;
    metadata?: {
      source?: unknown;
      relativePath?: unknown;
      knowledgeBase?: unknown;
      chunkIndex?: unknown;
    };
  }>;
}

function parseCliSearchPayload(stdout: string): CliSearchPayload {
  const payload = JSON.parse(stdout) as { results?: unknown };
  if (!Array.isArray(payload.results)) {
    throw new Error(`Expected CLI search JSON with results[], got: ${stdout}`);
  }
  return payload as CliSearchPayload;
}

function identityFromCliResult(result: CliSearchPayload['results'][number]): RetrievalIdentity {
  const chunkId = result.chunk_id;
  const metadata = result.metadata;
  if (
    typeof chunkId !== 'string' ||
    !metadata ||
    typeof metadata.source !== 'string' ||
    typeof metadata.relativePath !== 'string' ||
    typeof metadata.knowledgeBase !== 'string' ||
    typeof metadata.chunkIndex !== 'number'
  ) {
    throw new Error(`CLI result is missing stable identity fields: ${JSON.stringify(result)}`);
  }
  return {
    chunkId,
    source: metadata.source,
    relativePath: metadata.relativePath,
    knowledgeBase: metadata.knowledgeBase,
    chunkIndex: metadata.chunkIndex,
  };
}

function extractMcpMarkdownText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const first = content?.[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`Expected first content block to be text, got: ${JSON.stringify(result)}`);
  }
  return first.text;
}

function parseMcpRetrievalIdentities(markdown: string): RetrievalIdentity[] {
  const sourceBlocks = [...markdown.matchAll(/\*\*Source:\*\* \[([^\]]+)\]\([^)]+\)[\s\S]*?```json\n([\s\S]*?)\n```/g)];
  return sourceBlocks.map((match) => {
    const chunkId = match[1];
    const metadata = JSON.parse(match[2]) as {
      source?: unknown;
      relativePath?: unknown;
      knowledgeBase?: unknown;
      chunkIndex?: unknown;
    };
    if (
      typeof metadata.source !== 'string' ||
      typeof metadata.relativePath !== 'string' ||
      typeof metadata.knowledgeBase !== 'string' ||
      typeof metadata.chunkIndex !== 'number'
    ) {
      throw new Error(`MCP metadata block is missing stable identity fields: ${match[2]}`);
    }
    return {
      chunkId,
      source: metadata.source,
      relativePath: metadata.relativePath,
      knowledgeBase: metadata.knowledgeBase,
      chunkIndex: metadata.chunkIndex,
    };
  });
}

function runKbCliSearch(
  harness: E2eHarness,
  args: string[],
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [CLI_BINARY, 'search', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? '',
      KNOWLEDGE_BASES_ROOT_DIR: harness.knowledgeBasesRootDir,
      FAISS_INDEX_PATH: harness.faissIndexPath,
      REINDEX_TRIGGER_POLL_MS: '0',
      EMBEDDING_PROVIDER: 'fake',
      KB_FAKE_DIM: '32',
    },
  });
}

(RUN_E2E ? describe : describe.skip)('mcp-binary E2E (spawn build/index.js over stdio)', () => {
  jest.setTimeout(30_000);

  let harness: E2eHarness | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.shutdown();
      harness = undefined;
    }
  });

  it('initializes and returns the expected tool catalog via tools/list', async () => {
    harness = await startMcpBinaryHarness();

    const result = await harness.client.listTools();
    const toolNames = result.tools.map((tool) => tool.name).sort();

    // The set of MCP tools is the production wire-shape contract — every
    // production client (Claude Desktop, Codex CLI, Cursor, Continue,
    // Cline) ingests this list and offers each tool to the agent. A
    // silent rename or removal would be a breaking change for every
    // downstream user. Pin the set explicitly so a regression here
    // forces an intentional update of the assertion.
    expect(toolNames).toEqual([
      'add_document',
      'ask_knowledge',
      'delete_document',
      'diff_index',
      'kb_stats',
      'list_knowledge_bases',
      'list_models',
      'reindex_knowledge_base',
      'retrieve_knowledge',
    ]);

    // Sanity-check that descriptions survived JSON-RPC serialisation —
    // the server-side `mcp.tool(name, description, …)` API is one of the
    // surfaces a hand-rolled wire-shape regression (e.g. swapping
    // arguments) would silently break.
    for (const tool of result.tools) {
      expect(typeof tool.description).toBe('string');
      expect(tool.description!.length).toBeGreaterThan(0);
    }
  });

  it('list_knowledge_bases returns the names of seeded KBs and filters dot-prefixed entries', async () => {
    harness = await startMcpBinaryHarness({
      knowledgeBases: {
        alpha: { files: { 'note.md': '# alpha\n\nfirst KB' } },
        beta: { files: { 'doc.md': '# beta\n\nsecond KB' } },
      },
    });

    // Hidden entries (`.`-prefixed) must be filtered — the server uses
    // them for FAISS sidecars (`.faiss`) and the reindex trigger
    // (`.reindex-trigger`). Drop one in to assert the filter survives
    // serialisation through the wire path, not just the unit test for
    // `listKnowledgeBases()`.
    const fsp = await import('fs/promises');
    const path = await import('path');
    await fsp.mkdir(path.join(harness.knowledgeBasesRootDir, '.hidden-kb'), {
      recursive: true,
    });

    const result = await harness.client.callTool({
      name: 'list_knowledge_bases',
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const payload = parseToolJsonText(result as Parameters<typeof parseToolJsonText>[0]);
    expect(Array.isArray(payload)).toBe(true);
    expect([...(payload as string[])].sort()).toEqual(['alpha', 'beta']);
  });

  it('list_models returns an empty array for a fresh KB tree with no registered models', async () => {
    harness = await startMcpBinaryHarness();

    const result = await harness.client.callTool({
      name: 'list_models',
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const payload = parseToolJsonText(result as Parameters<typeof parseToolJsonText>[0]);
    expect(payload).toEqual([]);
  });

  it('keeps binary CLI search and MCP retrieve_knowledge dense results aligned on stable chunk identities', async () => {
    harness = await startMcpBinaryHarness({
      activeModel: {
        modelId: FAKE_PARITY_MODEL_ID,
        modelName: FAKE_PARITY_MODEL_NAME,
      },
      extraEnv: {
        EMBEDDING_PROVIDER: 'fake',
        KB_FAKE_DIM: '32',
      },
      knowledgeBases: {
        parity: {
          files: {
            'alpha.md': '# Alpha\n\nalpha retrieval parity apple banana anchor\n',
            'beta.md': '# Beta\n\nbeta retrieval parity orange grape anchor\n',
          },
        },
      },
    });

    const cli = runKbCliSearch(harness, [
      'alpha retrieval parity apple',
      '--refresh',
      '--kb=parity',
      '--format=json',
      '--no-freshness',
      '--no-gate',
    ]);
    expect(cli.status).toBe(0);
    const cliPayload = parseCliSearchPayload(String(cli.stdout));
    const cliIdentities = cliPayload.results.map(identityFromCliResult);
    expect(cliIdentities.length).toBeGreaterThan(0);

    const mcpResult = await harness.client.callTool({
      name: 'retrieve_knowledge',
      arguments: {
        query: 'alpha retrieval parity apple',
        knowledge_base_name: 'parity',
        search_mode: 'dense',
        gate: 'off',
      },
    });
    expect(mcpResult.isError).toBeFalsy();
    const mcpIdentities = parseMcpRetrievalIdentities(extractMcpMarkdownText(mcpResult));

    expect(mcpIdentities).toEqual(cliIdentities);
  });
});
