#!/usr/bin/env node
import { logger } from './logger.js';
import { KnowledgeBaseServer } from './KnowledgeBaseServer.js';

const server = new KnowledgeBaseServer();
server.run().catch((error) => {
  logger.error('Unhandled server error:', error);
  if (error?.stack) {
    logger.error(error.stack);
  }
});
