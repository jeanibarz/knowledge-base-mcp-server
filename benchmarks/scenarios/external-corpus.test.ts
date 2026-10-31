import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { readIndexedCounts } from './external-corpus.js';

// Mirrors the shape FaissIndexManager.persistIndexUpdateSummary() writes:
// <faissIndexPath>/models/<modelId>/last-index-update.json
//   { schema_version, summary: { files_scanned, chunks_added, ... } }
async function writeManifest(
  faissIndexPath: string,
  modelId: string,
  summary: { files_scanned?: number; chunks_added?: number } | null,
): Promise<void> {
  const modelDir = path.join(faissIndexPath, 'models', modelId);
  await fsp.mkdir(modelDir, { recursive: true });
  const payload =
    summary === null
      ? { schema_version: 'kb.last-index-update.v1' }
      : { schema_version: 'kb.last-index-update.v1', summary };
  await fsp.writeFile(path.join(modelDir, 'last-index-update.json'), JSON.stringify(payload), 'utf-8');
}

describe('readIndexedCounts', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'bench-indexed-counts-'));
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('sums files_scanned and chunks_added from a single model manifest', async () => {
    await writeManifest(tmp, 'ollama__nomic-embed-text', { files_scanned: 547, chunks_added: 3678 });
    await expect(readIndexedCounts(tmp)).resolves.toEqual({ files: 547, chunks: 3678 });
  });

  it('sums across multiple model directories (multi-model tree)', async () => {
    await writeManifest(tmp, 'modelA', { files_scanned: 10, chunks_added: 100 });
    await writeManifest(tmp, 'modelB', { files_scanned: 5, chunks_added: 42 });
    await expect(readIndexedCounts(tmp)).resolves.toEqual({ files: 15, chunks: 142 });
  });

  it('returns zero counts when the models directory is absent (indexing never ran)', async () => {
    await expect(readIndexedCounts(tmp)).resolves.toEqual({ files: 0, chunks: 0 });
  });

  it('treats a missing summary or missing numeric field as zero rather than NaN', async () => {
    await writeManifest(tmp, 'modelNoSummary', null);
    await writeManifest(tmp, 'modelPartial', { files_scanned: 3 }); // chunks_added absent
    await expect(readIndexedCounts(tmp)).resolves.toEqual({ files: 3, chunks: 0 });
  });

  it('skips an unreadable/malformed manifest without throwing, still summing the rest', async () => {
    const badDir = path.join(tmp, 'models', 'badModel');
    await fsp.mkdir(badDir, { recursive: true });
    await fsp.writeFile(path.join(badDir, 'last-index-update.json'), '{not json', 'utf-8');
    await writeManifest(tmp, 'goodModel', { files_scanned: 7, chunks_added: 70 });
    await expect(readIndexedCounts(tmp)).resolves.toEqual({ files: 7, chunks: 70 });
  });

  it('skips a model directory that has no manifest file at all', async () => {
    await fsp.mkdir(path.join(tmp, 'models', 'emptyModel'), { recursive: true });
    await writeManifest(tmp, 'goodModel', { files_scanned: 2, chunks_added: 9 });
    await expect(readIndexedCounts(tmp)).resolves.toEqual({ files: 2, chunks: 9 });
  });
});
