import * as path from 'path';
import * as os from 'os';

export const KNOWLEDGE_BASES_ROOT_DIR = process.env.KNOWLEDGE_BASES_ROOT_DIR ||
  path.join(os.homedir(), 'knowledge_bases');

export const DEFAULT_FAISS_INDEX_PATH = path.join(KNOWLEDGE_BASES_ROOT_DIR, '.faiss');
export const FAISS_INDEX_PATH = process.env.FAISS_INDEX_PATH || DEFAULT_FAISS_INDEX_PATH;

// Embedding provider configuration
export const EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER || 'huggingface';

// HuggingFace configuration
export const DEFAULT_HUGGINGFACE_MODEL_NAME = 'sentence-transformers/all-MiniLM-L6-v2';
export const HUGGINGFACE_MODEL_NAME = process.env.HUGGINGFACE_MODEL_NAME || DEFAULT_HUGGINGFACE_MODEL_NAME;

// Ollama configuration
export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'nomic-embed-text';
