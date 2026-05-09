import { describe, expect, it } from '@jest/globals';
import {
  classifyKbSearchError,
  exitCodeForFailure,
  formatKbSearchFailureJson,
  formatKbSearchFailureStderr,
} from './cli-search-errors.js';
import { ActiveModelResolutionError } from './active-model.js';
import { KBError } from './errors.js';
import { WriteLockContentionError } from './write-lock.js';

describe('classifyKbSearchError', () => {
  it('classifies INDEX_NOT_INITIALIZED as an indexing failure with a refresh hint', () => {
    const err = new KBError('INDEX_NOT_INITIALIZED', 'FAISS index is not initialized');
    const f = classifyKbSearchError(err);
    expect(f.code).toBe('INDEX_NOT_INITIALIZED');
    expect(f.category).toBe('indexing');
    expect(f.message).toBe('FAISS index is not initialized');
    expect(f.next_action).toMatch(/kb search --refresh/);
    expect(exitCodeForFailure(f)).toBe(1);
  });

  it('classifies CORRUPT_INDEX as an indexing failure that points at kb doctor', () => {
    const f = classifyKbSearchError(new KBError('CORRUPT_INDEX', 'pickle parse failed'));
    expect(f.category).toBe('indexing');
    expect(f.next_action).toMatch(/kb doctor/);
  });

  it('classifies PROVIDER_AUTH as a configuration failure with API-key guidance', () => {
    const f = classifyKbSearchError(
      new KBError('PROVIDER_AUTH', 'OPENAI_API_KEY environment variable is required'),
    );
    expect(f.category).toBe('configuration');
    expect(f.next_action).toMatch(/OPENAI_API_KEY/);
    // configuration problems should not be conflated with runtime errors at the
    // shell level — the user can fix them without retrying the same call.
    expect(exitCodeForFailure(f)).toBe(2);
  });

  it('classifies PROVIDER_UNAVAILABLE as a provider failure with reachability guidance', () => {
    const f = classifyKbSearchError(
      new KBError('PROVIDER_UNAVAILABLE', 'connection refused at http://localhost:11434'),
    );
    expect(f.category).toBe('provider');
    expect(f.next_action.toLowerCase()).toMatch(/ollama|backend|reachab/);
  });

  it('classifies PROVIDER_TIMEOUT as a provider failure', () => {
    const f = classifyKbSearchError(new KBError('PROVIDER_TIMEOUT', 'request timed out'));
    expect(f.category).toBe('provider');
  });

  it('classifies KB_NOT_FOUND as a configuration failure pointing at kb list', () => {
    const f = classifyKbSearchError(new KBError('KB_NOT_FOUND', 'unknown KB "foo"'));
    expect(f.category).toBe('configuration');
    expect(f.next_action).toMatch(/kb list/);
  });

  it('classifies PERMISSION_DENIED as a permissions failure', () => {
    const f = classifyKbSearchError(
      new KBError('PERMISSION_DENIED', 'Permission denied while attempting to write /home/x'),
    );
    expect(f.category).toBe('permissions');
    expect(f.next_action).toMatch(/write access/);
  });

  it('classifies VALIDATION as an input failure (exit 2)', () => {
    const f = classifyKbSearchError(
      new KBError('VALIDATION', 'Ollama embedding model X rejected an input chunk'),
    );
    expect(f.category).toBe('input');
    expect(exitCodeForFailure(f)).toBe(2);
  });

  it('classifies INTERNAL as unknown and routes to kb doctor', () => {
    const f = classifyKbSearchError(new KBError('INTERNAL', 'unexpected'));
    expect(f.category).toBe('unknown');
    expect(f.next_action).toMatch(/kb doctor/);
  });

  it('classifies ActiveModelResolutionError as configuration with kb models hint', () => {
    const f = classifyKbSearchError(
      new ActiveModelResolutionError('No model registered. Run `kb models add` first.'),
    );
    expect(f.code).toBe('ACTIVE_MODEL_UNRESOLVED');
    expect(f.category).toBe('configuration');
    expect(f.next_action).toMatch(/kb models/);
  });

  it('classifies WriteLockContentionError as a lock failure that surfaces the lock path', () => {
    const err = new WriteLockContentionError({
      resource: '/tmp/model',
      lockPath: '/tmp/model/.kb-write.lock',
      causeMessage: 'Lock file is already being held',
    });
    const f = classifyKbSearchError(err);
    expect(f.code).toBe('REFRESH_LOCK_BUSY');
    expect(f.category).toBe('lock');
    expect(f.lock_path).toBe('/tmp/model/.kb-write.lock');
    expect(f.resource).toBe('/tmp/model');
    expect(f.next_action).toMatch(/Retry in a few seconds/);
    // lock contention is recoverable by retry → runtime exit 1.
    expect(exitCodeForFailure(f)).toBe(1);
  });

  it('classifies an unknown thrown Error as `unknown` and points at kb doctor', () => {
    const f = classifyKbSearchError(new Error('eldritch'));
    expect(f.code).toBe('UNKNOWN');
    expect(f.category).toBe('unknown');
    expect(f.message).toBe('eldritch');
    expect(f.next_action).toMatch(/kb doctor/);
  });

  it('classifies a thrown non-Error (string) as unknown without crashing', () => {
    const f = classifyKbSearchError('boom');
    expect(f.code).toBe('UNKNOWN');
    expect(f.message).toBe('boom');
  });
});

describe('formatKbSearchFailureJson', () => {
  it('omits lock_path / resource for non-lock failures', () => {
    const json = formatKbSearchFailureJson(
      classifyKbSearchError(new KBError('PROVIDER_AUTH', 'OPENAI_API_KEY missing')),
    );
    const parsed = JSON.parse(json);
    expect(parsed.error).toEqual({
      code: 'PROVIDER_AUTH',
      category: 'configuration',
      message: 'OPENAI_API_KEY missing',
      next_action: expect.any(String),
    });
    expect(parsed.error.lock_path).toBeUndefined();
    expect(parsed.error.resource).toBeUndefined();
  });

  it('produces JSON ending with a single newline so the stream stays line-delimited', () => {
    const json = formatKbSearchFailureJson(
      classifyKbSearchError(new KBError('VALIDATION', 'bad query')),
    );
    expect(json.endsWith('\n')).toBe(true);
    expect(json.endsWith('\n\n')).toBe(false);
  });
});

describe('formatKbSearchFailureStderr', () => {
  it('always shows category, code, and next-action on separate lines', () => {
    const out = formatKbSearchFailureStderr(
      classifyKbSearchError(new KBError('KB_NOT_FOUND', 'unknown KB "foo"')),
    );
    expect(out).toMatch(/^kb search: unknown KB "foo"\n/);
    expect(out).toMatch(/category: configuration \(code: KB_NOT_FOUND\)/);
    expect(out).toMatch(/next: .*kb list/);
  });
});
