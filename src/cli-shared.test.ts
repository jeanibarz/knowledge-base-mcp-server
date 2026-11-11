import { describe, expect, it } from '@jest/globals';
import {
  captureProcessOutput,
  closestSuggestion,
  createVerbosityPrinter,
  extractVerbosity,
  formatKnowledgeBaseSuggestions,
  loadWithJsonRetry,
  rankSuggestions,
  renderRecords,
} from './cli-shared.js';
import { levenshteinDistance as coreLevenshteinDistance } from './suggestion-core.js';
import { KBError } from './errors.js';
import type { FaissIndexManager } from './FaissIndexManager.js';

describe('renderRecords', () => {
  it('quotes CSV fields using RFC-4180 escaping', () => {
    expect(renderRecords([
      { name: 'alpha, beta', note: 'He said "yes"', lines: 'one\ntwo' },
    ], 'csv', { columns: ['name', 'note', 'lines'] })).toBe(
      'name,note,lines\n"alpha, beta","He said ""yes""","one\ntwo"\n',
    );
  });

  it('renders TSV headers and JSON-encodes nested values', () => {
    expect(renderRecords([
      { name: 'alpha', flags: ['active', 'fresh'], meta: { count: 2 } },
    ], 'tsv', { columns: ['name', 'flags', 'meta'] })).toBe(
      'name\tflags\tmeta\nalpha\t"[""active"",""fresh""]"\t"{""count"":2}"\n',
    );
  });

  it('renders compact NDJSON without an envelope', () => {
    expect(renderRecords([
      { name: 'alpha', count: 1 },
      { name: 'beta', count: 2 },
    ], 'ndjson')).toBe(
      '{"name":"alpha","count":1}\n{"name":"beta","count":2}\n',
    );
  });
});

describe('knowledge-base typo suggestions (FR-CLI-832)', () => {
  it('ranks candidates by Levenshtein distance with deterministic tie-breaking', () => {
    expect(rankSuggestions('alpah', ['beta', 'alpha', 'alps', 'alpha'])).toEqual([
      { value: 'alps', distance: 2 },
      { value: 'alpha', distance: 2 },
      { value: 'beta', distance: 4 },
    ]);
  });

  it('returns the nearest suggestion for a transposed typo', () => {
    expect(closestSuggestion('alpah', ['alpha', 'beta'])).toEqual({ value: 'alpha', distance: 2 });
    expect(coreLevenshteinDistance('alpah', 'alpha')).toBe(2);
  });

  it('formats a bounded list and nearest-match line', () => {
    expect(formatKnowledgeBaseSuggestions('alpah', [
      'zeta', 'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'theta',
    ])).toBe(
      'Available knowledge bases: alpha, beta, zeta, delta, gamma.\n' +
      'Did you mean alpha?',
    );
  });

  it('omits the nearest-match line for distant candidates', () => {
    const output = formatKnowledgeBaseSuggestions('zzzzzzzz', ['alpha', 'beta']);
    expect(output).toContain('Available knowledge bases:');
    expect(output).not.toContain('Did you mean');
  });
});

describe('extractVerbosity (issue #739)', () => {
  it('defaults to normal and leaves argv untouched', () => {
    expect(extractVerbosity(['query', '--kb=ops'])).toEqual({
      verbosity: 'normal',
      rest: ['query', '--kb=ops'],
    });
  });

  it('strips --quiet / -q and resolves quiet', () => {
    expect(extractVerbosity(['a', '--quiet', 'b'])).toEqual({ verbosity: 'quiet', rest: ['a', 'b'] });
    expect(extractVerbosity(['-q', 'a'])).toEqual({ verbosity: 'quiet', rest: ['a'] });
  });

  it('strips --verbose / -v and resolves verbose', () => {
    expect(extractVerbosity(['a', '--verbose'])).toEqual({ verbosity: 'verbose', rest: ['a'] });
    expect(extractVerbosity(['-v', 'a'])).toEqual({ verbosity: 'verbose', rest: ['a'] });
  });

  it('lets the last verbosity flag win when both appear', () => {
    expect(extractVerbosity(['--verbose', '--quiet']).verbosity).toBe('quiet');
    expect(extractVerbosity(['--quiet', '--verbose']).verbosity).toBe('verbose');
  });
});

describe('createVerbosityPrinter (issue #739)', () => {
  function capture(verbosity: Parameters<typeof createVerbosityPrinter>[0]): {
    lines: string[];
    printer: ReturnType<typeof createVerbosityPrinter>;
  } {
    const lines: string[] = [];
    return { lines, printer: createVerbosityPrinter(verbosity, (text) => lines.push(text)) };
  }

  it('normal: writes info but not diag', () => {
    const { lines, printer } = capture('normal');
    printer.info('i\n');
    printer.diag('d\n');
    expect(lines).toEqual(['i\n']);
    expect(printer.isQuiet).toBe(false);
    expect(printer.isVerbose).toBe(false);
  });

  it('quiet: suppresses both info and diag', () => {
    const { lines, printer } = capture('quiet');
    printer.info('i\n');
    printer.diag('d\n');
    expect(lines).toEqual([]);
    expect(printer.isQuiet).toBe(true);
  });

  it('verbose: writes both info and diag', () => {
    const { lines, printer } = capture('verbose');
    printer.info('i\n');
    printer.diag('d\n');
    expect(lines).toEqual(['i\n', 'd\n']);
    expect(printer.isVerbose).toBe(true);
  });
});

describe('loadWithJsonRetry (issue #1179)', () => {
  function managerThatThrows(make: () => Error): { manager: FaissIndexManager; calls: () => number } {
    let calls = 0;
    const manager = {
      initialize: async () => {
        calls += 1;
        throw make();
      },
    } as unknown as FaissIndexManager;
    return { manager, calls: () => calls };
  }

  it('keeps the CORRUPT_INDEX code when the corrupt-index message mentions a JSON parse error', async () => {
    const { manager, calls } = managerThatThrows(() => new KBError(
      'CORRUPT_INDEX',
      'Versioned FAISS index /x/index.v0 is corrupt or unreadable; read-only load will not repair it. ' +
        'Underlying error: Unexpected token g in JSON at position 0',
    ));

    await expect(loadWithJsonRetry(manager)).rejects.toMatchObject({ code: 'CORRUPT_INDEX' });
    expect(calls()).toBe(2);
  });

  it('still reports an unclassified repeated JSON parse failure as a concurrent write', async () => {
    const { manager } = managerThatThrows(() => new SyntaxError('Unexpected end of JSON input'));

    await expect(loadWithJsonRetry(manager)).rejects.toThrow(/mid-write/);
  });
});

describe('captureProcessOutput concurrency (issue #1189)', () => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  async function overlap(finishFirstA: boolean) {
    const gateA = deferred();
    const gateB = deferred();
    const a = captureProcessOutput(async () => {
      process.stdout.write('A1;');
      process.stderr.write('a-err1;');
      await gateA.promise;
      process.stdout.write('A2;');
      process.stderr.write('a-err2;');
      return 1;
    });
    await tick();
    const b = captureProcessOutput(async () => {
      process.stdout.write('B1;');
      process.stderr.write('b-err1;');
      await gateB.promise;
      process.stdout.write('B2;');
      process.stderr.write('b-err2;');
      return 2;
    });
    await tick();
    (finishFirstA ? gateA : gateB).resolve();
    await tick();
    (finishFirstA ? gateB : gateA).resolve();
    return Promise.all([a, b]);
  }

  it.each([
    ['arrival order', true],
    ['reverse order', false],
  ])('gives each overlapping capture only its own output (%s)', async (_label, firstA) => {
    const [a, b] = await overlap(firstA);
    expect(a).toEqual({ exitCode: 1, stdout: 'A1;A2;', stderr: 'a-err1;a-err2;' });
    expect(b).toEqual({ exitCode: 2, stdout: 'B1;B2;', stderr: 'b-err1;b-err2;' });
  });

  it.each([
    ['arrival order', true],
    ['reverse order', false],
  ])('restores the real stream after overlapping captures (%s)', async (_label, firstA) => {
    const before = process.stdout.write;
    const beforeErr = process.stderr.write;
    await overlap(firstA);
    expect(process.stdout.write).toBe(before);
    expect(process.stderr.write).toBe(beforeErr);
  });

  it('passes writes outside any capture through to the real stream while a capture is active', async () => {
    const gate = deferred();
    const seen: string[] = [];
    const realWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => {
      seen.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const capture = captureProcessOutput(async () => {
        process.stdout.write('captured;');
        await gate.promise;
        return 0;
      });
      await tick();
      // Issued from the test's own async context, not the capture's.
      process.stdout.write('daemon-log;');
      gate.resolve();
      const result = await capture;
      expect(result.stdout).toBe('captured;');
      expect(seen).toEqual(['daemon-log;']);
    } finally {
      process.stdout.write = realWrite;
    }
  });

  it('keeps sequential captures working', async () => {
    const first = await captureProcessOutput(async () => {
      process.stdout.write('one');
      return 0;
    });
    const second = await captureProcessOutput(async () => {
      process.stdout.write(Buffer.from('two'));
      return 3;
    });
    expect(first).toEqual({ exitCode: 0, stdout: 'one', stderr: '' });
    expect(second).toEqual({ exitCode: 3, stdout: 'two', stderr: '' });
  });
});
