// src/e2e/http-sse-transport.e2e.test.ts
//
// Issue #548 — end-to-end coverage for the remote MCP transports. The
// stdio e2e suite proves the built binary works for local clients; this
// suite boots that same binary with MCP_TRANSPORT=http/sse, waits for the
// real HTTP listener, connects via the MCP SDK remote client transports,
// and exercises the authenticated wire path through tools/list and
// retrieve_knowledge.

import {
  startRemoteMcpBinaryHarness,
  type RemoteE2eHarness,
  type RemoteMcpTransport,
} from './test-fixtures.js';

const RUN_E2E = process.env.KB_RUN_E2E === '1';
const FAKE_REMOTE_MODEL_ID = 'fake__remote-32d';
const FAKE_REMOTE_MODEL_NAME = 'remote-32d';
const REQUEST_TIMEOUT_MS = 60_000;

const REMOTE_TRANSPORTS: RemoteMcpTransport[] = ['http', 'sse'];

function extractToolText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const first = content?.[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`Expected first content block to be text, got: ${JSON.stringify(result)}`);
  }
  return first.text;
}

(RUN_E2E ? describe : describe.skip)('HTTP/SSE MCP transport E2E', () => {
  jest.setTimeout(90_000);

  let harness: RemoteE2eHarness | undefined;

  afterEach(async () => {
    if (harness) {
      await harness.shutdown();
      harness = undefined;
    }
  });

  it.each(REMOTE_TRANSPORTS)(
    'connects over %s, lists tools, and retrieves seeded knowledge',
    async (transport) => {
      harness = await startRemoteMcpBinaryHarness({
        transport,
        activeModel: {
          modelId: FAKE_REMOTE_MODEL_ID,
          modelName: FAKE_REMOTE_MODEL_NAME,
        },
        extraEnv: {
          EMBEDDING_PROVIDER: 'fake',
          KB_FAKE_DIM: '32',
        },
        knowledgeBases: {
          remote: {
            files: {
              'transport.md':
                '# Remote transport\n\nremote HTTP SSE retrieval apple anchor verifies the wire path\n',
            },
          },
        },
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      });

      const tools = await harness.client.listTools(undefined, {
        timeout: REQUEST_TIMEOUT_MS,
      });
      const toolNames = tools.tools.map((tool) => tool.name);
      expect(toolNames).toContain('retrieve_knowledge');
      expect(toolNames).toContain('reindex_knowledge_base');

      const reindex = await harness.client.callTool(
        {
          name: 'reindex_knowledge_base',
          arguments: { knowledge_base_name: 'remote' },
        },
        undefined,
        { timeout: REQUEST_TIMEOUT_MS },
      );
      expect(reindex.isError).toBeFalsy();

      const retrieval = await harness.client.callTool(
        {
          name: 'retrieve_knowledge',
          arguments: {
            query: 'remote retrieval apple anchor',
            knowledge_base_name: 'remote',
            search_mode: 'dense',
            gate: 'off',
          },
        },
        undefined,
        { timeout: REQUEST_TIMEOUT_MS },
      );

      expect(retrieval.isError).toBeFalsy();
      const text = extractToolText(retrieval);
      expect(text).toContain('transport.md');
      expect(text).toContain('remote HTTP SSE retrieval apple anchor');
    },
  );

  it.each(REMOTE_TRANSPORTS)(
    'rejects missing and invalid bearer tokens over %s',
    async (transport) => {
      harness = await startRemoteMcpBinaryHarness({
        transport,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      });

      const missingToken = await fetch(harness.mcpUrl);
      expect(missingToken.status).toBe(401);
      expect(await missingToken.text()).toContain('Unauthorized');
      expect(missingToken.headers.get('www-authenticate')).toContain('Bearer');

      const invalidToken = await fetch(harness.mcpUrl, {
        headers: {
          Authorization: `Bearer ${harness.authToken.slice(0, -1)}x`,
        },
      });
      expect(invalidToken.status).toBe(401);
      expect(await invalidToken.text()).toContain('Unauthorized');
    },
  );
});
