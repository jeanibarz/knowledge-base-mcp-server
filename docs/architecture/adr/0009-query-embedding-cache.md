# ADR 0009: Query Embedding Cache

## Status

Accepted.

## Context

`retrieve_knowledge` and `kb search` embed the query before FAISS lookup. For
warm queries on small indexes, the provider call can dominate total latency and
can incur paid-provider cost. The CLI and MCP server share `$FAISS_INDEX_PATH`,
so a cache warmed by one process should be reusable by the other.

## Decision

Add a two-tier query-embedding cache keyed by:

```text
sha256("kb-query-cache.v1" + 0x1f + model_id + 0x1f + normalized_query)
```

`normalized_query` is NFKC, trimmed, and whitespace-collapsed. It remains
case-preserving because not every embedding model is case-insensitive. The key
does not include KB content state: the query vector is a function of model and
query, while corpus changes affect only the FAISS candidate set.

Tier 1 is an in-process LRU with `KB_QUERY_CACHE_LRU_MAX` defaulting to 256.
Tier 2 stores vectors under
`$FAISS_INDEX_PATH/cache/queries/<model_id>/<sha>.f32` with a
`<sha>.meta.json` sidecar. Writes use a model-cache-directory lock plus
tmp-and-rename so readers do not consume partial files. Read I/O failures are
treated as misses without deleting entries; entries that are successfully read
but fail parsing, schema, checksum, or value validation are unlinked and
treated as misses.

Operators can bypass the cache with `KB_QUERY_CACHE=off`, `kb search
--no-cache`, and `kb compare --no-cache`.

## Consequences

Cache hits skip provider `embedQuery` calls but keep the FAISS query path
unchanged. Disk entries contain query-derived vectors, so they inherit the same
local trust boundary as the FAISS index directory. `kb_stats.query_cache`
reports process hit/miss counters and current disk size for observability.
