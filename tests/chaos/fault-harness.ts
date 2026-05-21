import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export const DEFAULT_MODEL_ID = 'huggingface__BAAI-bge-small-en-v1.5';

export interface ChaosWorkspace {
  tempDir: string;
  kbRoot: string;
  faissPath: string;
  kbName: string;
  kbPath: string;
}

const ENV_KEYS = [
  'NODE_ENV',
  'KNOWLEDGE_BASES_ROOT_DIR',
  'FAISS_INDEX_PATH',
  'EMBEDDING_PROVIDER',
  'HUGGINGFACE_MODEL_NAME',
  'HUGGINGFACE_API_KEY',
  'KB_FAISS_INDEX_TYPE',
  'KB_INDEX_VERSION_RETENTION',
  'KB_CONTEXTUAL_RETRIEVAL',
  'KB_LLM_ENDPOINT',
] as const;

export type SavedEnv = Record<typeof ENV_KEYS[number], string | undefined>;

export function saveChaosEnv(): SavedEnv {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as SavedEnv;
}

export function restoreChaosEnv(saved: SavedEnv): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export async function createChaosWorkspace(): Promise<ChaosWorkspace> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-ingest-chaos-'));
  const kbRoot = path.join(tempDir, 'kbs');
  const faissPath = path.join(tempDir, '.faiss');
  const kbName = 'chaos';
  const kbPath = path.join(kbRoot, kbName);
  await fsp.mkdir(kbPath, { recursive: true });

  process.env.NODE_ENV = 'test';
  process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
  process.env.FAISS_INDEX_PATH = faissPath;
  process.env.EMBEDDING_PROVIDER = 'huggingface';
  process.env.HUGGINGFACE_MODEL_NAME = 'BAAI/bge-small-en-v1.5';
  process.env.HUGGINGFACE_API_KEY = 'chaos-test-stub';
  process.env.KB_FAISS_INDEX_TYPE = 'flat';
  process.env.KB_INDEX_VERSION_RETENTION = '1';

  return { tempDir, kbRoot, faissPath, kbName, kbPath };
}

export async function writeFixtureNote(
  workspace: ChaosWorkspace,
  relativePath = 'runbook.md',
  body = '# Runbook\n\nRestart the queue worker when lag exceeds five minutes.\n',
): Promise<string> {
  const target = path.join(workspace.kbPath, relativePath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, body, 'utf-8');
  return target;
}

export function modelDir(workspace: ChaosWorkspace): string {
  return path.join(workspace.faissPath, 'models', DEFAULT_MODEL_ID);
}

export function activeIndexSymlink(workspace: ChaosWorkspace): string {
  return path.join(modelDir(workspace), 'index');
}

export function pendingManifestPath(workspace: ChaosWorkspace): string {
  return path.join(modelDir(workspace), 'pending-manifest.json');
}

export function hashSidecarPath(workspace: ChaosWorkspace, relativePath = 'runbook.md'): string {
  return path.join(workspace.kbPath, '.index', relativePath);
}

export function chunkManifestPath(workspace: ChaosWorkspace, relativePath = 'runbook.md'): string {
  return `${hashSidecarPath(workspace, relativePath)}.chunks.json`;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.lstat(target);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

export async function readJson<T = unknown>(target: string): Promise<T> {
  return JSON.parse(await fsp.readFile(target, 'utf-8')) as T;
}

export async function readQuarantineJsonl(workspace: ChaosWorkspace): Promise<Array<Record<string, unknown>>> {
  const target = path.join(workspace.kbPath, '.index', 'quarantine.jsonl');
  const raw = await fsp.readFile(target, 'utf-8');
  return raw
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function fsError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code }) as NodeJS.ErrnoException;
}
