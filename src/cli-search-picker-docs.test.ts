import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

import { SEARCH_HELP } from './cli-search.js';
import { helpBodyLines } from './cli-search-picker.js';

// The interactive-picker keymap is authored once, in the picker's own
// helpBodyLines() (what the picker shows when you press `?`). Issue #1131 asked
// us to document that keymap in the README and the CLI help without letting the
// copies drift from the code. These gates fail if any copy falls out of sync.
//
// Both files resolve from process.cwd() (the repo root under Jest), matching the
// other committed-doc drift gates in this suite (see error-codes-doc.test.ts).
function readRepoFile(relPath: string): string {
  // Normalize CRLF so the verbatim-block gate does not fail spuriously on a
  // Windows checkout with core.autocrlf=true.
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf8').replace(/\r\n/g, '\n');
}

describe('interactive search picker keymap docs drift gate (issue #1131)', () => {
  it('helpBodyLines() still leads with the Keys: label the docs assume', () => {
    // Both doc gates below drop element 0 as the label; if the label moves or
    // disappears, slice(1) would silently omit a real binding from the help gate.
    const lines = helpBodyLines();
    expect(lines[0]).toBe('Keys:');
    expect(lines.slice(1).length).toBeGreaterThan(0);
  });

  it('the README embeds the picker keymap verbatim from helpBodyLines()', () => {
    const readme = readRepoFile('README.md');
    const keymapBlock = helpBodyLines().join('\n');
    expect(readme).toContain(keymapBlock);
  });

  it('the search --help text lists every picker binding from helpBodyLines()', () => {
    // helpBodyLines()[0] is the 'Keys:' label; the help renders the bindings
    // under its own section heading, so only the binding lines must appear.
    const bindings = helpBodyLines().slice(1).join('\n');
    expect(SEARCH_HELP).toContain(bindings);
    expect(SEARCH_HELP).toContain('Interactive picker keys');
  });

  it('every picker binding line is a single key/description pair', () => {
    // Guards against a binding line losing its description (which would make the
    // README/help block ambiguous) while still matching the verbatim-block gate.
    for (const line of helpBodyLines().slice(1)) {
      expect(line).toMatch(/^ {2}\S.*\s{2,}\S/);
    }
  });
});
