import { describe, expect, it } from '@jest/globals';
import {
  deriveModelId,
  InvalidModelIdError,
  isValidModelId,
  ModelIdTooLongError,
  parseModelId,
} from './model-id.js';

describe('deriveModelId', () => {
  it('produces filesystem-safe slugs for the canonical examples', () => {
    expect(deriveModelId('ollama', 'nomic-embed-text:latest')).toBe('ollama__nomic-embed-text-latest');
    expect(deriveModelId('openai', 'text-embedding-3-small')).toBe('openai__text-embedding-3-small');
    expect(deriveModelId('huggingface', 'BAAI/bge-small-en-v1.5')).toBe('huggingface__BAAI-bge-small-en-v1.5');
  });

  it('handles complex Ollama digest-pinned names without losing case', () => {
    expect(deriveModelId('ollama', 'dengcao/Qwen3-Embedding-0.6B:Q8_0'))
      .toBe('ollama__dengcao-Qwen3-Embedding-0.6B-Q8_0');
  });

  it('collapses runs of unsafe characters into a single dash', () => {
    expect(deriveModelId('huggingface', 'a///b')).toBe('huggingface__a-b');
    expect(deriveModelId('huggingface', 'a  b')).toBe('huggingface__a-b');
  });

  it('trims leading and trailing dashes after slug normalization', () => {
    expect(deriveModelId('huggingface', '/leading-slash')).toBe('huggingface__leading-slash');
    expect(deriveModelId('huggingface', 'trailing-slash/')).toBe('huggingface__trailing-slash');
  });

  it('lowercases the provider half', () => {
    // Provider type is 'ollama' | 'openai' | 'huggingface', already lowercase
    // by typing — but the implementation also defensively lowercases at runtime.
    // We assert the output is consistently lowercased on the provider segment.
    expect(deriveModelId('ollama', 'X')).toBe('ollama__X');
    expect(deriveModelId('openai', 'X')).toBe('openai__X');
  });

  it('throws ModelIdTooLongError when the slug exceeds 240 bytes', () => {
    const longName = 'a'.repeat(250);
    expect(() => deriveModelId('huggingface', longName)).toThrow(ModelIdTooLongError);
  });

  it('produces id <= 240 bytes for long-but-tractable names (HF organization paths)', () => {
    const id = deriveModelId('huggingface', 'sentence-transformers/all-MiniLM-L6-v2-extended-name');
    expect(id.length).toBeLessThanOrEqual(240);
  });
});

describe('parseModelId', () => {
  it('round-trips canonical ids', () => {
    expect(parseModelId('ollama__nomic-embed-text-latest')).toEqual({
      provider: 'ollama',
      slugBody: 'nomic-embed-text-latest',
    });
    expect(parseModelId('huggingface__BAAI-bge-small-en-v1.5')).toEqual({
      provider: 'huggingface',
      slugBody: 'BAAI-bge-small-en-v1.5',
    });
  });

  it('rejects path-traversal characters (round-1 failure F12)', () => {
    expect(() => parseModelId('ollama__../etc/passwd')).toThrow(InvalidModelIdError);
    expect(() => parseModelId('ollama__a/b')).toThrow(InvalidModelIdError);
    expect(() => parseModelId('ollama__a\\b')).toThrow(InvalidModelIdError);
    expect(() => parseModelId('ollama__a\0b')).toThrow(InvalidModelIdError);
  });

  it('rejects ids without the __ separator', () => {
    expect(() => parseModelId('ollama-nomic')).toThrow(InvalidModelIdError);
    expect(() => parseModelId('justastring')).toThrow(InvalidModelIdError);
  });

  it('rejects ids with capital letters in the provider half', () => {
    expect(() => parseModelId('Ollama__nomic')).toThrow(InvalidModelIdError);
  });

  it('rejects empty halves', () => {
    expect(() => parseModelId('__nomic')).toThrow(InvalidModelIdError);
    expect(() => parseModelId('ollama__')).toThrow(InvalidModelIdError);
  });
});

describe('isValidModelId', () => {
  it('returns true for valid ids', () => {
    expect(isValidModelId('ollama__nomic-embed-text-latest')).toBe(true);
    expect(isValidModelId('openai__text-embedding-3-small')).toBe(true);
  });

  it('returns false for invalid ids without throwing', () => {
    expect(isValidModelId('Ollama__bad-case')).toBe(false);
    expect(isValidModelId('a/b')).toBe(false);
    expect(isValidModelId('')).toBe(false);
  });
});
