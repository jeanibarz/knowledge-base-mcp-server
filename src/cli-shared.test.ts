import { describe, expect, it } from '@jest/globals';
import {
  closestSuggestion,
  createVerbosityPrinter,
  extractVerbosity,
  formatKnowledgeBaseSuggestions,
  rankSuggestions,
  renderRecords,
} from './cli-shared.js';

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
