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
// Scope cap for v0: only handlers that DO NOT need an embedder are
// covered (`tools/list`, `list_knowledge_bases`, `list_models`). Adding a
// deterministic stub embedder so `retrieve_knowledge` / `kb_stats` can
// be driven through the binary is intentionally left to a follow-up —
// see issue body §"Stage 2" / §"Stub embedder".
//
// The suite is gated behind `KB_RUN_E2E=1` (also enforced by
// `jest.config.js` testPathIgnorePatterns) so the default `npm test`
// inner-loop stays fast and stays buildless. Anyone running this suite
// must first `npm run build`; the harness asserts the binary exists and
// fails loudly otherwise.

import {
  startMcpBinaryHarness,
  parseToolJsonText,
  type E2eHarness,
} from './test-fixtures.js';

const RUN_E2E = process.env.KB_RUN_E2E === '1';

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
      'delete_document',
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
});
