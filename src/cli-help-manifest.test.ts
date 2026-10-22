import {
  extractDefinitionList,
  extractOptions,
  extractUsageLines,
  parseFlagSpec,
  parseOptionLine,
} from './cli-help-manifest.js';

describe('extractUsageLines', () => {
  it('collects indented usage lines after the Usage: heading', () => {
    const help = [
      'Usage:',
      '  kb search <query> [options]',
      '  kb search --daemon <query>',
      '',
      'Options:',
      '  --json  Output JSON',
    ].join('\n');
    expect(extractUsageLines(help)).toEqual([
      'kb search <query> [options]',
      'kb search --daemon <query>',
    ]);
  });

  it('returns [] when no Usage: heading exists', () => {
    expect(extractUsageLines('Options:\n  --json')).toEqual([]);
  });

  it('skips leading blanks and comment lines, keeps indented blocks after blanks', () => {
    const help = [
      'Usage:',
      '',
      '  kb init <dir>',
      '  # a comment line',
      '',
      '  kb init --fresh <dir>',
      'Options:',
    ].join('\n');
    expect(extractUsageLines(help)).toEqual([
      'kb init <dir>',
      'kb init --fresh <dir>',
    ]);
  });

  it('stops at a blank line followed by a non-indented line', () => {
    const help = 'Usage:\n  kb list\n\nNotes:\n  ignored';
    expect(extractUsageLines(help)).toEqual(['kb list']);
  });
});

describe('parseOptionLine', () => {
  it('returns null for non-indented or non-flag lines', () => {
    expect(parseOptionLine('--json  flag')).toBeNull();
    expect(parseOptionLine('  positional text')).toBeNull();
  });

  it('splits flag spec from description on a 2+ space gap', () => {
    expect(parseOptionLine('  -j, --json  Output as JSON')).toEqual({
      flags: ['-j', '--json'],
      value: null,
      description: 'Output as JSON',
    });
  });

  it('captures =value forms', () => {
    expect(parseOptionLine('  --format=<fmt>  Output format')).toEqual({
      flags: ['--format'],
      value: '<fmt>',
      description: 'Output format',
    });
  });

  it('treats the whole trimmed line as the flag spec when the gap-left part is not a flag spec', () => {
    // Left of the gap contains an internal space, so it is not a valid flag
    // spec — the entire line becomes the spec, which then fails flag-token
    // validation and the line is rejected as a non-option line.
    expect(parseOptionLine('  --flag with spaces  desc')).toBeNull();
  });

  it('returns null when no valid flag token exists', () => {
    expect(parseOptionLine('  ,,,')).toBeNull();
  });
});

describe('parseFlagSpec', () => {
  it('parses comma-separated flags and the first =value', () => {
    expect(parseFlagSpec('-o, --output=<file>')).toEqual({
      flags: ['-o', '--output'],
      value: '<file>',
    });
  });

  it('skips empty and non-flag parts', () => {
    expect(parseFlagSpec('--json, , bogus!!')).toEqual({
      flags: ['--json'],
      value: null,
    });
  });
});

describe('extractOptions', () => {
  it('collects options from option sections and appends continuation descriptions', () => {
    const help = [
      'Usage:',
      '  kb search <query>',
      '',
      'Options:',
      '  --kb=<name>        Restrict to one knowledge base',
      '                        may be repeated',
      '  --json             Output JSON',
      '',
      'Notes:',
      '  --not-an-option    ignored',
    ].join('\n');
    expect(extractOptions(help)).toEqual([
      { flags: ['--kb'], value: '<name>', description: 'Restrict to one knowledge base may be repeated' },
      { flags: ['--json'], value: null, description: 'Output JSON' },
    ]);
  });

  it('adds usage-only flags not documented in an options section', () => {
    const help = [
      'Usage:',
      '  kb open <ref> [--print] [--raw]',
      '',
      'Options:',
      '  --print  Print contents',
    ].join('\n');
    expect(extractOptions(help)).toEqual([
      { flags: ['--print'], value: null, description: 'Print contents' },
      { flags: ['--raw'], value: null, description: '' },
    ]);
  });

  it('resets the pending option on a blank line', () => {
    const help = [
      'Options:',
      '  --one   first',
      '',
      '                        not a continuation',
    ].join('\n');
    expect(extractOptions(help)).toEqual([
      { flags: ['--one'], value: null, description: 'first' },
    ]);
  });
});

describe('extractDefinitionList', () => {
  const help = [
    'Environment:',
    '  FAISS_INDEX_PATH    Index root directory',
    '  LOG_FILE, LOG_LEVEL  Logging controls',
    '      continuation text',
    '',
    'Exit codes:',
    '  0   success',
  ].join('\n');

  it('extracts name/description pairs split on a 2+ space gap', () => {
    expect(extractDefinitionList(help, 'Environment:')).toEqual([
      { name: 'FAISS_INDEX_PATH', description: 'Index root directory' },
      { name: 'LOG_FILE', description: 'Logging controls continuation text' },
      { name: 'LOG_LEVEL', description: 'Logging controls continuation text' },
    ]);
  });

  it('returns [] for a missing heading', () => {
    expect(extractDefinitionList(help, 'Nope:')).toEqual([]);
  });

  it('handles single-name lines without a description', () => {
    const single = 'Head:\n  ONLYNAME\n  NEXT  desc';
    expect(extractDefinitionList(single, 'Head:')).toEqual([
      { name: 'ONLYNAME', description: '' },
      { name: 'NEXT', description: 'desc' },
    ]);
  });

  it('stops at the first non-indented line', () => {
    const stopped = 'Head:\n  A  one\nnon-indented\n  B  two';
    expect(extractDefinitionList(stopped, 'Head:')).toEqual([
      { name: 'A', description: 'one' },
    ]);
  });
});
