export interface LexicalBm25Options {
  k1: number;
  b: number;
  titleWeight: number;
}

export const DEFAULT_LEXICAL_BM25_OPTIONS: LexicalBm25Options = {
  k1: 1.2,
  b: 0.75,
  titleWeight: 3,
};

export interface LexicalBm25Record<T> {
  item: T;
  text: string;
  title?: string;
}

interface IndexedRecord<T> {
  item: T;
  length: number;
}

interface Posting {
  recordIndex: number;
  tf: number;
}

export class LexicalBm25Ranker<T> {
  private constructor(
    private readonly records: IndexedRecord<T>[],
    private readonly postingsByTerm: Map<string, Posting[]>,
    private readonly averageRecordLength: number,
    private readonly options: LexicalBm25Options,
  ) {}

  static fromRecords<T>(
    records: ReadonlyArray<LexicalBm25Record<T>>,
    options: LexicalBm25Options = DEFAULT_LEXICAL_BM25_OPTIONS,
  ): LexicalBm25Ranker<T> {
    const indexed: IndexedRecord<T>[] = [];
    const postingsByTerm = new Map<string, Posting[]>();
    let totalLength = 0;

    records.forEach((record, recordIndex) => {
      const termFrequency = new Map<string, number>();
      const tokens = weightedTokens(record, options.titleWeight);
      for (const token of tokens) {
        termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
      }
      for (const [term, tf] of termFrequency) {
        const posting = { recordIndex, tf };
        const postings = postingsByTerm.get(term);
        if (postings === undefined) postingsByTerm.set(term, [posting]);
        else postings.push(posting);
      }

      indexed.push({ item: record.item, length: tokens.length });
      totalLength += tokens.length;
    });

    return new LexicalBm25Ranker(
      indexed,
      postingsByTerm,
      indexed.length === 0 ? 0 : totalLength / indexed.length,
      options,
    );
  }

  query(query: string, k: number): Array<{ item: T; score: number }> {
    if (k <= 0 || this.records.length === 0) return [];
    const scores = new Map<number, number>();
    for (const term of tokenizeLexicalText(query)) {
      const postings = this.postingsByTerm.get(term);
      if (postings === undefined) continue;
      const idf = this.inverseDocumentFrequency(postings.length);
      for (const posting of postings) {
        const record = this.records[posting.recordIndex];
        const score = idf * this.termScore(posting.tf, record.length);
        scores.set(posting.recordIndex, (scores.get(posting.recordIndex) ?? 0) + score);
      }
    }

    return [...scores.entries()]
      .map(([recordIndex, score]) => ({ item: this.records[recordIndex].item, score }))
      .sort((left, right) => right.score - left.score)
      .slice(0, k);
  }

  private inverseDocumentFrequency(documentFrequency: number): number {
    return Math.log(1 + ((this.records.length - documentFrequency + 0.5) / (documentFrequency + 0.5)));
  }

  private termScore(termFrequency: number, recordLength: number): number {
    const { b, k1 } = this.options;
    const denominator = termFrequency + k1 * (
      1 - b + b * (recordLength / Math.max(1, this.averageRecordLength))
    );
    return (termFrequency * (k1 + 1)) / denominator;
  }
}

function weightedTokens(record: LexicalBm25Record<unknown>, titleWeight: number): string[] {
  const tokens: string[] = [];
  const titleTokens = tokenizeLexicalText(record.title ?? '');
  for (let i = 0; i < titleWeight; i += 1) {
    tokens.push(...titleTokens);
  }
  tokens.push(...tokenizeLexicalText(record.text));
  return tokens;
}

export function tokenizeLexicalText(text: string): string[] {
  return text
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}
