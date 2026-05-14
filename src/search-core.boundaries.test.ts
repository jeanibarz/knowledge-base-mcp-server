// Issue #341 — pin the application-vs-CLI boundary that this refactor
// established. retrieval-eval and ingest-quarantine were importing from
// CLI command modules (`cli-search.ts`, `cli-search-errors.ts`) when the
// helpers they actually needed are command-independent.
//
// If a future change moves a CLI module to consume one of these or makes
// the inverse re-importation, this test fails before the change can land.

import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as path from 'path';

const SRC_DIR = path.resolve(__dirname);

async function readSource(rel: string): Promise<string> {
  return fsp.readFile(path.join(SRC_DIR, rel), 'utf-8');
}

describe('issue #341 module boundary: non-CLI consumers do not import CLI adapters', () => {
  it('retrieval-eval imports search policy from search-core, not cli-search', async () => {
    const src = await readSource('retrieval-eval.ts');
    expect(src).toMatch(/from ['"]\.\/search-core\.js['"]/);
    expect(src).not.toMatch(/from ['"]\.\/cli-search\.js['"]/);
  });

  it('ingest-quarantine imports error classification from search-errors-core, not cli-search-errors', async () => {
    const src = await readSource('ingest-quarantine.ts');
    expect(src).toMatch(/from ['"]\.\/search-errors-core\.js['"]/);
    expect(src).not.toMatch(/from ['"]\.\/cli-search-errors\.js['"]/);
  });

  it('cli-search-errors.ts is gone; the classifier lives in search-errors-core', async () => {
    await expect(
      fsp.stat(path.join(SRC_DIR, 'cli-search-errors.ts')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const core = await readSource('search-errors-core.ts');
    expect(core).toMatch(/export function classifyKbSearchError\b/);
  });

  it('cli-search no longer exports the relocated search-core symbols', async () => {
    const src = await readSource('cli-search.ts');
    for (const symbol of [
      'computeStaleness',
      'resolveAutoSearchMode',
      'formatAutoModeHeader',
      'computeAutoThreshold',
      'formatAutoThresholdHeader',
      'formatFreshnessFooter',
      'buildExplainEmptyDiagnostics',
      'formatExplainEmptyDiagnosticsMarkdown',
      'explainEmptyDiagnosticsToJson',
    ]) {
      // `import { computeStaleness, ... } from './search-core.js'` is still
      // allowed inside cli-search; what should NOT appear is a re-declaration
      // (`export function computeStaleness` etc.).
      expect(src).not.toMatch(new RegExp(`^export\\s+(?:async\\s+)?function\\s+${symbol}\\b`, 'm'));
    }
    // SearchMode / Staleness should also no longer be RE-declared in cli-search.
    expect(src).not.toMatch(/^export\s+type\s+SearchMode\b/m);
    expect(src).not.toMatch(/^export\s+interface\s+Staleness\b/m);
  });
});
