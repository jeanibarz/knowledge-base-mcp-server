import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

import { KB_ERROR_CODES } from './errors.js';
import {
  ASK_CLI_ERROR_CODES,
  ERROR_CODES_REFERENCE_PATH,
  KB_ERROR_CODE_DOCS,
  renderErrorCodesMarkdown,
} from './error-codes-doc.js';

// The rendering is pure (it reads the in-source registries and does no I/O or
// build import), so the drift gate can be exercised directly — no `npm run
// build` required for this test.
function readCommittedDoc(): string {
  return fs.readFileSync(path.join(process.cwd(), ERROR_CODES_REFERENCE_PATH), 'utf8');
}

describe('docs/reference/error-codes.md drift gate', () => {
  it('the committed doc matches what the generator renders from the registry', () => {
    expect(renderErrorCodesMarkdown()).toBe(readCommittedDoc());
  });

  it('documents every KBErrorCode exactly once', () => {
    const documented = Object.keys(KB_ERROR_CODE_DOCS);
    expect(new Set(documented)).toEqual(new Set(KB_ERROR_CODES));
    expect(documented).toHaveLength(KB_ERROR_CODES.length);
    for (const code of KB_ERROR_CODES) {
      expect(renderErrorCodesMarkdown()).toContain(`| \`${code}\` |`);
    }
  });

  it('detects drift when a code remedy changes (the check would fail)', () => {
    const committed = readCommittedDoc();
    const mutated = {
      ...KB_ERROR_CODE_DOCS,
      INTERNAL: { ...KB_ERROR_CODE_DOCS.INTERNAL, remedy: 'Do something else entirely (drifted).' },
    };
    const rendered = renderErrorCodesMarkdown(mutated);
    expect(rendered).not.toBe(committed);
    expect(rendered).toContain('(drifted)');
  });

  it('detects drift when a new code is added', () => {
    const baseline = renderErrorCodesMarkdown();
    const mutated = {
      ...KB_ERROR_CODE_DOCS,
      BRAND_NEW_CODE: {
        meaning: 'A newly added failure mode.',
        cause: 'Something new.',
        remedy: 'Handle it.',
        transient: false,
      },
    };
    const rendered = renderErrorCodesMarkdown(mutated);
    expect(rendered).not.toBe(baseline);
    expect(rendered).toContain('`BRAND_NEW_CODE`');
  });

  it('renders the ask-local CLI codes table', () => {
    const markdown = renderErrorCodesMarkdown();
    for (const entry of ASK_CLI_ERROR_CODES) {
      expect(markdown).toContain(`<code>${entry.code}</code>`);
    }
  });
});
