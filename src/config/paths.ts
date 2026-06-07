import * as os from 'os';
import * as path from 'path';

export function resolveKnowledgeBasesRootDir(raw: string | undefined): string {
  return raw || path.join(os.homedir(), 'knowledge_bases');
}

export function defaultFaissIndexPath(rootDir: string): string {
  return path.join(rootDir, '.faiss');
}

export const KNOWLEDGE_BASES_ROOT_DIR = resolveKnowledgeBasesRootDir(process.env.KNOWLEDGE_BASES_ROOT_DIR);

export const DEFAULT_FAISS_INDEX_PATH = defaultFaissIndexPath(KNOWLEDGE_BASES_ROOT_DIR);
export const FAISS_INDEX_PATH = process.env.FAISS_INDEX_PATH || DEFAULT_FAISS_INDEX_PATH;
