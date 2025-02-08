#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const KNOWLEDGE_BASES_ROOT_DIR = process.env.KNOWLEDGE_BASES_ROOT_DIR || path.join(os.homedir(), 'knowledge_bases');

class KnowledgeBaseServer {
  private server: Server;

  constructor() {
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
          description: 'Retrieves information from a specified knowledge base.',
          inputSchema: {
            type: 'object',
            properties: {
              "knowledge_base_name": {
                "type": "string",
                "description": "Name of the knowledge base to query (e.g., 'company', 'it_support', 'onboarding').",
              },
            },
            "required": ["knowledge_base_name"]
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
      const knowledgeBases = await fs.readdir(KNOWLEDGE_BASES_ROOT_DIR);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(knowledgeBases, null, 2),
          },
        ],
      };
    } catch (error: any) {
      console.error("Error listing knowledge bases:", error);
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
    if (!args || typeof args.knowledge_base_name !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments for retrieve_knowledge');
    }

    const knowledgeBaseName = args.knowledge_base_name;
    const knowledgeBasePath = path.join(KNOWLEDGE_BASES_ROOT_DIR, knowledgeBaseName);

    try {
      const files = await fs.readdir(knowledgeBasePath);
      let allContent = '';
      for (const file of files) {
        const filePath = path.join(knowledgeBasePath, file);
        const content = await fs.readFile(filePath, 'utf-8');
        allContent += content + '\n';
      }

      return {
        content: [
          {
            type: 'text',
            text: allContent,
          },
        ],
      };
    } catch (error: any) {
      console.error("Error retrieving knowledge:", error);
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
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Knowledge Base MCP server running on stdio');
  }
}

const server = new KnowledgeBaseServer();
server.run().catch(console.error);
