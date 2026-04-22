export type BenchProvider = 'stub' | 'ollama' | 'openai' | 'huggingface';

export interface ColdStartScenarioResult {
  fixture_documents: number;
  ms: number;
  rss_bytes: number;
}

export interface ColdIndexScenarioResult {
  add_documents_calls?: number;
  chunks: number;
  files: number;
  from_texts_calls?: number;
  ms: number;
  save_calls?: number;
}

export interface WarmQueryScenarioResult {
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  repetitions: number;
}

export interface MemoryScenarioResult {
  chunk_count: number;
  files: number;
  heap_used_bytes: number;
  rss_bytes: number;
}

export interface RetrievalQualitySweepResult {
  expected_hit_rate_at_10: number;
  fanout_factor: number;
  loaded_kbs: number;
  recall_at_10: number;
}

export interface RetrievalQualityScenarioResult {
  default_fanout_factor: number;
  default_loaded_kbs: number;
  default_recall_at_10: number;
  query_count: number;
  sweep: RetrievalQualitySweepResult[];
}

export interface BenchmarkReport {
  arch: string;
  git_sha: string;
  node_version: string;
  os: string;
  provider: BenchProvider;
  scenarios: {
    cold_index: ColdIndexScenarioResult;
    cold_start: ColdStartScenarioResult;
    memory_peak: MemoryScenarioResult;
    retrieval_quality: RetrievalQualityScenarioResult;
    warm_query: WarmQueryScenarioResult;
  };
  version: 1;
}

export interface BenchmarkCounterState {
  addDocumentsCalls: number;
  embeddedDocuments: number;
  embeddedQueries: number;
  fromTextsCalls: number;
  loadCalls: number;
  saveCalls: number;
}

export interface StubController {
  getCounters(): BenchmarkCounterState;
  resetCounters(): void;
}

export interface ScenarioContext {
  buildRoot: string;
  faissIndexPath: string;
  fixtureSeed: number;
  knowledgeBaseName: string;
  knowledgeBasesRootDir: string;
  provider: BenchProvider;
  repoRoot: string;
  stubController?: StubController;
  workspaceRoot: string;
}
