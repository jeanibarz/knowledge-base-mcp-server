import * as fs from 'fs';

// Issue #1065 — per-leg query child. Spawned once per compare leg by
// benchmarks/compare/run.ts so each side's similaritySearch runs in a clean
// module graph: config/model resolution inside FaissIndexManager reads THIS
// process's env (its own FAISS_INDEX_PATH + provider model) instead of
// inheriting leg A's cached imports in the orchestrator process.
//
// Contract:
//   in:  BENCH_CROSS_QUERIES_FILE — JSON string[] of queries
//        FAISS_INDEX_PATH, KNOWLEDGE_BASES_ROOT_DIR, EMBEDDING_PROVIDER +
//        provider model env (set by crossLegEnv in the parent)
//   out: BENCH_CROSS_OUT — JSON { topKs: Array<Array<{doc, score}>> }

interface SearchResult {
  metadata: Record<string, unknown>;
  pageContent: string;
  score?: number;
}

interface ManagerLike {
  initialize(): Promise<void>;
  similaritySearch(query: string, k: number): Promise<SearchResult[]>;
}

async function main(): Promise<void> {
  const queriesFile = process.env.BENCH_CROSS_QUERIES_FILE;
  const outFile = process.env.BENCH_CROSS_OUT;
  if (!queriesFile || !outFile) {
    throw new Error('cross-query: BENCH_CROSS_QUERIES_FILE and BENCH_CROSS_OUT are required');
  }
  const queries = JSON.parse(fs.readFileSync(queriesFile, 'utf-8')) as string[];

  const { FaissIndexManager } = await import(
    new URL('../../FaissIndexManager.js', import.meta.url).href
  ) as { FaissIndexManager: new () => ManagerLike };
  const manager = new FaissIndexManager();
  await manager.initialize();

  const topKs: Array<Array<{ doc: string; score: number }>> = [];
  for (const query of queries) {
    try {
      const results = await manager.similaritySearch(query, 20);
      topKs.push(results.map((r) => ({
        doc: String(r.metadata.relativePath ?? r.metadata.source ?? r.pageContent.slice(0, 40)),
        score: r.score ?? 0,
      })));
    } catch {
      topKs.push([]);
    }
  }

  fs.writeFileSync(outFile, JSON.stringify({ topKs }, null, 2) + '\n', 'utf-8');
}

main().catch((err) => {
  process.stderr.write(`cross-query: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
