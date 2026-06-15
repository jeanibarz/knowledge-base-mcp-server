import {
  ANSI_BOLD,
  ANSI_BOLD_OFF,
  isNoColorSet,
  parseColorMode,
  readKbColorMode,
  resolveColorEnabled,
} from './color.js';
import { shouldHighlightSearchOutput } from './cli-search.js';

describe('parseColorMode', () => {
  it('accepts the three modes', () => {
    expect(parseColorMode('auto')).toBe('auto');
    expect(parseColorMode('always')).toBe('always');
    expect(parseColorMode('never')).toBe('never');
  });

  it('rejects anything else with a flag-shaped error', () => {
    expect(() => parseColorMode('sometimes')).toThrow(/invalid --color: sometimes/);
    expect(() => parseColorMode('1', '--color')).toThrow(
      /expected 'auto', 'always', or 'never'/,
    );
  });
});

describe('isNoColorSet', () => {
  it('treats a non-empty NO_COLOR as set and empty/unset as not set', () => {
    expect(isNoColorSet({ NO_COLOR: '1' })).toBe(true);
    expect(isNoColorSet({ NO_COLOR: '0' })).toBe(true);
    expect(isNoColorSet({ NO_COLOR: 'anything' })).toBe(true);
    expect(isNoColorSet({ NO_COLOR: '' })).toBe(false);
    expect(isNoColorSet({})).toBe(false);
  });
});

describe('readKbColorMode', () => {
  it('parses recognized values case-insensitively and ignores junk', () => {
    expect(readKbColorMode({ KB_COLOR: 'always' })).toBe('always');
    expect(readKbColorMode({ KB_COLOR: 'NEVER' })).toBe('never');
    expect(readKbColorMode({ KB_COLOR: '  Auto ' })).toBe('auto');
    expect(readKbColorMode({ KB_COLOR: 'yes' })).toBeUndefined();
    expect(readKbColorMode({ KB_COLOR: '' })).toBeUndefined();
    expect(readKbColorMode({})).toBeUndefined();
  });
});

describe('resolveColorEnabled precedence matrix', () => {
  it('default auto colorizes only on a TTY', () => {
    expect(resolveColorEnabled({ env: {}, isTTY: true })).toBe(true);
    expect(resolveColorEnabled({ env: {}, isTTY: false })).toBe(false);
  });

  it('honors NO_COLOR even on a TTY', () => {
    expect(resolveColorEnabled({ env: { NO_COLOR: '1' }, isTTY: true })).toBe(false);
  });

  it('--color=always forces color through a pipe and over NO_COLOR', () => {
    expect(resolveColorEnabled({ flag: 'always', env: {}, isTTY: false })).toBe(true);
    expect(resolveColorEnabled({ flag: 'always', env: { NO_COLOR: '1' }, isTTY: false })).toBe(true);
  });

  it('--color=never overrides a TTY', () => {
    expect(resolveColorEnabled({ flag: 'never', env: {}, isTTY: true })).toBe(false);
  });

  it('--color=auto auto-detects and still honors NO_COLOR (skips KB_COLOR)', () => {
    expect(resolveColorEnabled({ flag: 'auto', env: {}, isTTY: true })).toBe(true);
    expect(resolveColorEnabled({ flag: 'auto', env: { NO_COLOR: '1' }, isTTY: true })).toBe(false);
    // explicit --color=auto bypasses the KB_COLOR default
    expect(resolveColorEnabled({ flag: 'auto', env: { KB_COLOR: 'always' }, isTTY: false })).toBe(false);
  });

  it('KB_COLOR acts as an env-level default below the flag and NO_COLOR', () => {
    expect(resolveColorEnabled({ env: { KB_COLOR: 'always' }, isTTY: false })).toBe(true);
    expect(resolveColorEnabled({ env: { KB_COLOR: 'never' }, isTTY: true })).toBe(false);
    // NO_COLOR beats the KB_COLOR default
    expect(resolveColorEnabled({ env: { KB_COLOR: 'always', NO_COLOR: '1' }, isTTY: false })).toBe(false);
    // an explicit flag beats KB_COLOR
    expect(resolveColorEnabled({ flag: 'never', env: { KB_COLOR: 'always' }, isTTY: true })).toBe(false);
  });

  it('exposes the shared ANSI bold codes', () => {
    expect(ANSI_BOLD).toBe('\x1b[1m');
    expect(ANSI_BOLD_OFF).toBe('\x1b[22m');
  });
});

describe('shouldHighlightSearchOutput routes through the unified color control', () => {
  it('only highlights markdown', () => {
    expect(
      shouldHighlightSearchOutput({ format: 'json', highlight: 'auto' }, {}, true),
    ).toBe(false);
    expect(
      shouldHighlightSearchOutput({ format: 'md', highlight: 'auto' }, {}, true),
    ).toBe(true);
  });

  it('treats --highlight=never as a hard off switch', () => {
    expect(
      shouldHighlightSearchOutput({ format: 'md', highlight: 'never' }, {}, true),
    ).toBe(false);
  });

  it('suppresses on NO_COLOR by default and lets --color=always override it', () => {
    expect(
      shouldHighlightSearchOutput({ format: 'md', highlight: 'auto' }, { NO_COLOR: '1' }, true),
    ).toBe(false);
    expect(
      shouldHighlightSearchOutput(
        { format: 'md', highlight: 'auto', color: 'always', colorExplicit: true },
        { NO_COLOR: '1' },
        false,
      ),
    ).toBe(true);
  });

  it('lets --color=never override a TTY and the legacy --highlight=always', () => {
    expect(
      shouldHighlightSearchOutput(
        { format: 'md', highlight: 'always', color: 'never', colorExplicit: true },
        {},
        true,
      ),
    ).toBe(false);
  });

  it('honors KB_COLOR when neither --color nor --highlight is set', () => {
    expect(
      shouldHighlightSearchOutput({ format: 'md', highlight: 'auto' }, { KB_COLOR: 'always' }, false),
    ).toBe(true);
    expect(
      shouldHighlightSearchOutput({ format: 'md', highlight: 'auto' }, { KB_COLOR: 'never' }, true),
    ).toBe(false);
  });

  it('keeps the legacy --highlight=always force-through-pipe behavior', () => {
    expect(
      shouldHighlightSearchOutput({ format: 'md', highlight: 'always' }, {}, false),
    ).toBe(true);
  });
});
