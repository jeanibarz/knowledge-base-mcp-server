// RFC 020 §8 (milestone M4) — MTEB embedding-model registry.
//
// "MTEB ranks the embedding model, not our pipeline. The path is to run the
// official mteb package against our active embedding model (Qwen3-Embedding-0.6B
// and any successor under RFC 013) and, if the result is competitive, open the
// leaderboard PR."
//
// This registry maps the kb embedding provider+model env (src/config/provider.ts)
// to the canonical MTEB/HuggingFace model id the `mteb` package expects, plus the
// metadata a submission needs (embedding dim, whether the id is on the public
// leaderboard). It is the single source of truth that keeps the MTEB run pointed
// at the SAME model the product ships, so the leaderboard number is faithful.

export interface MtebModelEntry {
  /** kb provider this default belongs to. */
  provider: 'ollama' | 'huggingface' | 'openai';
  /** The provider-local model id (the OLLAMA_MODEL / HUGGINGFACE_MODEL_NAME). */
  kbModel: string;
  /** Canonical HuggingFace/MTEB model id passed to the `mteb` package. */
  mtebModelId: string;
  /** Embedding dimensionality (recorded in the result for provenance). */
  dimensions: number;
  /** Whether this model already appears on the public MTEB leaderboard. */
  onLeaderboard: boolean;
  note: string;
}

// The product default (RFC 013 / src/config/provider.ts:106) is the Ollama
// Qwen3-Embedding-0.6B build; the HF/OpenAI defaults are recorded so a run that
// switches EMBEDDING_PROVIDER still resolves the right MTEB id.
export const MTEB_MODEL_REGISTRY: readonly MtebModelEntry[] = [
  {
    provider: 'ollama',
    kbModel: 'dengcao/Qwen3-Embedding-0.6B:Q8_0',
    mtebModelId: 'Qwen/Qwen3-Embedding-0.6B',
    dimensions: 1024,
    onLeaderboard: true,
    note: 'Default kb embedding model (RFC 013). The Ollama Q8_0 build of Qwen3-Embedding-0.6B; ' +
      'MTEB ranks the upstream Qwen/Qwen3-Embedding-0.6B checkpoint.',
  },
  {
    provider: 'huggingface',
    kbModel: 'BAAI/bge-small-en-v1.5',
    mtebModelId: 'BAAI/bge-small-en-v1.5',
    dimensions: 384,
    onLeaderboard: true,
    note: 'HuggingFace provider default; already on the MTEB leaderboard.',
  },
  {
    provider: 'openai',
    kbModel: 'text-embedding-3-small',
    mtebModelId: 'text-embedding-3-small',
    dimensions: 1536,
    onLeaderboard: true,
    note: 'OpenAI provider default; MTEB lists OpenAI text-embedding-3-small.',
  },
];

const BY_PROVIDER: ReadonlyMap<string, MtebModelEntry> = new Map(
  MTEB_MODEL_REGISTRY.map((entry) => [entry.provider, entry]),
);

/** Resolve the MTEB model entry for a kb provider (defaults to ollama). */
export function resolveMtebModel(provider: string | undefined): MtebModelEntry | undefined {
  return BY_PROVIDER.get((provider ?? 'ollama').toLowerCase());
}

/** Look up an MTEB entry by its kb-local model id. */
export function mtebModelByKbModel(kbModel: string): MtebModelEntry | undefined {
  return MTEB_MODEL_REGISTRY.find((entry) => entry.kbModel === kbModel);
}

export function assertMtebRegistryInvariants(
  registry: readonly MtebModelEntry[] = MTEB_MODEL_REGISTRY,
): void {
  const providers = new Set<string>();
  for (const entry of registry) {
    if (providers.has(entry.provider)) throw new Error(`mteb registry: duplicate provider "${entry.provider}"`);
    providers.add(entry.provider);
    if (entry.mtebModelId.trim() === '') throw new Error(`mteb registry: "${entry.provider}" has no MTEB model id`);
    if (entry.dimensions <= 0) throw new Error(`mteb registry: "${entry.provider}" has non-positive dimensions`);
  }
  if (providers.size === 0) throw new Error('mteb registry: empty');
}
