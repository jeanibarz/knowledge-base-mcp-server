import type { RankedDocument } from './metrics.js';

export interface BeirDocument {
  _id: string;
  title?: string;
  text?: string;
}

export interface DocumentBm25Options {
  k1: number;
  b: number;
  titleWeight: number;
}

interface IndexedDocument {
  docId: string;
  length: number;
}

interface Posting {
  docIndex: number;
  tf: number;
}

export class DocumentBm25Ranker {
  private constructor(
    private readonly documents: IndexedDocument[],
    private readonly postingsByTerm: Map<string, Posting[]>,
    private readonly averageDocumentLength: number,
    private readonly options: DocumentBm25Options,
  ) {}

  static fromCorpus(corpus: readonly BeirDocument[], options: DocumentBm25Options): DocumentBm25Ranker {
    const documents: IndexedDocument[] = [];
    const postingsByTerm = new Map<string, Posting[]>();
    let totalLength = 0;

    corpus.forEach((row, docIndex) => {
      const termFrequency = new Map<string, number>();
      const titleTokens = tokenize(row.title ?? '');
      const bodyTokens = tokenize(row.text ?? '');
      const tokens: string[] = [];
      for (let i = 0; i < options.titleWeight; i += 1) {
        tokens.push(...titleTokens);
      }
      tokens.push(...bodyTokens);

      for (const token of tokens) {
        termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
      }
      for (const [term, tf] of termFrequency) {
        const postings = postingsByTerm.get(term);
        if (postings === undefined) {
          postingsByTerm.set(term, [{ docIndex, tf }]);
        } else {
          postings.push({ docIndex, tf });
        }
      }

      documents.push({ docId: row._id, length: tokens.length });
      totalLength += tokens.length;
    });

    return new DocumentBm25Ranker(
      documents,
      postingsByTerm,
      documents.length === 0 ? 0 : totalLength / documents.length,
      options,
    );
  }

  query(query: string, k: number): RankedDocument[] {
    if (k <= 0 || this.documents.length === 0) return [];
    const scores = new Map<number, number>();
    for (const term of tokenize(query)) {
      const postings = this.postingsByTerm.get(term);
      if (postings === undefined) continue;
      const idf = this.inverseDocumentFrequency(postings.length);
      for (const posting of postings) {
        const doc = this.documents[posting.docIndex];
        const score = idf * this.termScore(posting.tf, doc.length);
        scores.set(posting.docIndex, (scores.get(posting.docIndex) ?? 0) + score);
      }
    }

    return [...scores.entries()]
      .map(([docIndex, score]) => ({ docId: this.documents[docIndex].docId, score }))
      .sort((left, right) => right.score - left.score || left.docId.localeCompare(right.docId))
      .slice(0, k);
  }

  private inverseDocumentFrequency(documentFrequency: number): number {
    return Math.log(1 + ((this.documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5)));
  }

  private termScore(termFrequency: number, documentLength: number): number {
    const { b, k1 } = this.options;
    const denominator = termFrequency + k1 * (
      1 - b + b * (documentLength / Math.max(1, this.averageDocumentLength))
    );
    return (termFrequency * (k1 + 1)) / denominator;
  }
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}
