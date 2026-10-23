// rerank-types.ts — issue #1006. Leaf module for the `RerankScoreCache`
// interface so rerank-cache-disk.ts's `DiskTieredRerankScoreCache` can
// implement it without creating a type-level cycle with reranker.ts (which
// does a runtime value import of DiskTieredRerankScoreCache). reranker.ts
// re-exports from here so its own internal usages keep compiling unchanged.

export interface RerankScoreCache {
  get(modelId: string, query: string, candidateText: string): number | null;
  set(modelId: string, query: string, candidateText: string, score: number): void;
}
