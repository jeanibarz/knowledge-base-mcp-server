// KnowledgeBaseServer.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { FaissIndexManager } from './FaissIndexManager.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config.js';

export class KnowledgeBaseServer {
  private server: Server;
  private faissManager: FaissIndexManager;

  constructor() {
    this.faissManager = new FaissIndexManager();
    console.error("Initializing KnowledgeBaseServer");

    this.server = new Server(
      {
        name: 'knowledge-base-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'list_knowledge_bases',
          description: 'Lists the available knowledge bases.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: []
          },
        },
        {
          name: 'retrieve_knowledge',
          description:
            'Retrieves similar chunks from the knowledge base based on a query. Optionally, if a knowledge base is specified, only that one is searched; otherwise, all available knowledge bases are considered. By default, at most 10 documents are returned with a score below a threshold of 2. A different threshold can optionally be provided.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The query text to use for semantic search.',
              },
              knowledge_base_name: {
                type: 'string',
                description:
                  "Optional. Name of the knowledge base to query (e.g., 'company', 'it_support', 'onboarding'). If omitted, the search is performed across all available knowledge bases.",
              },
              threshold: {
                type: 'number',
                description: 'Optional. The maximum similarity score to return.',
              },
            },
            required: ['query'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'list_knowledge_bases') {
        return this.handleListKnowledgeBases();
      } else if (request.params.name === 'retrieve_knowledge') {
        return this.handleRetrieveKnowledge(request.params.arguments);
      } else {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      }
    });
  }

  private async handleListKnowledgeBases() {
    try {
      const entries = await fsp.readdir(KNOWLEDGE_BASES_ROOT_DIR);
      const knowledgeBases = entries.filter((entry) => !entry.startsWith('.'));
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(knowledgeBases, null, 2),
          },
        ],
      };
    } catch (error: any) {
      console.error('Error listing knowledge bases:', error);
      console.error(error.stack);
      return {
        content: [
          {
            type: 'text',
            text: `Error listing knowledge bases: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleRetrieveKnowledge(args: any) {
    if (!args || typeof args.query !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for retrieve_knowledge: missing query');
    }
    const query: string = args.query;
    const knowledgeBaseName: string | undefined =
      typeof args.knowledge_base_name === 'string' ? args.knowledge_base_name : undefined;
    const threshold: number | undefined =
      typeof args.threshold === 'number' ? args.threshold : undefined;

    try {
      const startTime = Date.now();
      console.error(`[${startTime}] handleRetrieveKnowledge started`);

      // Update FAISS index: if a specific knowledge base is provided, update only that one; otherwise update all.
      await this.faissManager.updateIndex(knowledgeBaseName);
      console.error(`[${Date.now()}] FAISS index update completed`);

      // Perform similarity search using the provided query.
      let similaritySearchResults = await this.faissManager.similaritySearch(query, 10, threshold);
      console.error(`[${Date.now()}] Similarity search completed`);

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
          .join("\n\n---\n\n");
      } else {
        formattedResults = '_No similar results found._';
      }
      const disclaimer = "\n\n> **Disclaimer:** The provided results might not all be relevant. Please cross-check the relevance of the information.";
      const responseText = `## Semantic Search Results\n\n${formattedResults}${disclaimer}`;

      const endTime = Date.now();
      console.error(`[${endTime}] handleRetrieveKnowledge completed in ${endTime - startTime}ms`);

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
      };
    } catch (error: any) {
      console.error('Error retrieving knowledge:', error);
      console.error(error.stack);
      return {
        content: [
          {
            type: 'text',
            text: `Error retrieving knowledge: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  async run() {
    try {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('Knowledge Base MCP server running on stdio');
      await this.faissManager.initialize();
    } catch (error: any) {
      console.error('Error during server startup:', error);
      console.error(error.stack);
    }
  }
}
