import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import type { Document } from '@langchain/core/documents';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export const STRESS_MODEL_NAME = 'stress-fake';
export const STRESS_MODEL_ID = 'fake__stress-fake';

const ENV_KEYS = [
  'NODE_ENV',
  'KNOWLEDGE_BASES_ROOT_DIR',
  'FAISS_INDEX_PATH',
  'EMBEDDING_PROVIDER',
  'HUGGINGFACE_MODEL_NAME',
  'KB_FAKE_DIM',
  'KB_FAISS_INDEX_TYPE',
  'KB_INDEX_VERSION_RETENTION',
  'KB_REFRESH_QUIESCE_MS',
  'KB_LOG_FORMAT',
  'KB_MUTATION_AUDIT_LOG',
] as const;

export interface StressWorkspace {
  tempDir: string;
  kbRoot: string;
  faissPath: string;
  kbName: string;
  kbPath: string;
}

export type SavedStressEnv = Record<typeof ENV_KEYS[number], string | undefined>;

export interface ManualGate {
  wait(): Promise<void>;
  waitUntilBlocked(): Promise<void>;
  release(): void;
  readonly blocked: boolean;
}

let saveGate: ManualGate | null = null;

export function createManualGate(): ManualGate {
  let blocked = false;
  let blockedResolve: () => void = () => undefined;
  let releaseResolve: () => void = () => undefined;
  const blockedPromise = new Promise<void>((resolve) => {
    blockedResolve = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });

  return {
    async wait(): Promise<void> {
      blocked = true;
      blockedResolve();
      await releasePromise;
    },
    waitUntilBlocked: () => blockedPromise,
    release: () => releaseResolve(),
    get blocked() {
      return blocked;
    },
  };
}

export function setFakeFaissSaveGate(gate: ManualGate | null): void {
  saveGate = gate;
}

export function resetStressFakes(): void {
  saveGate = null;
}

export function saveStressEnv(): SavedStressEnv {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as SavedStressEnv;
}

export function restoreStressEnv(saved: SavedStressEnv): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export async function createStressWorkspace(): Promise<StressWorkspace> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-concurrency-stress-'));
  const kbRoot = path.join(tempDir, 'kbs');
  const faissPath = path.join(tempDir, '.faiss');
  const kbName = 'alpha';
  const kbPath = path.join(kbRoot, kbName);
  await fsp.mkdir(kbPath, { recursive: true });

  process.env.NODE_ENV = 'test';
  process.env.KNOWLEDGE_BASES_ROOT_DIR = kbRoot;
  process.env.FAISS_INDEX_PATH = faissPath;
  process.env.EMBEDDING_PROVIDER = 'fake';
  process.env.HUGGINGFACE_MODEL_NAME = STRESS_MODEL_NAME;
  process.env.KB_FAKE_DIM = '8';
  process.env.KB_FAISS_INDEX_TYPE = 'flat';
  process.env.KB_INDEX_VERSION_RETENTION = '1';
  process.env.KB_REFRESH_QUIESCE_MS = '0';
  process.env.KB_LOG_FORMAT = 'text';
  delete process.env.KB_MUTATION_AUDIT_LOG;

  return { tempDir, kbRoot, faissPath, kbName, kbPath };
}

export async function writeStressNote(
  workspace: StressWorkspace,
  relativePath: string,
  body: string,
): Promise<string> {
  const target = path.join(workspace.kbPath, relativePath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, body, 'utf-8');
  return target;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

export function parseTextPayload<T = unknown>(result: CallToolResult): T {
  const content = result.content[0];
  if (content.type !== 'text') {
    throw new Error(`expected text content, got ${content.type}`);
  }
  return JSON.parse(String(content.text)) as T;
}

export function vectorForText(text: string): number[] {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16_777_619);
  }
  return [
    text.length % 97,
    hash >>> 0,
    text.includes('alpha') ? 1 : 0,
    text.includes('bravo') ? 1 : 0,
    text.includes('charlie') ? 1 : 0,
    text.includes('delta') ? 1 : 0,
    text.includes('echo') ? 1 : 0,
    text.includes('foxtrot') ? 1 : 0,
  ];
}

function scoreDocument(query: string, document: Document, ordinal: number): number {
  const haystack = `${document.pageContent}\n${JSON.stringify(document.metadata ?? {})}`.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  return haystack.includes(normalizedQuery) ? ordinal / 1000 : 1 + ordinal / 1000;
}

export class FakeFaissStore {
  public docstore = { _docs: new Map<string, Document>() };
  public index = {
    _n: 0,
    ntotal: () => this.index._n,
    getDimension: () => 8,
  };

  constructor(public embeddings: EmbeddingsInterface) {}

  async addVectors(vectors: number[][], documents: Document[]): Promise<void> {
    const expectedDimension = vectors[0]?.length ?? 8;
    for (const vector of vectors) {
      if (vector.length !== expectedDimension || vector.some((value) => !Number.isFinite(value))) {
        throw new Error('fake FAISS received malformed vectors');
      }
    }
    documents.forEach((document) => {
      this.docstore._docs.set(`doc-${this.index._n}`, document);
      this.index._n += 1;
    });
  }

  async save(directory: string): Promise<void> {
    await saveGate?.wait();
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'faiss.index'), `vectors=${this.index._n}\n`, 'utf-8');
    await fsp.writeFile(
      path.join(directory, 'docstore.json'),
      JSON.stringify(Array.from(this.docstore._docs.entries())),
      'utf-8',
    );
  }

  async similaritySearchWithScore(query: string, k: number): Promise<Array<[Document, number]>> {
    return Array.from(this.docstore._docs.values())
      .map((document, ordinal): [Document, number] => [document, scoreDocument(query, document, ordinal)])
      .sort((a, b) => a[1] - b[1])
      .slice(0, k);
  }

  static async load(directory: string, embeddings: EmbeddingsInterface): Promise<FakeFaissStore> {
    const store = new FakeFaissStore(embeddings);
    const raw = await fsp.readFile(path.join(directory, 'docstore.json'), 'utf-8');
    const entries = JSON.parse(raw) as Array<[string, Document]>;
    for (const [id, document] of entries) {
      store.docstore._docs.set(id, document);
    }
    store.index._n = store.docstore._docs.size;
    return store;
  }
}

