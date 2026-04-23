import type { RetrievalQualityScenarioResult } from '../types.js';
import {
  generateRetrievalQualityFixture,
  retrievalChunkId,
  type RetrievalChunk,
} from '../fixtures/generator.js';

const DEFAULT_FANOUT_FACTOR = 3;
const DEFAULT_LOADED_KBS = 5;

// Per-KB search-noise magnitude. Simulates the approximate-nearest-neighbor
// (ANN) behavior that real per-KB FAISS/HNSW indexes exhibit: local rankings
// deviate from the true global ordering by a bounded amount. This is the
// class of error RFC 007 §6.4.1's `fanout_factor` is designed to compensate
// for, so the synthetic benchmark must reproduce it — otherwise exact local
// search always surfaces every globally-top-k chunk and the sweep collapses
// to a single value (issue #26).
//
// Tuned against the `generateRetrievalQualityFixture(42)` corpus so the
// default `f=3, loaded_kbs=5` row clears RFC 007 §6.4.1's `recall@10 ≥ 0.95`
// blocking gate with a ~0.04 margin while `f=1` shows meaningful
// degradation. If the fixture seed or corpus shape changes, re-tune.
const ANN_NOISE_MAGNITUDE = 0.025;

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

  assertFanoutSensitive(sweep);

  return {
    default_fanout_factor: DEFAULT_FANOUT_FACTOR,
    default_loaded_kbs: DEFAULT_LOADED_KBS,
    default_recall_at_10: defaultRow.recall_at_10,
    query_count: fixture.queries.length,
    sweep,
  };
}

// Regression guard for issue #26: if per-KB search ever reverts to exact
// ranking (or ANN_NOISE_MAGNITUDE drops to zero), `recall_at_10` will be
// identical at f=1 and f=5 for the same `loaded_kbs`, collapsing the sweep
// back to a single value. Fail the bench loudly rather than silently ship a
// uninformative baseline.
function assertFanoutSensitive(
  sweep: Array<{ fanout_factor: number; loaded_kbs: number; recall_at_10: number }>,
): void {
  const loadedKbsValues = [...new Set(sweep.map((row) => row.loaded_kbs))];
  for (const loadedKbs of loadedKbsValues) {
    const recallAtOne = sweep.find(
      (row) => row.loaded_kbs === loadedKbs && row.fanout_factor === 1,
    )?.recall_at_10;
    const recallAtFive = sweep.find(
      (row) => row.loaded_kbs === loadedKbs && row.fanout_factor === 5,
    )?.recall_at_10;
    if (recallAtOne === undefined || recallAtFive === undefined) {
      throw new Error(
        `retrieval_quality sweep missing f=1 or f=5 row at loaded_kbs=${loadedKbs}`,
      );
    }
    if (recallAtFive <= recallAtOne) {
      throw new Error(
        `retrieval_quality sweep is not sensitive to fanout_factor at loaded_kbs=${loadedKbs}: ` +
          `recall@10 at f=5 (${recallAtFive}) ≤ recall@10 at f=1 (${recallAtOne}). ` +
          'Per-KB ANN simulation may be regressing — see issue #26.',
      );
    }
  }
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
      .flatMap((group) => approximateSearch(query.text, group, vectors, 10 * fanoutFactor))
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
      .flatMap((group) => approximateSearch(query.text, group, vectors, 10 * fanoutFactor))
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

// Exact top-k by Euclidean distance. Used as the ground-truth baseline the
// fan-out merge is evaluated against.
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

// Simulated per-KB approximate search. Candidates are ranked by a noisy
// distance that is deterministic per (query, chunk) pair, but each returned
// candidate carries its EXACT distance so the downstream global merge can
// re-sort correctly. Higher `fanout_factor` compensates for the added
// ranking error by widening the per-KB candidate window — exactly the
// trade-off RFC 007 §6.4.1 asks the scenario to measure.
function approximateSearch(
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
      const exactScore = euclideanDistance(queryVector, vector);
      return {
        exactScore,
        id,
        noisyScore: exactScore + annNoise(query, id),
      };
    })
    .sort((left, right) => left.noisyScore - right.noisyScore)
    .slice(0, topK)
    .map(({ exactScore, id }) => ({ id, score: exactScore }));
}

function annNoise(query: string, chunkId: string): number {
  const hash = fnv1a(`${query} ${chunkId}`);
  return (hash / 0x1_0000_0000) * ANN_NOISE_MAGNITUDE;
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
