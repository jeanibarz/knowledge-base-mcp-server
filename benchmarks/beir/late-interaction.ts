import * as fsp from 'fs/promises';
import * as path from 'path';

export const LATE_INTERACTION_SCHEMA_VERSION = 'kb.beir.late-interaction.v1';
export const LATE_INTERACTION_TOKEN_DIMENSIONS = 64;
export const LATE_INTERACTION_MODEL_ID = 'hashed-token-maxsim-v1';

export interface LateInteractionDocument {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
}

export interface LateInteractionHit {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
  text: string;
}

export interface LateInteractionResourceReport {
  schema_version: typeof LATE_INTERACTION_SCHEMA_VERSION;
  enabled: true;
  mode: 'standalone' | 'rerank';
  implementation: string;
  model: string;
  token_dimensions: number;
  documents_indexed: number;
  token_vectors: number;
  index_size_bytes_estimate: number;
  build_ms: number;
  cpu_requirement: string;
  gpu_requirement: string;
  memory_requirement: string;
  candidate_source: string | null;
}

interface IndexedLateInteractionDocument extends LateInteractionDocument {
  tokens: string[];
  tokenVectors: Float32Array[];
}

export class LateInteractionIndex {
  private readonly docs: IndexedLateInteractionDocument[];
  private readonly idf: Map<string, number>;
  readonly buildMs: number;

  private constructor(docs: IndexedLateInteractionDocument[], idf: Map<string, number>, buildMs: number) {
    this.docs = docs;
    this.idf = idf;
    this.buildMs = buildMs;
  }

  static build(documents: readonly LateInteractionDocument[]): LateInteractionIndex {
    const started = process.hrtime.bigint();
    const tokenized = documents.map((doc) => ({ doc, tokens: tokenize(doc.text) }));
    const idf = computeIdf(tokenized.map((row) => row.tokens));
    const docs = tokenized.map(({ doc, tokens }) => ({
      ...doc,
      tokens,
      tokenVectors: tokens.map((token) => tokenVector(token)),
    }));
    return new LateInteractionIndex(docs, idf, elapsedMs(started));
  }

  static async fromKnowledgeBase(kbName: string, kbPath: string): Promise<LateInteractionIndex> {
    return LateInteractionIndex.build(await readKnowledgeBaseDocuments(kbName, kbPath));
  }

  search(query: string, k: number): LateInteractionHit[] {
    assertPositiveInteger(k, 'k');
    return this.scoreDocuments(query, this.docs).slice(0, k);
  }

  rerank(query: string, candidates: readonly LateInteractionDocument[], k: number): LateInteractionHit[] {
    assertPositiveInteger(k, 'k');
    const indexed = candidates.map((doc) => {
      const tokens = tokenize(doc.text);
      return {
        ...doc,
        tokens,
        tokenVectors: tokens.map((token) => tokenVector(token)),
      };
    });
    return this.scoreDocuments(query, indexed).slice(0, k);
  }

  resourceReport(mode: 'standalone' | 'rerank', candidateSource: string | null): LateInteractionResourceReport {
    const tokenVectors = this.docs.reduce((sum, doc) => sum + doc.tokenVectors.length, 0);
    const indexBytes = tokenVectors * LATE_INTERACTION_TOKEN_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT;
    return {
      schema_version: LATE_INTERACTION_SCHEMA_VERSION,
      enabled: true,
      mode,
      implementation: 'Benchmark-only ColBERT-style MaxSim over hashed token/character-ngram vectors',
      model: LATE_INTERACTION_MODEL_ID,
      token_dimensions: LATE_INTERACTION_TOKEN_DIMENSIONS,
      documents_indexed: this.docs.length,
      token_vectors: tokenVectors,
      index_size_bytes_estimate: indexBytes,
      build_ms: Number(this.buildMs.toFixed(3)),
      cpu_requirement: 'CPU-only JavaScript prototype; no native ANN index',
      gpu_requirement: 'None for this prototype; a production ColBERTv2/PLAID tier would normally prefer GPU at indexing time',
      memory_requirement: `~${formatBytes(indexBytes)} for float32 token vectors before JS object overhead`,
      candidate_source: candidateSource,
    };
  }

  private scoreDocuments(query: string, docs: readonly IndexedLateInteractionDocument[]): LateInteractionHit[] {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];
    const queryVectors = queryTokens.map((token) => tokenVector(token));
    const weightedQuery = queryTokens.map((token, index) => ({
      token,
      vector: queryVectors[index],
      weight: this.idf.get(token) ?? 1,
    }));

    return docs
      .map((doc) => {
        const score = maxSimScore(weightedQuery, doc.tokenVectors);
        return { id: doc.id, score, metadata: doc.metadata, text: doc.text };
      })
      .filter((hit) => Number.isFinite(hit.score))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  }
}

export async function readKnowledgeBaseDocuments(kbName: string, kbPath: string): Promise<LateInteractionDocument[]> {
  const entries = await fsp.readdir(kbPath, { withFileTypes: true });
  const docs: LateInteractionDocument[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filePath = path.join(kbPath, entry.name);
    const relativePath = `${kbName}/${entry.name}`;
    docs.push({
      id: relativePath,
      text: await fsp.readFile(filePath, 'utf-8'),
      metadata: {
        source: filePath,
        relativePath,
      },
    });
  }
  docs.sort((left, right) => left.id.localeCompare(right.id));
  return docs;
}

export function tokenize(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z0-9][a-z0-9._-]{1,}/g);
  return tokens ?? [];
}

function computeIdf(tokenLists: readonly string[][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const tokens of tokenLists) {
    for (const token of new Set(tokens)) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  const docs = Math.max(tokenLists.length, 1);
  const idf = new Map<string, number>();
  for (const [token, count] of df) {
    idf.set(token, Math.log(1 + (docs + 1) / (count + 1)));
  }
  return idf;
}

function maxSimScore(
  query: readonly { token: string; vector: Float32Array; weight: number }[],
  docVectors: readonly Float32Array[],
): number {
  if (docVectors.length === 0) return Number.NEGATIVE_INFINITY;
  let weightedSum = 0;
  let weightTotal = 0;
  for (const q of query) {
    let best = 0;
    for (const docVector of docVectors) {
      const sim = dot(q.vector, docVector);
      if (sim > best) best = sim;
    }
    weightedSum += best * q.weight;
    weightTotal += q.weight;
  }
  return weightTotal === 0 ? Number.NEGATIVE_INFINITY : weightedSum / weightTotal;
}

function tokenVector(token: string): Float32Array {
  const vector = new Float32Array(LATE_INTERACTION_TOKEN_DIMENSIONS);
  for (const feature of tokenFeatures(token)) {
    const hash = hashFeature(feature);
    const bucket = hash % LATE_INTERACTION_TOKEN_DIMENSIONS;
    vector[bucket] += (hash & 0x80000000) === 0 ? 1 : -1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  return vector;
}

function tokenFeatures(token: string): string[] {
  const padded = `^${token}$`;
  const features = [`tok:${token}`];
  for (let i = 0; i < padded.length - 2; i += 1) {
    features.push(`tri:${padded.slice(i, i + 3)}`);
  }
  return features;
}

function hashFeature(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function dot(left: Float32Array, right: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) sum += left[i] * right[i];
  return sum;
}

function elapsedMs(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}
