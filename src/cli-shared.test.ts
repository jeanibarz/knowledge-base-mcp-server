import { describe, expect, it } from '@jest/globals';
import { renderRecords } from './cli-shared.js';

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
