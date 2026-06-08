import { describe, expect, it } from '@jest/globals';
import {
  assertMtebRegistryInvariants,
  MTEB_MODEL_REGISTRY,
  mtebModelByKbModel,
  resolveMtebModel,
} from './registry.js';

describe('mteb model registry', () => {
  it('maps the kb Ollama default to the canonical MTEB Qwen3 id', () => {
    const entry = resolveMtebModel('ollama');
    expect(entry?.kbModel).toBe('dengcao/Qwen3-Embedding-0.6B:Q8_0');
    expect(entry?.mtebModelId).toBe('Qwen/Qwen3-Embedding-0.6B');
  });

  it('defaults to ollama and looks up by kb model id', () => {
    expect(resolveMtebModel(undefined)?.provider).toBe('ollama');
    expect(mtebModelByKbModel('BAAI/bge-small-en-v1.5')?.provider).toBe('huggingface');
    expect(mtebModelByKbModel('nope')).toBeUndefined();
  });

  it('passes the invariant check and rejects duplicates / bad dims', () => {
    expect(() => assertMtebRegistryInvariants()).not.toThrow();
    expect(() => assertMtebRegistryInvariants([MTEB_MODEL_REGISTRY[0], MTEB_MODEL_REGISTRY[0]])).toThrow(/duplicate/);
  });
});
