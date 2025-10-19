// KnowledgeBaseServer.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
import * as fsp from 'fs/promises';
import { FaissIndexManager } from './FaissIndexManager.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config.js';
import { logger } from './logger.js';

export class KnowledgeBaseServer {
  private mcp: McpServer;
  private faissManager: FaissIndexManager;

  constructor() {
    this.faissManager = new FaissIndexManager();
    logger.info('Initializing KnowledgeBaseServer');

    this.mcp = new McpServer({
      name: 'knowledge-base-server',
      version: '0.1.0',
    });

    this.setupTools();

    this.mcp.server.onerror = (error) => logger.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.mcp.close();
      process.exit(0);
    });
  }

  private setupTools() {
    this.mcp.tool(
      'list_knowledge_bases',
      'Lists the available knowledge bases.',
      async () => this.handleListKnowledgeBases()
    );

    this.mcp.tool(
      'retrieve_knowledge',
      'Retrieves similar chunks from the knowledge base based on a query. Optionally, if a knowledge base is specified, only that one is searched; otherwise, all available knowledge bases are considered. By default, at most 10 documents are returned with a score below a threshold of 2. A different threshold can optionally be provided.',
      {
        query: z.string(),
        knowledge_base_name: z.string().optional(),
        threshold: z.number().optional(),
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
      const similaritySearchResults = await this.faissManager.similaritySearch(query, 10, threshold);
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
    try {
      const transport = new StdioServerTransport();
      await this.mcp.connect(transport);
      logger.info('Knowledge Base MCP server running on stdio');
      await this.faissManager.initialize();
    } catch (error: any) {
      logger.error('Error during server startup:', error);
      if (error?.stack) {
        logger.error(error.stack);
      }
    }
  }
}
