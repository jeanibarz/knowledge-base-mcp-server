// Issue #406 — `kb reindex --kb` is a guard/estimator hint, not a scoped
// rebuild. The M0b runner delegates to `updateIndex(undefined, { force:
// true })`, which always rebuilds the whole single-index-per-model FAISS
// index. These tests pin the help text so it cannot drift back to the
// earlier wording that implied `--kb` limits which vectors are rebuilt.

import { describe, expect, it } from '@jest/globals';
import { REINDEX_HELP } from './cli-reindex.js';

describe('REINDEX_HELP — --kb scope accuracy (issue #406)', () => {
  it('does not claim --kb limits or scopes the rebuild', () => {
    // The pre-#406 wording was "Limit reindex to this KB" / "Reindex
    // only this KB" — both overstate what --kb does.
    expect(REINDEX_HELP).not.toMatch(/Limit reindex to this KB/i);
    expect(REINDEX_HELP).not.toMatch(/Reindex only this KB/i);
  });

  it('describes --kb as a guard/estimator hint, not a scoped rebuild', () => {
    expect(REINDEX_HELP).toMatch(/--kb/);
    expect(REINDEX_HELP).toMatch(/guard\/estimator hint/i);
    expect(REINDEX_HELP).toMatch(/NOT a scoped\s+rebuild/i);
  });

  it('states the rebuild is always global regardless of --kb', () => {
    expect(REINDEX_HELP).toMatch(/always\s+global/i);
    expect(REINDEX_HELP).toMatch(/entire FAISS index/i);
  });
});
