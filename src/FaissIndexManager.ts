// FaissIndexManager.ts
import * as fsp from 'fs/promises';
import * as path from 'path';
import { HuggingFaceInferenceEmbeddings } from "@langchain/community/embeddings/hf";
import { OllamaEmbeddings } from "@langchain/ollama";
import { OpenAIEmbeddings } from "@langchain/openai";
import { FaissStore } from "@langchain/community/vectorstores/faiss";
import { Document } from "@langchain/core/documents";
import { MarkdownTextSplitter, RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import {
  calculateSHA256,
  filterIngestablePaths,
  getFilesRecursively,
  parseFrontmatter,
} from './utils.js';
import {
  KNOWLEDGE_BASES_ROOT_DIR,
  FAISS_INDEX_PATH,
  EMBEDDING_PROVIDER,
  HUGGINGFACE_MODEL_NAME,
  HUGGINGFACE_PROVIDER,
  HUGGINGFACE_ENDPOINT_URL,
  HUGGINGFACE_ENDPOINT_URL_OVERRIDDEN,
  INGEST_EXCLUDE_PATHS,
  INGEST_EXTRA_EXTENSIONS,
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
  OPENAI_MODEL_NAME,
} from './config.js';
import { logger } from './logger.js';

const MODEL_NAME_FILE = path.join(FAISS_INDEX_PATH, 'model_name.txt');

type FsError = NodeJS.ErrnoException & { code?: string };

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target);
    return true;
  } catch (error) {
    const code = (error as FsError | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return false;
    }
    throw error;
  }
}

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
  private embeddings: HuggingFaceInferenceEmbeddings | OllamaEmbeddings | OpenAIEmbeddings;
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
    } else if (this.embeddingProvider === 'openai') {
      logger.info('Initializing FaissIndexManager with OpenAI embeddings');
      const openaiApiKey = process.env.OPENAI_API_KEY;
      if (!openaiApiKey) {
        throw new Error('OPENAI_API_KEY environment variable is required when using OpenAI provider');
      }

      this.modelName = OPENAI_MODEL_NAME;
      this.embeddings = new OpenAIEmbeddings({
        apiKey: openaiApiKey,
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
        endpointUrl: HUGGINGFACE_ENDPOINT_URL,
        provider: HUGGINGFACE_ENDPOINT_URL_OVERRIDDEN ? undefined : HUGGINGFACE_PROVIDER,
      });
    }

    if (this.embeddingProvider === 'huggingface') {
      logger.info(
        `Using embedding provider: ${this.embeddingProvider}, model: ${this.modelName}, huggingface provider: ${HUGGINGFACE_ENDPOINT_URL_OVERRIDDEN ? 'endpoint override' : HUGGINGFACE_PROVIDER}`
      );
    } else {
      logger.info(`Using embedding provider: ${this.embeddingProvider}, model: ${this.modelName}`);
    }
  }

  async initialize(): Promise<void> {
    try {
      if (!(await pathExists(FAISS_INDEX_PATH))) {
        try {
          await fsp.mkdir(FAISS_INDEX_PATH, { recursive: true });
        } catch (error) {
          handleFsOperationError('create FAISS index directory', FAISS_INDEX_PATH, error);
        }
      }
      const indexFilePath = path.join(FAISS_INDEX_PATH, 'faiss.index');
      let storedModelName: string | null = null;

      try {
        storedModelName = (await pathExists(MODEL_NAME_FILE))
          ? (await fsp.readFile(MODEL_NAME_FILE, 'utf-8'))
          : null;
      } catch (error) {
        logger.warn('Error reading stored model name:', error);
      }

      if (storedModelName && storedModelName !== this.modelName) {
        logger.warn(`Model name has changed from ${storedModelName} to ${this.modelName}. Recreating index.`);
        if (await pathExists(indexFilePath)) {
          try {
            await fsp.unlink(indexFilePath);
            logger.info('Existing FAISS index deleted.');
          } catch (error) {
            handleFsOperationError('delete stale FAISS index', indexFilePath, error);
          }
        }
        this.faissIndex = null; // Ensure index is recreated
      }

      if (await pathExists(indexFilePath)) {
        logger.info('Loading existing FAISS index from:', indexFilePath);
        try {
          this.faissIndex = await FaissStore.load(indexFilePath, this.embeddings);
          logger.info('FAISS index loaded.');
        } catch (error) {
          logger.warn(
            'Existing FAISS index at',
            indexFilePath,
            'is corrupt or unreadable - rebuilding from source. Error:',
            error
          );
          try {
            await fsp.unlink(indexFilePath);
          } catch (unlinkErr) {
            handleFsOperationError('delete corrupt FAISS index', indexFilePath, unlinkErr);
          }
          // Best-effort: the .json docstore sibling may not exist (older index layouts
          // wrote only faiss.index) and any failure here is non-fatal - the rebuild
          // path will overwrite it on the next save.
          await fsp.unlink(`${indexFilePath}.json`).catch(() => {});
          this.faissIndex = null;
        }
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
   * Splits `content` into chunks and tags each chunk with the RFC 010 M1
   * metadata shape. Frontmatter (if any) is stripped before splitting so
   * the `---` fence does not leak into the embedding text.
   *
   * Both the incremental update loop and the fallback rebuild loop call
   * this helper so the metadata shape stays identical across paths.
   */
  private async buildChunkDocuments(
    filePath: string,
    content: string,
    knowledgeBaseName: string
  ): Promise<Document[]> {
    const ext = path.extname(filePath).toLowerCase();
    const splitter = ext === '.md'
      ? new MarkdownTextSplitter({
          chunkSize: 1000,
          chunkOverlap: 200,
          keepSeparator: false,
        })
      : new RecursiveCharacterTextSplitter({
          chunkSize: 1000,
          chunkOverlap: 200,
        });

    const { tags, body } = parseFrontmatter(content);
    const relativePath = path
      .relative(KNOWLEDGE_BASES_ROOT_DIR, filePath)
      .split(path.sep)
      .join('/');

    const documents = await splitter.createDocuments(
      [body],
      [{ source: filePath }]
    );
    for (let i = 0; i < documents.length; i += 1) {
      documents[i].metadata = {
        ...documents[i].metadata,
        source: filePath,
        relativePath,
        knowledgeBase: knowledgeBaseName,
        extension: ext,
        chunkIndex: i,
        tags,
      };
    }
    return documents;
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
      let indexMutated = false;
      const pendingHashWrites: { path: string; hash: string }[] = [];

      // Process each knowledge base directory.
      for (const knowledgeBaseName of knowledgeBases) {
        if (knowledgeBaseName.startsWith('.')) {
          logger.debug(`Skipping dot folder: ${knowledgeBaseName}`);
          continue;
        }
        const knowledgeBasePath = path.join(KNOWLEDGE_BASES_ROOT_DIR, knowledgeBaseName);
        const filePaths = filterIngestablePaths(
          await getFilesRecursively(knowledgeBasePath),
          knowledgeBasePath,
          {
            extraExtensions: INGEST_EXTRA_EXTENSIONS,
            excludePaths: INGEST_EXCLUDE_PATHS,
          },
        );

        for (const filePath of filePaths) {
          anyFileProcessed = true;

          const fileHash = await calculateSHA256(filePath);
          const relativePath = path.relative(knowledgeBasePath, filePath);
          const indexDirPath = path.join(knowledgeBasePath, '.index', path.dirname(relativePath));
          const indexFilePath = path.join(indexDirPath, path.basename(filePath));

          if (!(await pathExists(indexDirPath))) {
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

            const documentsToAdd: Document[] = await this.buildChunkDocuments(
              filePath,
              content,
              knowledgeBaseName
            );

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
              indexMutated = true;
              pendingHashWrites.push({ path: indexFilePath, hash: fileHash });
              logger.debug(`Index updated in-memory for ${filePath}.`);
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
          const filePaths = filterIngestablePaths(
            await getFilesRecursively(knowledgeBasePath),
            knowledgeBasePath,
            {
              extraExtensions: INGEST_EXTRA_EXTENSIONS,
              excludePaths: INGEST_EXCLUDE_PATHS,
            },
          );
          for (const filePath of filePaths) {
            let content = '';
            try {
              content = await fsp.readFile(filePath, 'utf-8');
            } catch (error) {
              logger.error(`Error reading file ${filePath}:`, error);
              continue;
            }
            const documents = await this.buildChunkDocuments(
              filePath,
              content,
              knowledgeBaseName
            );
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
          indexMutated = true;
        }
      }

      if (indexMutated && this.faissIndex !== null) {
        const indexFileSavePath = path.join(FAISS_INDEX_PATH, 'faiss.index');
        try {
          await this.faissIndex.save(indexFileSavePath);
          logger.info('FAISS index saved successfully to', indexFileSavePath);
        } catch (saveError: any) {
          handleFsOperationError('save FAISS index at', indexFileSavePath, saveError);
        }
        // Sidecar hashes are written only after the index has persisted so we
        // never claim a hash for vectors that never landed on disk. tmp+rename
        // keeps each sidecar atomic. A crash after save() but before every
        // rename completes will re-embed the unhashed files on next start,
        // duplicating their vectors until RFC 007 PR 2.1 lands the pending
        // manifest protocol.
        await Promise.all(
          pendingHashWrites.map(async ({ path: target, hash }) => {
            const tmpPath = `${target}.tmp`;
            try {
              await fsp.writeFile(tmpPath, hash, { encoding: 'utf-8' });
              await fsp.rename(tmpPath, target);
            } catch (error) {
              try {
                await fsp.unlink(tmpPath);
              } catch {
                // best-effort cleanup; original error is what matters
              }
              handleFsOperationError('write file hash metadata to', target, error);
            }
          })
        );
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
   * When `knowledgeBaseName` is provided, results are scoped to documents whose `source`
   * metadata lives under that KB directory; otherwise all KBs are searched.
   */
  async similaritySearch(query: string, k: number, threshold: number = 2, knowledgeBaseName?: string) {
    if (!this.faissIndex) {
      throw new Error('FAISS index is not initialized');
    }

    const scoped = typeof knowledgeBaseName === 'string' && knowledgeBaseName.length > 0;
    // When scoping to a KB, over-fetch up to the whole index so we can still
    // surface up to `k` same-KB hits when other KBs dominate the top of the
    // unfiltered ranking.
    const fetchK = scoped
      ? Math.max(k, this.faissIndex.index.ntotal())
      : k;

    // FaissStore.similaritySearchVectorWithScore accepts only (query, k) and
    // silently drops any filter argument, so threshold and KB scoping are both
    // applied as post-filters on the returned [doc, score] tuples.
    const resultsWithScore = await this.faissIndex.similaritySearchWithScore(query, fetchK);

    const kbPrefix = scoped
      ? path.join(KNOWLEDGE_BASES_ROOT_DIR, knowledgeBaseName as string) + path.sep
      : undefined;

    const filtered = resultsWithScore.filter(([doc, score]) => {
      if (score > threshold) {
        return false;
      }
      if (kbPrefix) {
        const source = (doc.metadata as { source?: unknown })?.source;
        return typeof source === 'string' && source.startsWith(kbPrefix);
      }
      return true;
    });

    return filtered.slice(0, k).map(([doc, score]) => ({
      ...doc,
      score,
    }));
  }
}
