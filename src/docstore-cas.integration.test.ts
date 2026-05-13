// RFC 016 / issue #286 — end-to-end dedup against real langchain FaissStore.
//
// The unit tests in `docstore-cas.test.ts` cover the canonicalization and
// CAS logic in isolation by hand-rolling `docstore.json` tuples. That misses
// the part the issue specifically calls out: that an *actual* FaissStore.save
// over the same chunks produces a byte-identical canonicalized payload
// across embedding models.
//
// This test pairs the real `@langchain/community/vectorstores/faiss` with
// the repo's `FakeEmbeddings` provider (issue #204) and drives the same
// `saveFaissStoreAtomic` codepath the production manager uses.

import { Document } from '@langchain/core/documents';
import { FaissStore } from '@langchain/community/vectorstores/faiss';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { casRootForIndexPath, resetDedupDisabledForTests } from './docstore-cas.js';
import { FakeEmbeddings } from './embedding-provider.js';
import { saveFaissStoreAtomic } from './faiss-store-layout.js';

const FAKE_EMBEDDINGS = new FakeEmbeddings({ dim: 16 });

beforeEach(() => {
  resetDedupDisabledForTests();
});

async function buildStoreFromChunks(docs: Document[]): Promise<FaissStore> {
  return FaissStore.fromTexts(
    docs.map((d) => d.pageContent),
    docs.map((d) => d.metadata),
    FAKE_EMBEDDINGS,
  );
}

async function mkTmp(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('RFC 016 — real FaissStore docstore dedup across models (issue #286 acceptance)', () => {
  it('two models indexing the same chunks land on the same docstore inode', async () => {
    const root = await mkTmp('kb-cas-integration-');
    try {
      const casRoot = casRootForIndexPath(root);
      const modelA = path.join(root, 'models', 'fake__model-a');
      const modelB = path.join(root, 'models', 'fake__model-b');
      await fsp.mkdir(modelA, { recursive: true });
      await fsp.mkdir(modelB, { recursive: true });

      // The chunker emits identical (pageContent, metadata) for the same KB
      // regardless of the embedding model — see file-ingest.ts:99-110.
      const sharedChunks: Document[] = [
        new Document({
          pageContent: 'first chunk of file a',
          metadata: { source: '/kb/a.md', knowledgeBase: 'kb', chunkIndex: 0, extension: '.md' },
        }),
        new Document({
          pageContent: 'second chunk of file a',
          metadata: { source: '/kb/a.md', knowledgeBase: 'kb', chunkIndex: 1, extension: '.md' },
        }),
        new Document({
          pageContent: 'first chunk of file b',
          metadata: { source: '/kb/b.md', knowledgeBase: 'kb', chunkIndex: 0, extension: '.md' },
        }),
      ];

      const storeA = await buildStoreFromChunks(sharedChunks);
      const storeB = await buildStoreFromChunks(sharedChunks);

      await saveFaissStoreAtomic({
        store: storeA,
        modelDir: modelA,
        modelId: 'fake__model-a',
        swapCounter: 1,
        casRoot,
      });
      await saveFaissStoreAtomic({
        store: storeB,
        modelDir: modelB,
        modelId: 'fake__model-b',
        swapCounter: 1,
        casRoot,
      });

      const docstoreA = path.join(modelA, 'index.v0', 'docstore.json');
      const docstoreB = path.join(modelB, 'index.v0', 'docstore.json');
      const statA = await fsp.stat(docstoreA);
      const statB = await fsp.stat(docstoreB);

      expect(statA.ino).toBe(statB.ino);
      // Two hardlink references (one per model) + the CAS entry = 3.
      expect(statA.nlink).toBe(3);

      // CAS holds exactly one payload for the shared content (plus the
      // process lockfile, which is gated by the .lock filename suffix).
      const casEntries = (await fsp.readdir(casRoot)).filter((e) => e.endsWith('.json'));
      expect(casEntries).toHaveLength(1);

      // Faiss binaries stay distinct (intentionally).
      const faissA = await fsp.stat(path.join(modelA, 'index.v0', 'faiss.index'));
      const faissB = await fsp.stat(path.join(modelB, 'index.v0', 'faiss.index'));
      expect(faissA.ino).not.toBe(faissB.ino);

      // Round-trip: each model can still load its store independently and
      // see the same chunks. This protects against a bug where the rewritten
      // UUIDs in docstore.json fall out of sync with the FAISS internal mapping.
      const reloadedA = await FaissStore.load(
        path.join(modelA, 'index.v0'),
        FAKE_EMBEDDINGS,
      );
      const reloadedB = await FaissStore.load(
        path.join(modelB, 'index.v0'),
        FAKE_EMBEDDINGS,
      );
      const hitsA = await reloadedA.similaritySearchWithScore('first chunk of file a', 1);
      const hitsB = await reloadedB.similaritySearchWithScore('first chunk of file a', 1);
      expect(hitsA[0]?.[0].pageContent).toBe('first chunk of file a');
      expect(hitsB[0]?.[0].pageContent).toBe('first chunk of file a');
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('orphan CAS payloads get reclaimed by gc once their last model retires', async () => {
    const root = await mkTmp('kb-cas-integration-gc-');
    try {
      const casRoot = casRootForIndexPath(root);
      const modelDirPath = path.join(root, 'models', 'fake__model');
      await fsp.mkdir(modelDirPath, { recursive: true });

      const chunks: Document[] = [
        new Document({
          pageContent: 'gc-target chunk',
          metadata: { source: '/kb/a.md', knowledgeBase: 'kb', chunkIndex: 0 },
        }),
      ];
      const store = await buildStoreFromChunks(chunks);
      await saveFaissStoreAtomic({
        store,
        modelDir: modelDirPath,
        modelId: 'fake__model',
        swapCounter: 1,
        casRoot,
      });

      let casEntries = (await fsp.readdir(casRoot)).filter((e) => e.endsWith('.json'));
      expect(casEntries).toHaveLength(1);

      // Simulate the only model retiring: drop its versioned dir entirely.
      // The CAS payload's hardlink count goes from 2 → 1 → orphan.
      await fsp.rm(path.join(modelDirPath, 'index.v0'), { recursive: true, force: true });
      await fsp.rm(path.join(modelDirPath, 'index'), { force: true });

      // Trigger gc by performing an unrelated save through atomicSave (its
      // post-prune hook calls gcDocstoreCas). Use a different chunk so the
      // CAS payload from the first save can't be re-linked.
      const otherChunks: Document[] = [
        new Document({
          pageContent: 'replacement chunk',
          metadata: { source: '/kb/c.md', knowledgeBase: 'kb', chunkIndex: 0 },
        }),
      ];
      const store2 = await buildStoreFromChunks(otherChunks);
      await saveFaissStoreAtomic({
        store: store2,
        modelDir: modelDirPath,
        modelId: 'fake__model',
        swapCounter: 2,
        casRoot,
      });

      casEntries = (await fsp.readdir(casRoot)).filter((e) => e.endsWith('.json'));
      // After gc the orphan from save #1 is gone; only the live payload
      // from save #2 (linked from index.v1) remains.
      expect(casEntries).toHaveLength(1);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
