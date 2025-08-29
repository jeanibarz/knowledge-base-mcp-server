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
  OLLAMA_MODEL 
} from './config.js';

const MODEL_NAME_FILE = path.join(FAISS_INDEX_PATH, 'model_name.txt');

export class FaissIndexManager {
  private faissIndex: FaissStore | null = null;
  private embeddings: HuggingFaceInferenceEmbeddings | OllamaEmbeddings;
  private modelName: string;
  private embeddingProvider: string;

  constructor() {
    this.embeddingProvider = EMBEDDING_PROVIDER;

    if (this.embeddingProvider === 'ollama') {
      console.log("Initializing FaissIndexManager with Ollama embeddings");
      this.modelName = OLLAMA_MODEL;
      this.embeddings = new OllamaEmbeddings({
        baseUrl: OLLAMA_BASE_URL,
        model: this.modelName,
      });
    } else {
      console.log("Initializing FaissIndexManager with HuggingFace embeddings");
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
    
    console.log(`Using embedding provider: ${this.embeddingProvider}, model: ${this.modelName}`);
  }

  async initialize(): Promise<void> {
    try {
      if (!fs.existsSync(FAISS_INDEX_PATH)) {
        await fsp.mkdir(FAISS_INDEX_PATH, { recursive: true });
      }
      const indexFilePath = path.join(FAISS_INDEX_PATH, "faiss.index");
      let storedModelName: string | null = null;

      try {
        storedModelName = fs.existsSync(MODEL_NAME_FILE) ? (await fsp.readFile(MODEL_NAME_FILE, 'utf-8')) : null;
      } catch (error) {
        console.warn("Error reading stored model name:", error);
      }

      if (storedModelName && storedModelName !== this.modelName) {
        console.warn(`Model name has changed from ${storedModelName} to ${this.modelName}. Recreating index.`);
        if (fs.existsSync(indexFilePath)) {
          await fsp.unlink(indexFilePath);
          console.log("Existing FAISS index deleted.");
        }
        this.faissIndex = null; // Ensure index is recreated
      }

      if (fs.existsSync(indexFilePath)) {
        console.log("Loading existing FAISS index from:", indexFilePath);
        this.faissIndex = await FaissStore.load(indexFilePath, this.embeddings);
        console.log("FAISS index loaded.");
      } else {
        console.log("FAISS index file not found at", indexFilePath, ". It will be created if documents are available.");
        this.faissIndex = null;
      }

      // Save the current model name for future checks
      await fsp.writeFile(MODEL_NAME_FILE, this.modelName, 'utf-8');

    } catch (error: any) {
      console.error("Error initializing FAISS index:", error);
      console.error(error.stack);
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
    console.log("Updating FAISS index...");
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
          console.log(`Skipping dot folder: ${knowledgeBaseName}`);
          continue;
        }
        const knowledgeBasePath = path.join(KNOWLEDGE_BASES_ROOT_DIR, knowledgeBaseName);
        const filePaths = await getFilesRecursively(knowledgeBasePath);

        for (const filePath of filePaths) {
          anyFileProcessed = true;

          const fileHash = await calculateSHA256(filePath);
          const relativePath = path.relative(knowledgeBasePath, filePath);
          const indexDirPath = path.join(knowledgeBasePath, ".index", path.dirname(relativePath));
          const indexFilePath = path.join(indexDirPath, path.basename(filePath));

          if (!fs.existsSync(indexDirPath)) {
            await fsp.mkdir(indexDirPath, { recursive: true });
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
            console.log(`File ${filePath} has changed. Updating index...`);
            let content = "";
            try {
              content = await fsp.readFile(filePath, 'utf-8');
            } catch (error: any) {
              console.error(`Error reading file ${filePath}:`, error);
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
                console.log("Creating new FAISS index from texts...");
                this.faissIndex = await FaissStore.fromTexts(
                  documentsToAdd.map(doc => doc.pageContent),
                  documentsToAdd.map(doc => doc.metadata),
                  this.embeddings
                );
              } else {
                await this.faissIndex.addDocuments(documentsToAdd);
              }
              const indexFileSavePath = path.join(FAISS_INDEX_PATH, "faiss.index");
              try {
                await this.faissIndex.save(indexFileSavePath);
                console.log("FAISS index saved successfully to", indexFileSavePath);
              } catch (saveError: any) {
                if (saveError.code === 'EISDIR') {
                  console.error(`Error: Attempted to save FAISS index to a directory (${FAISS_INDEX_PATH}) instead of a file.`);
                } else {
                  console.error("Error saving FAISS index:", saveError);
                }
                throw saveError;
              }
              await fsp.writeFile(indexFilePath, fileHash, { encoding: 'utf-8' });
              console.log(`Index updated for ${filePath}.`);
            } else {
              console.log(`No documents generated from ${filePath}. Skipping index update.`);
            }
          } else {
            console.log(`File ${filePath} unchanged, skipping.`);
          }
        }
      }

      // If at least one file was processed but no changes triggered index creation,
      // then attempt to build the FAISS index from all available documents.
      if (this.faissIndex === null && anyFileProcessed) {
        console.log("No updates detected but FAISS index is not initialized. Building index from all available documents...");
        let allDocuments: Document[] = [];
        for (const knowledgeBaseName of knowledgeBases) {
          if (knowledgeBaseName.startsWith('.')) continue;
          const knowledgeBasePath = path.join(KNOWLEDGE_BASES_ROOT_DIR, knowledgeBaseName);
          const filePaths = await getFilesRecursively(knowledgeBasePath);
          for (const filePath of filePaths) {
            let content = "";
            try {
              content = await fsp.readFile(filePath, 'utf-8');
            } catch (error) {
              console.error(`Error reading file ${filePath}:`, error);
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
            allDocuments.map(doc => doc.pageContent),
            allDocuments.map(doc => doc.metadata),
            this.embeddings
          );
          const indexFileSavePath = path.join(FAISS_INDEX_PATH, "faiss.index");
          try {
            await this.faissIndex.save(indexFileSavePath);
            console.log("FAISS index saved successfully to", indexFileSavePath);
          } catch (saveError: any) {
            console.error("Error saving FAISS index:", saveError);
            throw saveError;
          }
        }
      }
      console.log("FAISS index update process completed.");
    } catch (error: any) {
      console.error("Error updating FAISS index:", error);
      console.error(error.stack);
      throw error;
    }
  }

  /**
   * Performs a similarity search and returns the results with their similarity scores.
   */
  async similaritySearch(query: string, k: number, threshold: number = 2) {
    if (!this.faissIndex) {
      throw new Error("FAISS index is not initialized");
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
