// FaissIndexManager.ts
import * as fsp from 'fs/promises';
import * as fs from 'fs';
import * as path from 'path';
import { HuggingFaceInferenceEmbeddings } from "@langchain/community/embeddings/hf";
import { OllamaEmbeddings } from "@langchain/ollama";
import { FaissStore } from "@langchain/community/vectorstores/faiss";
import { Document } from "@langchain/core/documents";
import { MarkdownTextSplitter } from "langchain/text_splitter";
import { calculateSHA256, getFilesRecursively } from './utils.js';
import {
  KNOWLEDGE_BASES_ROOT_DIR,
  FAISS_INDEX_PATH,
  EMBEDDING_PROVIDER,
  HUGGINGFACE_MODEL_NAME,
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
} from './config.js';
import { logger } from './logger.js';

const MODEL_NAME_FILE = path.join(FAISS_INDEX_PATH, 'model_name.txt');

type FsError = NodeJS.ErrnoException & { code?: string };

function isPermissionError(error: unknown): error is FsError {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as FsError).code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

function handleFsOperationError(action: string, targetPath: string, error: unknown): never {
  const pathDescription = path.resolve(targetPath);
  const stack = (error as Error)?.stack;
  if (isPermissionError(error)) {
    const message = `Permission denied while attempting to ${action} ${pathDescription}. Grant write access and retry.`;
    logger.error(message);
    if (stack) {
      logger.error(stack);
    }
    const loggedError = new Error(message, { cause: error instanceof Error ? error : undefined }) as Error & {
      __alreadyLogged?: boolean;
    };
    loggedError.__alreadyLogged = true;
    throw loggedError;
  }
  logger.error(`Failed to ${action} ${pathDescription}:`, error);
  if (stack) {
    logger.error(stack);
  }
  if (error instanceof Error) {
    (error as Error & { __alreadyLogged?: boolean }).__alreadyLogged = true;
    throw error;
  }
  const newError = new Error(`Failed to ${action} ${pathDescription}: ${String(error)}`) as Error & {
    __alreadyLogged?: boolean;
  };
  newError.__alreadyLogged = true;
  throw newError;
}

export class FaissIndexManager {
  private faissIndex: FaissStore | null = null;
  private embeddings: HuggingFaceInferenceEmbeddings | OllamaEmbeddings;
  private modelName: string;
  private embeddingProvider: string;

  constructor() {
    this.embeddingProvider = EMBEDDING_PROVIDER;

    if (this.embeddingProvider === 'ollama') {
      logger.info('Initializing FaissIndexManager with Ollama embeddings');
      this.modelName = OLLAMA_MODEL;
      this.embeddings = new OllamaEmbeddings({
        baseUrl: OLLAMA_BASE_URL,
        model: this.modelName,
      });
    } else {
      logger.info('Initializing FaissIndexManager with HuggingFace embeddings');
      const huggingFaceApiKey = process.env.HUGGINGFACE_API_KEY;
      if (!huggingFaceApiKey) {
        throw new Error('HUGGINGFACE_API_KEY environment variable is required when using HuggingFace provider');
      }

      this.modelName = HUGGINGFACE_MODEL_NAME;
      this.embeddings = new HuggingFaceInferenceEmbeddings({
        apiKey: huggingFaceApiKey,
        model: this.modelName,
      });
    }

    logger.info(`Using embedding provider: ${this.embeddingProvider}, model: ${this.modelName}`);
  }

  async initialize(): Promise<void> {
    try {
      if (!fs.existsSync(FAISS_INDEX_PATH)) {
        try {
          await fsp.mkdir(FAISS_INDEX_PATH, { recursive: true });
        } catch (error) {
          handleFsOperationError('create FAISS index directory', FAISS_INDEX_PATH, error);
        }
      }
      const indexFilePath = path.join(FAISS_INDEX_PATH, 'faiss.index');
      let storedModelName: string | null = null;

      try {
        storedModelName = fs.existsSync(MODEL_NAME_FILE) ? (await fsp.readFile(MODEL_NAME_FILE, 'utf-8')) : null;
      } catch (error) {
        logger.warn('Error reading stored model name:', error);
      }

      if (storedModelName && storedModelName !== this.modelName) {
        logger.warn(`Model name has changed from ${storedModelName} to ${this.modelName}. Recreating index.`);
        if (fs.existsSync(indexFilePath)) {
          try {
            await fsp.unlink(indexFilePath);
            logger.info('Existing FAISS index deleted.');
          } catch (error) {
            handleFsOperationError('delete stale FAISS index', indexFilePath, error);
          }
        }
        this.faissIndex = null; // Ensure index is recreated
      }

      if (fs.existsSync(indexFilePath)) {
        logger.info('Loading existing FAISS index from:', indexFilePath);
        try {
          this.faissIndex = await FaissStore.load(indexFilePath, this.embeddings);
        } catch (error) {
          handleFsOperationError('load FAISS index from', indexFilePath, error);
        }
        logger.info('FAISS index loaded.');
      } else {
        logger.info('FAISS index file not found at', indexFilePath, '. It will be created if documents are available.');
        this.faissIndex = null;
      }

      // Save the current model name for future checks
      try {
        await fsp.writeFile(MODEL_NAME_FILE, this.modelName, 'utf-8');
      } catch (error) {
        handleFsOperationError('persist embedding model metadata in', MODEL_NAME_FILE, error);
      }
    } catch (error: any) {
      if (!error?.__alreadyLogged) {
        logger.error('Error initializing FAISS index:', error);
        if (error?.stack) {
          logger.error(error.stack);
        }
      }
      throw error;
    }
  }

  /**
   * Updates the FAISS index.
   * If `specificKnowledgeBase` is provided, only files from that knowledge base will be checked and updated.
   * If no update occurs (and the FAISS index remains uninitialized) but there are documents,
   * then the index is built from all available files.
   */
  async updateIndex(specificKnowledgeBase?: string): Promise<void> {
    logger.debug('Updating FAISS index...');
    try {
      let knowledgeBases: string[] = [];
      if (specificKnowledgeBase) {
        knowledgeBases.push(specificKnowledgeBase);
      } else {
        knowledgeBases = await fsp.readdir(KNOWLEDGE_BASES_ROOT_DIR);
      }

      let anyFileProcessed = false;

      // Process each knowledge base directory.
      for (const knowledgeBaseName of knowledgeBases) {
        if (knowledgeBaseName.startsWith('.')) {
          logger.debug(`Skipping dot folder: ${knowledgeBaseName}`);
          continue;
        }
        const knowledgeBasePath = path.join(KNOWLEDGE_BASES_ROOT_DIR, knowledgeBaseName);
        const filePaths = await getFilesRecursively(knowledgeBasePath);

        for (const filePath of filePaths) {
          anyFileProcessed = true;

          const fileHash = await calculateSHA256(filePath);
          const relativePath = path.relative(knowledgeBasePath, filePath);
          const indexDirPath = path.join(knowledgeBasePath, '.index', path.dirname(relativePath));
          const indexFilePath = path.join(indexDirPath, path.basename(filePath));

          if (!fs.existsSync(indexDirPath)) {
            try {
              await fsp.mkdir(indexDirPath, { recursive: true });
            } catch (error) {
              handleFsOperationError('create index metadata directory', indexDirPath, error);
            }
          }

          let storedHash: string | null = null;
          try {
            const buffer = await fsp.readFile(indexFilePath);
            storedHash = buffer.toString('utf-8');
          } catch (error) {
            // The hash file may not exist yet; that's fine.
          }

          // If the file is new or has changed, process it.
          if (fileHash !== storedHash) {
            logger.info(`File ${filePath} has changed. Updating index...`);
            let content = '';
            try {
              content = await fsp.readFile(filePath, 'utf-8');
            } catch (error: any) {
              logger.error(`Error reading file ${filePath}:`, error);
              continue;
            }

            let documentsToAdd: Document[] = [];
            if (path.extname(filePath).toLowerCase() === '.md') {
              const splitter = new MarkdownTextSplitter({
                chunkSize: 1000,
                chunkOverlap: 200,
                keepSeparator: false,
              });
              documentsToAdd = await splitter.createDocuments([content], [{ source: filePath }]);
            } else {
              documentsToAdd = [
                new Document({
                  pageContent: content,
                  metadata: { source: filePath },
                }),
              ];
            }

            if (documentsToAdd.length > 0) {
              if (this.faissIndex === null) {
                logger.info('Creating new FAISS index from texts...');
                this.faissIndex = await FaissStore.fromTexts(
                  documentsToAdd.map((doc) => doc.pageContent),
                  documentsToAdd.map((doc) => doc.metadata),
                  this.embeddings
                );
              } else {
                await this.faissIndex.addDocuments(documentsToAdd);
              }
              const indexFileSavePath = path.join(FAISS_INDEX_PATH, 'faiss.index');
              try {
                await this.faissIndex.save(indexFileSavePath);
                logger.info('FAISS index saved successfully to', indexFileSavePath);
              } catch (saveError: any) {
                handleFsOperationError('save FAISS index at', indexFileSavePath, saveError);
              }
              try {
                await fsp.writeFile(indexFilePath, fileHash, { encoding: 'utf-8' });
              } catch (error) {
                handleFsOperationError('write file hash metadata to', indexFilePath, error);
              }
              logger.info(`Index updated for ${filePath}.`);
            } else {
              logger.debug(`No documents generated from ${filePath}. Skipping index update.`);
            }
          } else {
            logger.debug(`File ${filePath} unchanged, skipping.`);
          }
        }
      }

      // If at least one file was processed but no changes triggered index creation,
      // then attempt to build the FAISS index from all available documents.
      if (this.faissIndex === null && anyFileProcessed) {
        logger.info('No updates detected but FAISS index is not initialized. Building index from all available documents...');
        let allDocuments: Document[] = [];
        for (const knowledgeBaseName of knowledgeBases) {
          if (knowledgeBaseName.startsWith('.')) continue;
          const knowledgeBasePath = path.join(KNOWLEDGE_BASES_ROOT_DIR, knowledgeBaseName);
          const filePaths = await getFilesRecursively(knowledgeBasePath);
          for (const filePath of filePaths) {
            let content = '';
            try {
              content = await fsp.readFile(filePath, 'utf-8');
            } catch (error) {
              logger.error(`Error reading file ${filePath}:`, error);
              continue;
            }
            let documents: Document[];
            if (path.extname(filePath).toLowerCase() === '.md') {
              const splitter = new MarkdownTextSplitter({
                chunkSize: 1000,
                chunkOverlap: 200,
                keepSeparator: false,
              });
              documents = await splitter.createDocuments([content], [{ source: filePath }]);
            } else {
              documents = [
                new Document({
                  pageContent: content,
                  metadata: { source: filePath },
                }),
              ];
            }
            if (documents.length > 0) {
              allDocuments.push(...documents);
            }
          }
        }
        if (allDocuments.length > 0) {
          this.faissIndex = await FaissStore.fromTexts(
            allDocuments.map((doc) => doc.pageContent),
            allDocuments.map((doc) => doc.metadata),
            this.embeddings
          );
          const indexFileSavePath = path.join(FAISS_INDEX_PATH, 'faiss.index');
          try {
            await this.faissIndex.save(indexFileSavePath);
            logger.info('FAISS index saved successfully to', indexFileSavePath);
          } catch (saveError: any) {
            handleFsOperationError('save FAISS index at', indexFileSavePath, saveError);
          }
        }
      }
      logger.debug('FAISS index update process completed.');
    } catch (error: any) {
      if (!error?.__alreadyLogged) {
        logger.error('Error updating FAISS index:', error);
        if (error?.stack) {
          logger.error(error.stack);
        }
      }
      throw error;
    }
  }

  /**
   * Performs a similarity search and returns the results with their similarity scores.
   */
  async similaritySearch(query: string, k: number, threshold: number = 2) {
    if (!this.faissIndex) {
      throw new Error('FAISS index is not initialized');
    }

    const filter = { score: { $lte: threshold } };

    // Use the vector store's method that returns [DocumentInterface, number] tuples.
    const resultsWithScore = await this.faissIndex.similaritySearchWithScore(query, k, filter);
    // Map the tuple into an object that includes the score.
    return resultsWithScore.map(([doc, score]) => ({
      ...doc,
      score,
    }));
  }
}
