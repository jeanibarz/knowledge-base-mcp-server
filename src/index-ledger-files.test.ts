import * as fsp from 'fs/promises';
import * as path from 'path';
import { FEEDBACK_LEDGER_FILENAME } from './feedback-ledger.js';
import {
  KNOWN_INDEX_LEDGER_FILES,
  purgeIndexDirPreservingLedgers,
} from './index-ledger-files.js';
import { INGEST_QUARANTINE_FILENAME } from './ingest-quarantine.js';
import { makeTempDir } from './test-support/tempdir.js';

describe('index-ledger-files (#1190)', () => {
  it('lists exactly the feedback and quarantine ledger basenames', () => {
    expect([...KNOWN_INDEX_LEDGER_FILES].sort()).toEqual(
      [FEEDBACK_LEDGER_FILENAME, INGEST_QUARANTINE_FILENAME].sort(),
    );
  });

  it('purge keeps top-level ledgers byte-for-byte and removes derived sidecars', async () => {
    const root = await makeTempDir('kb-ledger-purge-');
    try {
      const indexDir = path.join(root, '.index');
      await fsp.mkdir(path.join(indexDir, 'sub'), { recursive: true });
      const feedback = '{"q":"a","judgment":"relevant"}\n{"q":"b"}\n';
      const quarantine = '{"file":"bad.md","attempts":2}\n';
      await fsp.writeFile(path.join(indexDir, FEEDBACK_LEDGER_FILENAME), feedback);
      await fsp.writeFile(path.join(indexDir, INGEST_QUARANTINE_FILENAME), quarantine);
      await fsp.writeFile(path.join(indexDir, 'doc.md'), 'hash-sidecar');
      await fsp.writeFile(path.join(indexDir, 'sub', 'nested.md'), 'hash-sidecar');
      // A ledger basename below the top level mirrors a KB file and is derived.
      await fsp.writeFile(path.join(indexDir, 'sub', FEEDBACK_LEDGER_FILENAME), 'nested');

      await purgeIndexDirPreservingLedgers(indexDir);

      expect((await fsp.readdir(indexDir)).sort()).toEqual(
        [FEEDBACK_LEDGER_FILENAME, INGEST_QUARANTINE_FILENAME].sort(),
      );
      expect(await fsp.readFile(path.join(indexDir, FEEDBACK_LEDGER_FILENAME), 'utf-8')).toBe(feedback);
      expect(await fsp.readFile(path.join(indexDir, INGEST_QUARANTINE_FILENAME), 'utf-8')).toBe(quarantine);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('purge of a directory without ledgers removes it', async () => {
    const root = await makeTempDir('kb-ledger-purge-');
    try {
      const indexDir = path.join(root, '.index');
      await fsp.mkdir(indexDir);
      await fsp.writeFile(path.join(indexDir, 'doc.md'), 'x');
      await purgeIndexDirPreservingLedgers(indexDir);
      await expect(fsp.stat(indexDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
