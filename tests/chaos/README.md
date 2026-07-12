# Chaos Test Suite

This suite exercises deterministic ingest and search fault classes that are too
broad or too timing-sensitive for the default per-PR Jest run.

Run it locally with:

```bash
npm run test:chaos
```

The nightly workflow runs the suite on a small fixture KB and asserts each
fault's documented recovery contract:

| Scenario | Fault class | Recovery assertion |
| --- | --- | --- |
| save-complete interruption | process death after FAISS commit but before sidecar commit | `initialize()` replays the pending manifest and writes missing sidecars |
| disk-full during save | `ENOSPC` while saving the versioned FAISS directory | no active index symlink is published and retry can clear orphan staging |
| embedding timeout | provider timeout during `embedDocuments` | ingest summary fails in `indexing`, the file is quarantined, and canonical classification maps to provider recovery |
| malformed embedding response | provider returns the wrong vector count | ingest fails before persistence and quarantines the source file |
| contextual-preface timeout storm | repeated LLM timeout | per-file circuit breaker stops after five chunk-level timeouts and records failed sidecar entries |
| corrupt FAISS at search time | truncated active FAISS artifact | search returns a classified indexing failure rather than an uncaught throw |
| torn lexical JSON at search time | truncated per-KB BM25 index | lexical retrieval records a classified per-KB failure and continues with partial results |
| missing or short metadata sidecar | absent or truncated predicate-pushdown JSONL | dense retrieval falls back to post-filter overfetch and returns the matching document |

Keep this suite opt-in. New scenarios should prefer deterministic injection
points over wall-clock sleeps or real signals.
