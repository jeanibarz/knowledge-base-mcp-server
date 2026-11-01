import { crossLegEnv } from './cross-leg-env.js';

// Issue #1065 — the cross-model phase runs each leg's queries in a subprocess
// configured by this env. The regression it guards: both legs once shared the
// orchestrator's mutated process.env + a stale module cache, so leg B's
// manager bound leg A's index (identical scores). These assertions pin the
// per-leg isolation contract: distinct index roots and distinct provider
// model env per leg.
describe('crossLegEnv', () => {
  const base = {
    kbRoot: '/kb',
    queriesFile: '/tmp/queries.json',
    outFile: '/tmp/out.json',
  };

  it('points each leg at its own FAISS index root', () => {
    const envA = crossLegEnv({ ...base, workspace: '/tmp/legA', model: { provider: 'ollama', name: 'mA' } });
    const envB = crossLegEnv({ ...base, workspace: '/tmp/legB', model: { provider: 'ollama', name: 'mB' } });
    expect(envA.FAISS_INDEX_PATH).toBe('/tmp/legA/.faiss');
    expect(envB.FAISS_INDEX_PATH).toBe('/tmp/legB/.faiss');
    expect(envA.FAISS_INDEX_PATH).not.toBe(envB.FAISS_INDEX_PATH);
  });

  it('maps ollama provider env verbatim (colon tags preserved)', () => {
    const env = crossLegEnv({ ...base, workspace: '/tmp/leg', model: { provider: 'ollama', name: 'embeddinggemma-2:570m' } });
    expect(env.EMBEDDING_PROVIDER).toBe('ollama');
    expect(env.OLLAMA_MODEL).toBe('embeddinggemma-2:570m');
    expect(env.HUGGINGFACE_MODEL_NAME).toBeUndefined();
    expect(env.OPENAI_MODEL_NAME).toBeUndefined();
  });

  it('maps stub provider to huggingface with a default fake key', () => {
    const env = crossLegEnv({ ...base, workspace: '/tmp/leg', model: { provider: 'stub' as never, name: 'bench-stub' } });
    expect(env.EMBEDDING_PROVIDER).toBe('huggingface');
    expect(env.HUGGINGFACE_MODEL_NAME).toBe('bench-stub');
    expect(env.HUGGINGFACE_API_KEY).toBe('bench-hf-key');
  });

  it('propagates kb root and the cross-query file contract', () => {
    const env = crossLegEnv({ ...base, workspace: '/tmp/leg', model: { provider: 'ollama', name: 'm' } });
    expect(env.KNOWLEDGE_BASES_ROOT_DIR).toBe('/kb');
    expect(env.BENCH_CROSS_QUERIES_FILE).toBe('/tmp/queries.json');
    expect(env.BENCH_CROSS_OUT).toBe('/tmp/out.json');
  });
});
