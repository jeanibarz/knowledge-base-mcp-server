// KnowledgeBaseServer.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
import * as fsp from 'fs/promises';
import { FaissIndexManager } from './FaissIndexManager.js';
import {
  KNOWLEDGE_BASES_ROOT_DIR,
  LIST_KNOWLEDGE_BASES_DESCRIPTION,
  loadTransportConfig,
  RETRIEVE_KNOWLEDGE_DESCRIPTION,
  TransportConfigError,
  type TransportConfig,
} from './config.js';
import { logger } from './logger.js';
import { SseHost } from './transport/sse.js';

const SERVER_NAME = 'knowledge-base-server';
const SERVER_VERSION = '0.1.0';

export class KnowledgeBaseServer {
  private mcp: McpServer;
  private faissManager: FaissIndexManager;
  private sseHost?: SseHost;
  private shutdownInstalled = false;

  constructor() {
    this.faissManager = new FaissIndexManager();
    logger.info('Initializing KnowledgeBaseServer');

    this.mcp = this.buildMcpServer();

    process.on('SIGINT', async () => {
      await this.shutdown();
      process.exit(0);
    });
  }

  private buildMcpServer(): McpServer {
    const mcp = new McpServer({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
    mcp.server.onerror = (error) => logger.error('[MCP Error]', error);
    this.registerTools(mcp);
    return mcp;
  }

  private registerTools(mcp: McpServer) {
    mcp.tool(
      'list_knowledge_bases',
      LIST_KNOWLEDGE_BASES_DESCRIPTION,
      async () => this.handleListKnowledgeBases()
    );

    mcp.tool(
      'retrieve_knowledge',
      RETRIEVE_KNOWLEDGE_DESCRIPTION,
      {
        query: z.string().describe('The search query to use for retrieving similar chunks from the knowledge base.'),
        knowledge_base_name: z.string().optional().describe('The name of the knowledge base to search. If omitted, all available knowledge bases are considered.'),
        threshold: z.number().optional().describe('The maximum similarity score threshold for returned documents. Defaults to 2 if not specified.'),
      },
      async (args) => this.handleRetrieveKnowledge(args)
    );
  }

  private async handleListKnowledgeBases(): Promise<CallToolResult> {
    try {
      const entries = await fsp.readdir(KNOWLEDGE_BASES_ROOT_DIR);
      const knowledgeBases = entries.filter((entry) => !entry.startsWith('.'));
      const content: TextContent = {
        type: 'text',
        text: JSON.stringify(knowledgeBases, null, 2),
      };
      return { content: [content] };
    } catch (error: any) {
      logger.error('Error listing knowledge bases:', error);
      if (error?.stack) {
        logger.error(error.stack);
      }
      const content: TextContent = {
        type: 'text',
        text: `Error listing knowledge bases: ${error.message}`,
      };
      return { content: [content], isError: true };
    }
  }

  private async handleRetrieveKnowledge(args: { query: string; knowledge_base_name?: string; threshold?: number; }): Promise<CallToolResult> {
    const query: string = args.query;
    const knowledgeBaseName: string | undefined = args.knowledge_base_name;
    const threshold: number | undefined = args.threshold;

    try {
      const startTime = Date.now();
      logger.debug(`[${startTime}] handleRetrieveKnowledge started`);

      // Update FAISS index: if a specific knowledge base is provided, update only that one; otherwise update all.
      await this.faissManager.updateIndex(knowledgeBaseName);
      logger.debug(`[${Date.now()}] FAISS index update completed`);

      // Perform similarity search using the provided query.
      const similaritySearchResults = await this.faissManager.similaritySearch(query, 10, threshold, knowledgeBaseName);
      logger.debug(`[${Date.now()}] Similarity search completed`);

      // Build a nicely formatted markdown response including the similarity score.
      let formattedResults = '';
      if (similaritySearchResults && similaritySearchResults.length > 0) {
        formattedResults = similaritySearchResults
          .map((doc, idx) => {
            const resultHeader = `**Result ${idx + 1}:**`;
            const content = doc.pageContent.trim();
            const metadata = JSON.stringify(doc.metadata, null, 2);
            const scoreText = doc.score !== undefined ? `**Score:** ${doc.score.toFixed(2)}\n\n` : '';
            return `${resultHeader}\n\n${scoreText}${content}\n\n**Source:**\n\`\`\`json\n${metadata}\n\`\`\``;
          })
          .join('\n\n---\n\n');
      } else {
        formattedResults = '_No similar results found._';
      }
      const disclaimer = '\n\n> **Disclaimer:** The provided results might not all be relevant. Please cross-check the relevance of the information.';
      const responseText = `## Semantic Search Results\n\n${formattedResults}${disclaimer}`;

      const endTime = Date.now();
      logger.debug(`[${endTime}] handleRetrieveKnowledge completed in ${endTime - startTime}ms`);

      const content: TextContent = { type: 'text', text: responseText };
      return { content: [content] };
    } catch (error: any) {
      logger.error('Error retrieving knowledge:', error);
      if (error?.stack) {
        logger.error(error.stack);
      }
      const content: TextContent = { type: 'text', text: `Error retrieving knowledge: ${error.message}` };
      return { content: [content], isError: true };
    }
  }

  async run() {
    let transportConfig: TransportConfig;
    try {
      transportConfig = loadTransportConfig();
    } catch (err) {
      if (err instanceof TransportConfigError) {
        // Fail fast on bad transport config — no partial startup state.
        logger.error(`Invalid transport configuration: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }

    try {
      if (transportConfig.transport === 'stdio') {
        await this.runStdio();
        return;
      }
      await this.runSse(transportConfig);
    } catch (error: any) {
      logger.error('Error during server startup:', error);
      if (error?.stack) {
        logger.error(error.stack);
      }
      process.exitCode = 1;
    }
  }

  private async runStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.mcp.connect(transport);
    logger.info('Knowledge Base MCP server running on stdio');
    await this.faissManager.initialize();
  }

  private async runSse(config: TransportConfig): Promise<void> {
    // Block HTTP bind on a ready index so a fast first client cannot race
    // updateIndex (RFC 008 §6.2: "client races init" footgun under HTTP).
    await this.faissManager.initialize();

    const host = new SseHost({
      config,
      createMcpServer: () => this.buildMcpServer(),
    });
    this.sseHost = host;
    this.installHttpShutdown();
    await host.start();
  }

  private installHttpShutdown(): void {
    if (this.shutdownInstalled) return;
    this.shutdownInstalled = true;
    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM, draining...');
      void this.shutdown().then(() => process.exit(0));
    });
  }

  private async shutdown(): Promise<void> {
    if (this.sseHost) {
      try {
        await this.sseHost.stop();
      } catch (err) {
        logger.warn(`Error during SSE host shutdown: ${(err as Error).message}`);
      }
      this.sseHost = undefined;
    }
    try {
      await this.mcp.close();
    } catch (err) {
      logger.warn(`Error closing root mcp: ${(err as Error).message}`);
    }
  }
}
