import * as fsp from 'fs/promises';
import * as path from 'path';
import { INGEST_QUARANTINE_FILENAME } from './ingest-quarantine.js';

/**
 * Basename of the `kb feedback` relevance ledger. Kept equal to
 * `FEEDBACK_LEDGER_FILENAME` in feedback-ledger.ts (a test pins the equality);
 * duplicated here so this leaf module does not import the eval stack.
 */
const FEEDBACK_LEDGER_BASENAME = 'relevance-feedback.jsonl';

/**
 * User-authored files that live at the top level of `<kb>/.index/` next to the
 * derived sidecars. They are state, not cache: a sidecar purge and
 * `kb verify`'s orphan check must both leave them alone.
 */
export const KNOWN_INDEX_LEDGER_FILES: ReadonlySet<string> = new Set([
  INGEST_QUARANTINE_FILENAME,
  FEEDBACK_LEDGER_BASENAME,
]);

/**
 * Remove everything under a KB's `.index/` directory except the top-level
 * ledger files. Sidecars mirror the KB tree below the top level, so a ledger
 * basename nested in a subdirectory is still derived data and is removed.
 * The directory itself is removed only when nothing is left.
 */
export async function purgeIndexDirPreservingLedgers(indexDir: string): Promise<void> {
  const entries = await fsp.readdir(indexDir);
  for (const entry of entries) {
    if (KNOWN_INDEX_LEDGER_FILES.has(entry)) continue;
    await fsp.rm(path.join(indexDir, entry), { recursive: true, force: true });
  }
  // With no ledger present the directory is empty; remove it as the old
  // whole-directory purge did. A concurrently created entry keeps it (ENOTEMPTY).
  try {
    await fsp.rmdir(indexDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') throw err;
  }
}
