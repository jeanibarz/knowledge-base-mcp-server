import * as path from 'path';

// Local alias of the union declared in run.ts — kept here (not re-exported
// from it) so this module stays import-safe and free of cycles.
type EmbeddingProvider = 'huggingface' | 'ollama' | 'openai';

export interface CrossLegSpec {
  provider: EmbeddingProvider;
  name: string;
}

export interface CrossLegEnvOptions {
  workspace: string;
  kbRoot: string;
  model: CrossLegSpec;
  queriesFile: string;
  outFile: string;
}

// Issue #1065 — env for one cross-model leg's subprocess. Per-leg isolation
// lives in process env: FAISS_INDEX_PATH points at the leg's own index root
// and the provider model var carries that leg's model. The subprocess reads
// these once at startup, so unlike the old in-process env mutation +
// cache-busted top-module import, no transitive config can leak between legs.
export function crossLegEnv(options: CrossLegEnvOptions): NodeJS.ProcessEnv {
  const provider = options.model.provider === ('stub' as EmbeddingProvider)
    ? 'huggingface'
    : options.model.provider;
  const env: NodeJS.ProcessEnv = {
    BENCH_CROSS_OUT: options.outFile,
    BENCH_CROSS_QUERIES_FILE: options.queriesFile,
    EMBEDDING_PROVIDER: provider,
    FAISS_INDEX_PATH: path.join(options.workspace, '.faiss'),
    KNOWLEDGE_BASES_ROOT_DIR: options.kbRoot,
  };
  if (provider === 'huggingface') {
    env.HUGGINGFACE_MODEL_NAME = options.model.name;
    env.HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY ?? 'bench-hf-key';
  } else if (provider === 'ollama') {
    env.OLLAMA_MODEL = options.model.name;
  } else {
    env.OPENAI_MODEL_NAME = options.model.name;
  }
  return env;
}
