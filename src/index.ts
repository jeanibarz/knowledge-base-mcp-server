#!/usr/bin/env node
import { KnowledgeBaseServer } from './KnowledgeBaseServer.js';

const server = new KnowledgeBaseServer();
server.run().catch(console.error);
