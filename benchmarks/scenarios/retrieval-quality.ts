import type { RetrievalQualityScenarioResult } from '../types.js';
import {
  generateRetrievalQualityFixture,
  retrievalChunkId,
  type RetrievalChunk,
} from '../fixtures/generator.js';

const DEFAULT_FANOUT_FACTOR = 3;
const DEFAULT_LOADED_KBS = 5;

interface RankedChunk {
  id: string;
  score: number;
}

export async function runRetrievalQualityScenario(): Promise<RetrievalQualityScenarioResult> {
  const fixture = generateRetrievalQualityFixture(42);
  const vectors = new Map<string, number[]>();

  for (const chunk of fixture.chunks) {
    vectors.set(retrievalChunkId(chunk), vectorize(chunk.text));
  }

  const sweep = [1, 2, 3, 5, 10].flatMap((fanoutFactor) =>
    [3, 5].map((loadedKbs) => ({
      expected_hit_rate_at_10: Number(
        averageExpectedHitRateAtTen(
          fixture.queries,
          fixture.chunks.filter((chunk) => Number(chunk.kbName.slice(-1)) <= loadedKbs),
          vectors,
          fanoutFactor,
        ).toFixed(4),
      ),
      fanout_factor: fanoutFactor,
      loaded_kbs: loadedKbs,
      recall_at_10: Number(
        averageRecallAtTen(
          fixture.queries,
          fixture.chunks,
          fixture.chunks.filter((chunk) => Number(chunk.kbName.slice(-1)) <= loadedKbs),
          vectors,
          fanoutFactor,
        ).toFixed(4),
      ),
    })),
  );

  const defaultRow = sweep.find(
    (row) => row.fanout_factor === DEFAULT_FANOUT_FACTOR && row.loaded_kbs === DEFAULT_LOADED_KBS,
  );

  if (!defaultRow) {
    throw new Error('Missing default retrieval quality sweep result');
  }

  return {
    default_fanout_factor: DEFAULT_FANOUT_FACTOR,
    default_loaded_kbs: DEFAULT_LOADED_KBS,
    default_recall_at_10: defaultRow.recall_at_10,
    query_count: fixture.queries.length,
    sweep,
  };
}

function averageRecallAtTen(
  queries: Array<{ expected: string; text: string }>,
  allChunks: RetrievalChunk[],
  availableChunks: RetrievalChunk[],
  vectors: Map<string, number[]>,
  fanoutFactor: number,
): number {
  const kbGroups = groupByKnowledgeBase(availableChunks);
  let total = 0;

  for (const query of queries) {
    const globalTopTen = search(query.text, allChunks, vectors, 10).map((chunk) => chunk.id);
    const fanoutTopTen = [...kbGroups.values()]
      .flatMap((group) => search(query.text, group, vectors, 10 * fanoutFactor))
      .sort((left, right) => left.score - right.score)
      .slice(0, 10)
      .map((chunk) => chunk.id);

    const overlap = globalTopTen.filter((id) => fanoutTopTen.includes(id)).length;
    total += overlap / 10;
  }

  return total / queries.length;
}

function averageExpectedHitRateAtTen(
  queries: Array<{ expected: string; text: string }>,
  availableChunks: RetrievalChunk[],
  vectors: Map<string, number[]>,
  fanoutFactor: number,
): number {
  const kbGroups = groupByKnowledgeBase(availableChunks);
  let hits = 0;

  for (const query of queries) {
    const fanoutTopTen = [...kbGroups.values()]
      .flatMap((group) => search(query.text, group, vectors, 10 * fanoutFactor))
      .sort((left, right) => left.score - right.score)
      .slice(0, 10)
      .map((chunk) => chunk.id);

    if (fanoutTopTen.includes(query.expected)) {
      hits += 1;
    }
  }

  return hits / queries.length;
}

function groupByKnowledgeBase(chunks: RetrievalChunk[]): Map<string, RetrievalChunk[]> {
  const grouped = new Map<string, RetrievalChunk[]>();
  for (const chunk of chunks) {
    const existing = grouped.get(chunk.kbName) ?? [];
    existing.push(chunk);
    grouped.set(chunk.kbName, existing);
  }
  return grouped;
}

function search(
  query: string,
  chunks: RetrievalChunk[],
  vectors: Map<string, number[]>,
  topK: number,
): RankedChunk[] {
  const queryVector = vectorize(query);
  return chunks
    .map((chunk) => {
      const id = retrievalChunkId(chunk);
      const vector = vectors.get(id);
      if (!vector) {
        throw new Error(`Missing vector for ${id}`);
      }

      return {
        id,
        score: euclideanDistance(queryVector, vector),
      };
    })
    .sort((left, right) => left.score - right.score)
    .slice(0, topK);
}

function vectorize(text: string): number[] {
  const vector = Array.from({ length: 64 }, () => 0);
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);

  for (const token of tokens) {
    const bucket = fnv1a(token) % vector.length;
    vector[bucket] += 1;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}

function euclideanDistance(left: number[], right: number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index] - right[index];
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
