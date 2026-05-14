import * as os from 'os';
import * as path from 'path';

export const KNOWLEDGE_BASES_ROOT_DIR = process.env.KNOWLEDGE_BASES_ROOT_DIR
  || path.join(os.homedir(), 'knowledge_bases');

export const DEFAULT_FAISS_INDEX_PATH = path.join(KNOWLEDGE_BASES_ROOT_DIR, '.faiss');
export const FAISS_INDEX_PATH = process.env.FAISS_INDEX_PATH || DEFAULT_FAISS_INDEX_PATH;
