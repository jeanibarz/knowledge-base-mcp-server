import {
  isOllamaContextLengthError,
  isNonRetryableOllamaError,
  isTransientOllamaSocketError,
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

  // Issue #801 — transient runner-socket drops must stay retryable, even if a
  // future daemon build wraps one in a ResponseError with an odd status.
  it('leaves a raw EOF socket error retryable', () => {
    const err = new Error(
      'do embedding request: Post "http://127.0.0.1:40757/v1/embeddings": EOF',
    );
    expect(isNonRetryableOllamaError(err)).toBe(false);
  });

  it('does not flag a ResponseError-wrapped EOF as non-retryable', () => {
    const err = new FakeOllamaResponseError(
      'do embedding request: Post "http://127.0.0.1:40757/v1/embeddings": EOF',
      500,
    );
    expect(isNonRetryableOllamaError(err)).toBe(false);
  });
});

describe('isTransientOllamaSocketError', () => {
  it.each([
    'do embedding request: Post "http://127.0.0.1:40757/v1/embeddings": EOF',
    'read ECONNRESET',
    'socket hang up',
    'ETIMEDOUT',
    'connect ECONNREFUSED 127.0.0.1:40757',
  ])('classifies %j as transient', (message) => {
    expect(isTransientOllamaSocketError(new Error(message))).toBe(true);
  });

  it('classifies a fetch failure nested in .cause as transient', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: new Error('read ECONNRESET'),
    });
    expect(isTransientOllamaSocketError(err)).toBe(true);
  });

  it('classifies by node error .code', () => {
    const err = Object.assign(new Error('socket error'), { code: 'ECONNRESET' });
    expect(isTransientOllamaSocketError(err)).toBe(true);
  });

  it('does not classify a 4xx schema violation as transient', () => {
    const err = new FakeOllamaResponseError('not found', 404);
    expect(isTransientOllamaSocketError(err)).toBe(false);
  });

  it('does not classify a context-length overflow as transient', () => {
    const err = new FakeOllamaResponseError(
      'the input length exceeds the context length',
      400,
    );
    expect(isTransientOllamaSocketError(err)).toBe(false);
  });

  it('returns false for non-objects', () => {
    expect(isTransientOllamaSocketError(undefined)).toBe(false);
    expect(isTransientOllamaSocketError('EOF')).toBe(false);
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

  it('still labels a genuinely terminal 4xx "non-retryable"', () => {
    const err = new FakeOllamaResponseError('forbidden', 403);
    const translated = translateOllamaEmbeddingError(err, 'fake-model');
    expect(translated.message).toContain('non-retryable');
  });

  // Issue #801 — a transient EOF must NOT be reported as "non-retryable".
  it('describes a transient EOF accurately, not as "non-retryable"', () => {
    const err = new FakeOllamaResponseError(
      'do embedding request: Post "http://127.0.0.1:40757/v1/embeddings": EOF',
      500,
    );
    const translated = translateOllamaEmbeddingError(err, 'nomic-embed-text:latest');
    expect(translated).toBeInstanceOf(KBError);
    expect(translated.code).toBe('PROVIDER_UNAVAILABLE');
    expect(translated.message).not.toContain('non-retryable');
    expect(translated.message).toContain('transient socket error');
    expect(translated.message).toContain('nomic-embed-text:latest');
    // Preserve the underlying detail for diagnosis.
    expect(translated.message).toContain('EOF');
  });

  it('describes a raw ECONNRESET as transient, not non-retryable', () => {
    const translated = translateOllamaEmbeddingError(
      new Error('read ECONNRESET'),
      'nomic-embed-text:latest',
    );
    expect(translated.message).not.toContain('non-retryable');
    expect(translated.message).toContain('transient socket error');
  });

  it('does not claim "non-retryable" for an unknown non-context error', () => {
    const err = new FakeOllamaResponseError('internal server error', 500);
    const translated = translateOllamaEmbeddingError(err, 'fake-model');
    expect(translated.message).not.toContain('non-retryable');
    expect(translated.message).toContain('internal server error');
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

  // Issue #801 — a transient runner-socket EOF must stay retryable so the
  // AsyncCaller keeps retrying instead of aborting the whole rebuild.
  it('does NOT throw on a transient EOF (keeps retrying)', () => {
    const handler = makeOllamaOnFailedAttempt('nomic-embed-text:latest');
    const err = new FakeOllamaResponseError(
      'do embedding request: Post "http://127.0.0.1:40757/v1/embeddings": EOF',
      500,
    );
    expect(() => handler(err)).not.toThrow();
  });
});
