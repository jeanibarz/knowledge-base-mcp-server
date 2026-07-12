# Query Embedding Cache

Use this runbook when `kb search`, MCP `retrieve_knowledge`, or `kb_stats`
shows query-cache behavior that needs an operator decision: repeated misses,
unexpected bypasses, growing disk use, or a need to clear cached query vectors
after provider/model troubleshooting. `kb related` and `kb compare` can bypass
query cache with `--no-cache`, but they do not expose the same per-request
`query_cache` JSON fields as `kb search`.

The cache stores query embeddings only. It does not store result chunks, raw
query text, or KB source content. It is keyed by embedding model id plus a
normalized query string, then persisted as a hash-named vector file under the
FAISS index directory.

Implementation anchors: `src/query-cache.ts::QueryEmbeddingCache`,
`src/query-cache.ts::queryCachePaths`, and
`src/config/cache.ts::resolveQueryCacheDiskMaxBytes`.

## Quick Reference

| Task | Command or setting | Notes |
| --- | --- | --- |
| See per-request cache state | `kb search "query" --format=json --timing` | Inspect `query_cache` and `timing.query_cache*`. |
| See runtime counters | `kb stats --format=json` | Inspect `.query_cache` for this process' hits, misses, bypasses, and corruptions; disk bytes are read from the cache directory. |
| Trace a request later | `KB_LOG_FORMAT=both LOG_FILE=/tmp/kb.log kb search "query"` | Read with `kb logs show --request-id=<id> --format=json`. |
| Bypass one CLI search | `kb search "query" --no-cache` | Also supported by `kb related` and `kb compare`. |
| Disable for a process | `KB_QUERY_CACHE=off kb search "query"` | Use for provider debugging or one-shot correctness probes. |
| Tune memory entries | `KB_QUERY_CACHE_LRU_MAX=512 ...` | Default is `256`; `0` disables the in-process L1. |
| Tune disk budget | `KB_QUERY_CACHE_DISK_MAX_MB=128 ...` | Default is `64`; pruning runs after cache writes. |

## Interpret Status

Operator-facing JSON and canonical logs use `query_cache.outcome`:

| Outcome | Meaning | Usual action |
| --- | --- | --- |
| `memory_hit` | The current process reused its in-memory L1 entry. | No action. This is the fastest path. |
| `disk_hit` | The process loaded a persisted query vector and promoted it into L1. | No action. Expect the next same-process request to become `memory_hit`. |
| `miss` | No usable cache entry existed, so the embedding provider was called and a disk write was attempted. | Normal for first use, new model ids, or after clearing cache. Investigate only if every repeated query misses. |
| `bypass` | The cache was enabled, but this call asked not to use it. | Check `--no-cache` or MCP `no_cache` input. |
| `disabled` | `KB_QUERY_CACHE` disabled the cache for the process. | Remove or change the env var when warm-query latency matters. |

Some low-level timing objects may expose lookup labels from the vector-search
adapter: `hit_l1`, `hit_disk`, `miss`, `bypass`, `disabled`, or `unavailable`.
For runbook decisions, prefer the stable `query_cache.outcome` values above.

Example dense JSON shape:

```json
{
  "query_cache": {
    "enabled": true,
    "outcome": "disk_hit",
    "model_id": "ollama__nomic-embed-text-latest",
    "elapsed_ms": 2
  },
  "timing": {
    "query_cache": "disk_hit",
    "query_cache_enabled": true,
    "query_cache_model_id": "ollama__nomic-embed-text-latest",
    "query_cache_elapsed_ms": 2
  }
}
```

See [CLI JSON contracts](../cli-json-contracts.md#kb-search) and
[Logs reader](logs-reader.md) for the stable wire fields.

## Disk Layout

By default the root is:

```text
${KNOWLEDGE_BASES_ROOT_DIR:-$HOME/knowledge_bases}/.faiss/cache/queries/<model_id>/
```

If `FAISS_INDEX_PATH` is set, replace the `.faiss` prefix with that value:

```text
$FAISS_INDEX_PATH/cache/queries/<model_id>/
```

Each cached query has two files:

```text
<sha>.f32        # little-endian float32 vector
<sha>.meta.json  # schema version, model id, dimension, creation time, vector checksum
```

The hash includes the cache schema version, model id, and normalized query.
Normalization trims, NFKC-normalizes, and collapses whitespace, but preserves
case. Because the query text is not written to disk, operators should use
`query_sha256` from canonical logs when correlating repeated requests.

## Disk-Budget Tuning

`KB_QUERY_CACHE_DISK_MAX_MB` caps query-vector files per index path. The default
is `64`. Budget enforcement happens after a successful cache write:

1. The process lists `.f32` vector files under `cache/queries`.
2. If total vector bytes exceed the budget, it deletes the oldest vector files
   by mtime.
3. It also deletes the matching `.meta.json` sidecar for each pruned vector.

Set a higher budget when warm queries are valuable and the active model has
large vectors or many repeated workflows:

```bash
KB_QUERY_CACHE_DISK_MAX_MB=256 kb search "incident response" --format=json
```

Set a lower budget for constrained machines:

```bash
KB_QUERY_CACHE_DISK_MAX_MB=16 kb search "incident response" --format=json
```

A very low budget can cause more repeated-query `miss` outcomes because older
entries are pruned as new queries arrive. There is no background compactor; run
a representative query after changing the budget if you want pruning to happen
immediately.

## Bypass Or Disable

Use bypass when comparing provider behavior with and without cached query
vectors:

```bash
kb search "provider timeout recovery" --no-cache --format=json --timing
kb compare "provider timeout recovery" old_model_id new_model_id --no-cache
```

Use process-level disablement when every call in a shell or service should call
the provider directly:

```bash
KB_QUERY_CACHE=off kb search "provider timeout recovery" --format=json --timing
```

For long-lived MCP servers or `kb serve`, restart the process after changing
`KB_QUERY_CACHE`, `KB_QUERY_CACHE_LRU_MAX`, or `KB_QUERY_CACHE_DISK_MAX_MB`.
Those values are read when the process loads configuration.

## Clear Cache Entries

Clearing disk entries is safe while no writer is active, but it does not clear
the in-memory L1 cache inside already-running processes. Restart long-lived
MCP servers or `kb serve` when you need a hard guarantee that the next request
calls the embedding provider.

To clear one model id:

```bash
FAISS_ROOT="${FAISS_INDEX_PATH:-${KNOWLEDGE_BASES_ROOT_DIR:-$HOME/knowledge_bases}/.faiss}"
MODEL_ID="ollama__nomic-embed-text-latest"
QUERY_CACHE_DIR="$FAISS_ROOT/cache/queries/$MODEL_ID"

find "$QUERY_CACHE_DIR" -maxdepth 1 -type f \
  \( -name '*.f32' -o -name '*.meta.json' \) -print

find "$QUERY_CACHE_DIR" -maxdepth 1 -type f \
  \( -name '*.f32' -o -name '*.meta.json' \) -delete
```

To clear every query-cache model directory under the active index path:

```bash
FAISS_ROOT="${FAISS_INDEX_PATH:-${KNOWLEDGE_BASES_ROOT_DIR:-$HOME/knowledge_bases}/.faiss}"
find "$FAISS_ROOT/cache/queries" -type f \
  \( -name '*.f32' -o -name '*.meta.json' \) -print
find "$FAISS_ROOT/cache/queries" -type f \
  \( -name '*.f32' -o -name '*.meta.json' \) -delete
```

Do not delete `${FAISS_ROOT}/models` when clearing query cache; that removes
registered indexes, not query-vector cache entries.

## Troubleshoot

**Every repeated query is `miss`.**

Confirm the same model id and query shape are being used:

```bash
kb search "known phrase" --format=json --timing | jq '.query_cache, .timing'
kb models list
```

If `model_id` changes between calls, inspect `KB_ACTIVE_MODEL`, `--model`, and
the active model file. If the query text changes only in whitespace, it should
still hit after normalization; case changes can produce different keys.

**Outcome is `bypass`.**

Look for `--no-cache` on CLI calls, `no_cache` in batch JSONL input, or an MCP
client that sets its no-cache option for diagnostic requests.

**Outcome is `disabled`.**

Check the environment inherited by the process:

```bash
env | grep '^KB_QUERY_CACHE='
```

Values such as `off`, `false`, `0`, and `disabled` turn the cache off.

**Corruption counters increase.**

`kb stats --format=json` reports query-cache corruption count. A corrupt entry
that fails parsing or validation is deleted and treated as a miss, so the next
successful request should rewrite it. A transient read I/O failure such as
`EACCES` or `EIO` is instead a miss that is not counted as corruption: the
entry is retained for a later retry. Repeated corruption usually means a
filesystem or permission problem under `$FAISS_INDEX_PATH/cache/queries`;
capture `kb stats
--format=json`, `kb doctor --format=json`, and the relevant canonical log line
before filing a bug.

**Disk budget does not shrink immediately.**

Pruning runs after cache writes, not on a timer. Run one representative cached
query with the new `KB_QUERY_CACHE_DISK_MAX_MB` value, then re-check:

```bash
KB_QUERY_CACHE_DISK_MAX_MB=32 kb search "known phrase" --format=json >/dev/null
kb stats --format=json | jq '.query_cache.disk_size_bytes'
```

## Related

- [ADR 0009: Query Embedding Cache](../architecture/adr/0009-query-embedding-cache.md)
- [Feature flags and defaults](../feature-flags.md#retrieval-and-answering)
- [Metrics export](metrics-export.md)
- [Switching embedding models](switching-embedding-models.md)
