import {
  isOllamaContextLengthError,
  isNonRetryableOllamaError,
  translateOllamaEmbeddingError,
  makeOllamaOnFailedAttempt,
} from './ollama-error.js';
import { KBError } from './errors.js';

// Mirror the runtime shape produced by the `ollama` SDK's checkOk():
//   throw new ResponseError(message, response.status);
//   class ResponseError extends Error { status_code: number; name: 'ResponseError' }
class FakeOllamaResponseError extends Error {
  status_code: number;
  override name = 'ResponseError';
  constructor(message: string, statusCode: number) {
    super(message);
    this.status_code = statusCode;
  }
}

describe('isOllamaContextLengthError', () => {
  it('matches the verbatim Ollama 0.x message', () => {
    const err = new FakeOllamaResponseError(
      'the input length exceeds the context length',
      400,
    );
    expect(isOllamaContextLengthError(err)).toBe(true);
  });

  it('matches a phrasing variant ("input is too long")', () => {
    const err = new FakeOllamaResponseError('input is too long for model', 400);
    expect(isOllamaContextLengthError(err)).toBe(true);
  });

  it('matches a future "context length exceeded" rephrasing', () => {
    const err = new FakeOllamaResponseError('context length exceeded', 400);
    expect(isOllamaContextLengthError(err)).toBe(true);
  });

  it('matches by status_code 400 + context+length keywords', () => {
    const err = new FakeOllamaResponseError(
      'request rejected: context length not enough for input',
      400,
    );
    expect(isOllamaContextLengthError(err)).toBe(true);
  });

  it('does not match generic 5xx errors', () => {
    const err = new FakeOllamaResponseError('internal server error', 500);
    expect(isOllamaContextLengthError(err)).toBe(false);
  });

  it('does not match plain Error instances', () => {
    expect(isOllamaContextLengthError(new Error('socket hang up'))).toBe(false);
  });

  it('returns false for non-objects', () => {
    expect(isOllamaContextLengthError(undefined)).toBe(false);
    expect(isOllamaContextLengthError(null)).toBe(false);
    expect(isOllamaContextLengthError('boom')).toBe(false);
  });
});

describe('isNonRetryableOllamaError', () => {
  it.each([400, 401, 402, 403, 404, 405, 406, 407, 409])(
    'flags ResponseError with status %i as non-retryable',
    (status) => {
      const err = new FakeOllamaResponseError('nope', status);
      expect(isNonRetryableOllamaError(err)).toBe(true);
    },
  );

  it.each([408, 425, 429, 500, 502, 503, 504])(
    'leaves status %i as retryable',
    (status) => {
      const err = new FakeOllamaResponseError('transient', status);
      expect(isNonRetryableOllamaError(err)).toBe(false);
    },
  );

  it('does not flag generic Errors as non-retryable', () => {
    expect(isNonRetryableOllamaError(new Error('ECONNRESET'))).toBe(false);
  });

  it('flags context-length errors even without ResponseError name', () => {
    // Defensive: future SDK rewrap might lose the .name. Keep matching by
    // message so we still short-circuit.
    const err = Object.assign(new Error('the input length exceeds the context length'), {
      status_code: 400,
    });
    expect(isNonRetryableOllamaError(err)).toBe(true);
  });
});

describe('translateOllamaEmbeddingError', () => {
  it('returns a KBError with VALIDATION code for context-length errors', () => {
    const original = new FakeOllamaResponseError(
      'the input length exceeds the context length',
      400,
    );
    const translated = translateOllamaEmbeddingError(original, 'all-minilm:latest');
    expect(translated).toBeInstanceOf(KBError);
    expect(translated.code).toBe('VALIDATION');
    expect(translated.cause).toBe(original);
  });

  it('names the offending model in the translated message', () => {
    const err = new FakeOllamaResponseError(
      'the input length exceeds the context length',
      400,
    );
    const translated = translateOllamaEmbeddingError(err, 'all-minilm:latest');
    expect(translated.message).toContain('all-minilm:latest');
  });

  it('points at larger-context alternatives', () => {
    const err = new FakeOllamaResponseError(
      'the input length exceeds the context length',
      400,
    );
    const translated = translateOllamaEmbeddingError(err, 'all-minilm:latest');
    expect(translated.message).toContain('nomic-embed-text');
    expect(translated.message).toContain('Qwen3-Embedding-0.6B');
  });

  it('falls back to PROVIDER_UNAVAILABLE for non-context 4xx', () => {
    const err = new FakeOllamaResponseError('not found', 404);
    const translated = translateOllamaEmbeddingError(err, 'fake-model');
    expect(translated).toBeInstanceOf(KBError);
    expect(translated.code).toBe('PROVIDER_UNAVAILABLE');
    expect(translated.message).toContain('fake-model');
    expect(translated.message).toContain('not found');
  });
});

describe('makeOllamaOnFailedAttempt', () => {
  it('throws a translated KBError on context-length errors (aborts retry)', () => {
    const handler = makeOllamaOnFailedAttempt('all-minilm:latest');
    const err = new FakeOllamaResponseError(
      'the input length exceeds the context length',
      400,
    );
    expect(() => handler(err)).toThrow(KBError);
    try {
      handler(err);
      fail('expected throw');
    } catch (caught) {
      expect(caught).toBeInstanceOf(KBError);
      expect((caught as KBError).code).toBe('VALIDATION');
      expect((caught as KBError).message).toContain('all-minilm:latest');
    }
  });

  it('throws on any non-retryable 4xx', () => {
    const handler = makeOllamaOnFailedAttempt('foo');
    const err = new FakeOllamaResponseError('forbidden', 403);
    expect(() => handler(err)).toThrow(KBError);
  });

  it('does NOT throw on retryable 5xx (lets AsyncCaller keep retrying)', () => {
    const handler = makeOllamaOnFailedAttempt('foo');
    const err = new FakeOllamaResponseError('upstream timeout', 504);
    expect(() => handler(err)).not.toThrow();
  });

  it('does NOT throw on plain Error (network jitter etc.)', () => {
    const handler = makeOllamaOnFailedAttempt('foo');
    expect(() => handler(new Error('ECONNRESET'))).not.toThrow();
  });
});
