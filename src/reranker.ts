import { createHash } from 'crypto';
import type { Document } from '@langchain/core/documents';
import { emitCanonicalLog, type CanonicalProcess, type CanonicalSearchMode } from './canonical-log.js';
import {
  DEFAULT_RERANK_MODEL,
  DEFAULT_RERANK_TOP_N,
  parseRerankFlag,
  parseRerankTopN,
  resolveRerankerConfig,
  type RerankOverride,
  type RerankerConfig,
} from './config/reranker.js';
import { logger } from './logger.js';

export {
  DEFAULT_RERANK_MODEL,
  DEFAULT_RERANK_TOP_N,
  parseRerankFlag,
  parseRerankTopN,
  resolveRerankerConfig,
  type RerankOverride,
  type RerankerConfig,
};

export interface Reranker {
  id: string;
  rerank(query: string, candidates: string[]): Promise<number[]>;
}

export interface RerankableDocument extends Document {
  score?: number;
  rerankScore?: number;
}

export interface RerankScoreCache {
  get(modelId: string, query: string, candidateText: string): number | null;
  set(modelId: string, query: string, candidateText: string, score: number): void;
}

export interface RerankFusedResultsInput<T extends RerankableDocument> {
  query: string;
  fused: readonly T[];
  k: number;
  topN: number;
  reranker: Reranker;
  cache?: RerankScoreCache;
}

export interface RerankFusedResultsOutput<T extends RerankableDocument> {
  results: T[];
  degraded: boolean;
  degradeReason: string | null;
  model: string;
  candidatesIn: number;
  cacheHits: number;
  tookMs: number;
}

export interface ApplyRerankerInput<T extends RerankableDocument> {
  query: string;
  results: readonly T[];
  k: number;
  override?: RerankOverride;
  process?: CanonicalProcess;
  searchMode?: CanonicalSearchMode;
  kbScope?: string | null;
}

export class InMemoryRerankScoreCache implements RerankScoreCache {
  private readonly values = new Map<string, number>();

  constructor(private readonly options: { maxEntries: number } = { maxEntries: 512 }) {}

  get(modelId: string, query: string, candidateText: string): number | null {
    const key = rerankCacheKey(modelId, query, candidateText);
    const value = this.values.get(key);
    if (value === undefined) return null;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(modelId: string, query: string, candidateText: string, score: number): void {
    if (this.options.maxEntries <= 0) return;
    const key = rerankCacheKey(modelId, query, candidateText);
    if (this.values.has(key)) this.values.delete(key);
    this.values.set(key, score);
    while (this.values.size > this.options.maxEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }
}

export const globalRerankScoreCache = new InMemoryRerankScoreCache();

const providerCache = new Map<string, Promise<Reranker>>();
const warnedDegradeReasons = new Set<string>();

type RerankerFactory = (config: RerankerConfig) => Promise<Reranker>;

let rerankerFactory: RerankerFactory = async (config) => TransformersJsReranker.create(config.model);

export function setRerankerFactoryForTests(factory: RerankerFactory | null): () => void {
  const previous = rerankerFactory;
  rerankerFactory = factory ?? (async (config) => TransformersJsReranker.create(config.model));
  providerCache.clear();
  return () => {
    rerankerFactory = previous;
    providerCache.clear();
  };
}

export async function getDefaultReranker(config: RerankerConfig): Promise<Reranker> {
  let promise = providerCache.get(config.model);
  if (promise === undefined) {
    promise = rerankerFactory(config);
    providerCache.set(config.model, promise);
    promise.catch(() => {
      if (providerCache.get(config.model) === promise) providerCache.delete(config.model);
    });
  }
  return promise;
}

export async function applyRerankerIfEnabled<T extends RerankableDocument>(
  input: ApplyRerankerInput<T>,
): Promise<RerankFusedResultsOutput<T>> {
  const config = resolveRerankerConfig(process.env, input.override);
  if (!config.enabled) {
    return {
      results: input.results.slice(0, input.k),
      degraded: false,
      degradeReason: null,
      model: config.model,
      candidatesIn: 0,
      cacheHits: 0,
      tookMs: 0,
    };
  }

  const startedAt = Date.now();
  let out: RerankFusedResultsOutput<T>;
  try {
    const reranker = await getDefaultReranker(config);
    out = await rerankFusedResults({
      query: input.query,
      fused: input.results,
      k: input.k,
      topN: config.topN,
      reranker,
      cache: globalRerankScoreCache,
    });
  } catch (err) {
    out = {
      results: input.results.slice(0, input.k),
      degraded: true,
      degradeReason: (err as Error).message,
      model: config.model,
      candidatesIn: Math.min(config.topN, input.results.length),
      cacheHits: 0,
      tookMs: Date.now() - startedAt,
    };
  }

  if (out.degraded && out.degradeReason !== null) warnOnce(out.degradeReason, out.model);
  if (input.process !== undefined) {
    emitRerankStageLog({
      process: input.process,
      query: input.query,
      kbScope: input.kbScope ?? null,
      searchMode: input.searchMode ?? 'hybrid',
      output: out,
    });
  }
  return out;
}

export async function rerankFusedResults<T extends RerankableDocument>(
  input: RerankFusedResultsInput<T>,
): Promise<RerankFusedResultsOutput<T>> {
  const startedAt = Date.now();
  if (!Number.isInteger(input.k) || input.k < 1) {
    throw new Error(`rerankFusedResults: invalid k=${input.k}; expected a positive integer`);
  }
  if (!Number.isInteger(input.topN) || input.topN < 1) {
    throw new Error(`rerankFusedResults: invalid topN=${input.topN}; expected a positive integer`);
  }

  const rerankCount = Math.min(input.topN, input.fused.length);
  const block = input.fused.slice(0, rerankCount);
  const tail = input.fused.slice(rerankCount);
  const scores = new Array<number>(block.length);
  const misses: Array<{ index: number; text: string }> = [];
  let cacheHits = 0;

  block.forEach((candidate, index) => {
    const text = candidate.pageContent;
    const cached = input.cache?.get(input.reranker.id, input.query, text) ?? null;
    if (cached === null) {
      misses.push({ index, text });
    } else {
      scores[index] = cached;
      cacheHits += 1;
    }
  });

  try {
    if (misses.length > 0) {
      const freshScores = await input.reranker.rerank(input.query, misses.map((m) => m.text));
      if (freshScores.length !== misses.length) {
        throw new Error(`reranker returned wrong-length score array: expected ${misses.length} scores, got ${freshScores.length}`);
      }
      freshScores.forEach((score, idx) => {
        if (!Number.isFinite(score)) {
          throw new Error(`reranker returned non-finite score at index ${idx}`);
        }
        const miss = misses[idx];
        scores[miss.index] = score;
        input.cache?.set(input.reranker.id, input.query, miss.text, score);
      });
    }
  } catch (err) {
    return {
      results: input.fused.slice(0, input.k) as T[],
      degraded: true,
      degradeReason: (err as Error).message,
      model: input.reranker.id,
      candidatesIn: rerankCount,
      cacheHits,
      tookMs: Date.now() - startedAt,
    };
  }

  const reranked = block
    .map((candidate, index) => ({
      candidate: { ...candidate, rerankScore: scores[index] } as T,
      originalIndex: index,
    }))
    .sort((a, b) => {
      const byScore = (b.candidate.rerankScore as number) - (a.candidate.rerankScore as number);
      return byScore !== 0 ? byScore : a.originalIndex - b.originalIndex;
    })
    .map((entry) => entry.candidate);

  return {
    results: [...reranked, ...tail].slice(0, input.k) as T[],
    degraded: false,
    degradeReason: null,
    model: input.reranker.id,
    candidatesIn: rerankCount,
    cacheHits,
    tookMs: Date.now() - startedAt,
  };
}

export function emitRerankStageLog<T extends RerankableDocument>(input: {
  process: CanonicalProcess;
  query: string;
  kbScope: string | null;
  searchMode: CanonicalSearchMode;
  output: RerankFusedResultsOutput<T>;
}): void {
  emitCanonicalLog({
    process: input.process,
    tool: input.process === 'mcp' ? 'rerank.stage' : undefined,
    cmd: input.process === 'cli' ? 'rerank.stage' : undefined,
    query: input.query,
    kb_scope: input.kbScope,
    search_mode: input.searchMode,
    result_count: input.output.results.length,
    took_ms: input.output.tookMs,
    rerank: {
      model: input.output.model,
      candidates_in: input.output.candidatesIn,
      cache_hits: input.output.cacheHits,
      degraded: input.output.degraded,
      degrade_reason: input.output.degradeReason,
    },
  });
}

function warnOnce(reason: string, model: string): void {
  const key = `${model}:${reason}`;
  if (warnedDegradeReasons.has(key)) return;
  warnedDegradeReasons.add(key);
  logger.warn(`reranker ${model} degraded to fused order: ${reason}`);
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

function rerankCacheKey(modelId: string, query: string, candidateText: string): string {
  return createHash('sha256')
    .update(modelId)
    .update('\0')
    .update(normalizeQuery(query))
    .update('\0')
    .update(createHash('sha256').update(candidateText, 'utf-8').digest('hex'))
    .digest('hex');
}

interface TransformersModule {
  AutoTokenizer: {
    from_pretrained(model: string): Promise<Tokenizer>;
  };
  AutoModelForSequenceClassification: {
    from_pretrained(model: string, options?: Record<string, unknown>): Promise<SequenceClassificationModel>;
  };
}

type Tokenizer = (
  text: string[],
  options: {
    text_pair: string[];
    padding: boolean;
    truncation: boolean;
  },
) => unknown;

type SequenceClassificationModel = ((inputs: unknown) => Promise<SequenceClassifierOutput>) & {
  config?: SequenceClassifierConfig;
};

interface SequenceClassifierOutput {
  logits?: {
    data?: ArrayLike<number>;
    dims?: number[];
  };
}

interface SequenceClassifierConfig {
  id2label?: Record<string, string>;
  label2id?: Record<string, number>;
}

class TransformersJsReranker implements Reranker {
  private constructor(
    readonly id: string,
    private readonly tokenizer: Tokenizer,
    private readonly model: SequenceClassificationModel,
  ) {}

  static async create(model: string): Promise<TransformersJsReranker> {
    const mod = await import('@huggingface/transformers') as unknown as TransformersModule;
    const [tokenizer, classifier] = await Promise.all([
      mod.AutoTokenizer.from_pretrained(model),
      mod.AutoModelForSequenceClassification.from_pretrained(model, { quantized: true }),
    ]);
    return new TransformersJsReranker(model, tokenizer, classifier);
  }

  async rerank(query: string, candidates: string[]): Promise<number[]> {
    if (candidates.length === 0) return [];
    const inputs = this.tokenizer(
      candidates.map(() => query),
      {
        text_pair: candidates,
        padding: true,
        truncation: true,
      },
    );
    const output = await this.model(inputs);
    return scoresFromSequenceClassifierOutput(output, this.model.config);
  }
}

export function scoresFromSequenceClassifierOutput(
  output: SequenceClassifierOutput,
  config: SequenceClassifierConfig = {},
): number[] {
  const logits = output.logits;
  const data = logits?.data;
  const dims = logits?.dims;
  if (data === undefined || dims === undefined || dims.length < 2) {
    throw new Error('reranker returned unparseable logits');
  }

  const batchSize = dims[0];
  const labelCount = dims[dims.length - 1];
  if (!Number.isInteger(batchSize) || batchSize < 1 || !Number.isInteger(labelCount) || labelCount < 1) {
    throw new Error(`reranker returned invalid logits shape: ${JSON.stringify(dims)}`);
  }
  if (data.length !== batchSize * labelCount) {
    throw new Error(`reranker returned logits shape ${JSON.stringify(dims)} but data length ${data.length}`);
  }

  const scores: number[] = [];
  const positiveLabelIndex = labelCount === 1 ? 0 : findPositiveLabelIndex(config, labelCount);
  for (let batchIndex = 0; batchIndex < batchSize; batchIndex += 1) {
    const row = Array.from(
      { length: labelCount },
      (_, labelIndex) => Number(data[batchIndex * labelCount + labelIndex]),
    );
    if (!row.every(Number.isFinite)) {
      throw new Error(`reranker returned non-finite logits at batch index ${batchIndex}`);
    }
    scores.push(labelCount === 1 ? row[0] : softmax(row)[positiveLabelIndex]);
  }
  return scores;
}

function findPositiveLabelIndex(config: SequenceClassifierConfig, labelCount: number): number {
  for (const [label, index] of Object.entries(config.label2id ?? {})) {
    if (index >= 0 && index < labelCount && isPositiveLabel(label)) return index;
  }
  for (const [rawIndex, label] of Object.entries(config.id2label ?? {})) {
    const index = Number(rawIndex);
    if (Number.isInteger(index) && index >= 0 && index < labelCount && isPositiveLabel(label)) return index;
  }
  return labelCount === 2 ? 1 : labelCount - 1;
}

function isPositiveLabel(label: string): boolean {
  return /^(positive|relevant|entailment|true|yes|label_1|1)$/i.test(label.trim());
}

function softmax(values: number[]): number[] {
  const maxValue = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - maxValue));
  const sum = exps.reduce((acc, value) => acc + value, 0);
  return exps.map((value) => value / sum);
}
