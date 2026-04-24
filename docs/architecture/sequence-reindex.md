# Sequence — model-change reindex

What happens when the user changes `EMBEDDING_PROVIDER`, `HUGGINGFACE_MODEL_NAME`, `OLLAMA_MODEL`, or `OPENAI_MODEL_NAME` with an existing index on disk. The triggering comparison is at `src/FaissIndexManager.ts:153`; the teardown at `:154-164`; the reconstruction at `src/FaissIndexManager.ts:302-346` on the next `updateIndex` call.

This is a **destructive** path — the old `faiss.index` is deleted, then rebuilt from source markdown using the new model. ADR [`0005-auto-rebuild-on-model-change.md`](./adr/0005-auto-rebuild-on-model-change.md) explains why the current code wipes rather than refuses, and why that choice is debatable.

## Diagram

```mermaid
sequenceDiagram
  autonumber
  participant Entry as index.ts:5
  participant Server as KnowledgeBaseServer
  participant FIM as FaissIndexManager
  participant Store as $FAISS_INDEX_PATH
  participant FS as $KNOWLEDGE_BASES_ROOT_DIR
  participant Provider as Embedding provider<br/>(NEW model)

  Note over Entry,Provider: User changed OLLAMA_MODEL<br/>and restarted the server
  Entry->>Server: new KnowledgeBaseServer().run()
  Server->>FIM: new FaissIndexManager()<br/>:86-131
  Note over FIM: constructor picks new model<br/>from config.ts env vars

  Server->>Server: McpServer.connect(stdio)<br/>:126-127
  Note over Server: MCP handshake completes<br/>BEFORE initialize() runs

  Server->>FIM: initialize()<br/>:133-194
  FIM->>Store: pathExists(FAISS_INDEX_PATH)<br/>:135
  FIM->>Store: readFile(model_name.txt)<br/>:146-148
  Store-->>FIM: "old-model-name"

  alt stored != current (MISMATCH)
    Note over FIM: warn: "Model name has changed..."<br/>:154
    FIM->>Store: unlink(faiss.index)<br/>:157
    Note over FIM: this.faissIndex = null<br/>:163
  end

  FIM->>Store: pathExists(faiss.index)
  Note over FIM,Store: file just deleted → branch at :174-177
  Note over FIM: faissIndex stays null

  FIM->>Store: writeFile(model_name.txt, NEW-model)<br/>:181
  Note over FIM: initialize() returns

  Note over Server,Provider: Time passes — first retrieve_knowledge request arrives

  Server->>FIM: updateIndex(kb?)<br/>:202-389
  loop for each file in each KB
    FIM->>FS: sha256 + read sidecar
    Note over FIM: sidecars still reflect OLD-model<br/>content (hash of source file, not embedding)
    Note over FIM: hashes match → NOT re-embedded<br/>via the changed-file branch
  end

  Note over FIM: indexMutated==false, faissIndex==null,<br/>anyFileProcessed==true → fallback branch
  rect rgba(255, 235, 200, 0.6)
    Note over FIM,Provider: Fallback rebuild from all files<br/>:302-346
    FIM->>FS: re-walk every KB (second pass)
    loop for each file
      FIM->>FS: readFile + split
    end
    FIM->>Provider: embedDocuments([...all chunks, new model])
    Provider-->>FIM: new vectors
    FIM->>Store: FaissStore.fromTexts(all)<br/>:338-343
  end
  FIM->>Store: faissIndex.save(faiss.index)<br/>:348-355
  par tmp+rename sidecars (unchanged hashes)
    FIM->>FS: overwrite sidecar (.tmp → rename)
  end
```

## Why the fallback runs

The sha256 sidecars are hashes of the **source file content**, not of the embedding — so changing the embedding model does **not** invalidate them (`src/utils.ts:6-11`). On the first call after a model change:

- Every file's hash matches its sidecar, so the changed-file branch at `src/FaissIndexManager.ts:250-293` is skipped.
- But `this.faissIndex` is still `null` (cleared by the model-change block at `:163`, not replaced by the `FaissStore.load` branch at `:166-177` because `faiss.index` no longer exists).
- The combination — "some files scanned AND `faissIndex === null`" — triggers the fallback at `src/FaissIndexManager.ts:302-346`, which unconditionally re-embeds every file.

That fallback is also what recovers from a user manually deleting `$FAISS_INDEX_PATH/faiss.index`.

## Cost

Proportional to `total_chunks × per_chunk_embedding_latency` plus one `save()`. RFC 007 §5.2 measured 10 761 ms for 100 files / 500 chunks against a 20 ms/chunk stub; real providers range from 50 to 200 ms/chunk — see [`qa-budgets.md`](./qa-budgets.md).

## Partial-model switch (e.g. wrong provider env)

If the user sets `EMBEDDING_PROVIDER=openai` but forgets `OPENAI_API_KEY`, construction throws at `src/FaissIndexManager.ts:100` before `initialize()` runs — so the on-disk index is **not** touched. Same for HuggingFace at `:112`. The `.faiss/` directory survives, and reverting the env on the next start restores the prior behaviour with no rebuild cost.
