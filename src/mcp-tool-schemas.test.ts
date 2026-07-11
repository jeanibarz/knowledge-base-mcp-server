import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KnowledgeBaseServer } from './KnowledgeBaseServer.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function withoutDescriptions(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'description')
      .map(([key, child]) => [key, withoutDescriptions(child)]),
  );
}

describe('MCP tool JSON Schema contract', () => {
  it('pins structurally meaningful schemas emitted by a real listTools round trip', async () => {
    const fixturePath = resolve('src/__fixtures__/mcp-tool-schemas.json');
    const server = new KnowledgeBaseServer();
    const mcp = (server as unknown as { mcp: McpServer }).mcp;
    const client = new Client({ name: 'schema-contract-test', version: '0.0.0-test' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);

      const response = await client.listTools();
      expect(response.tools).toHaveLength(9);

      const emitted = Object.fromEntries(
        response.tools
          .map((tool) => [tool.name, withoutDescriptions(tool.inputSchema as JsonValue)] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
      );

      if (process.argv.includes('-u') || process.argv.includes('--updateSnapshot')) {
        await writeFile(fixturePath, `${JSON.stringify(emitted, null, 2)}\n`);
      }
      const expected = JSON.parse(await readFile(fixturePath, 'utf8')) as JsonValue;
      expect(emitted).toEqual(expected);
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});
