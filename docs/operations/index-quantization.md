# Search Index Types

The default search index type is `flat`, which preserves exact FAISS
IndexFlatL2 behavior. `sq8` is an opt-in FAISS scalar-quantized index for
corpora where vector memory is the bottleneck and a small recall trade-off is
acceptable. `hnsw` is an opt-in HNSW backend for larger corpora where lower
query latency is worth approximate-nearest-neighbor tuning.

## Enable SQ8 or HNSW

For a new model, use either the environment default:

```bash
KB_INDEX_TYPE=sq8 kb models add ollama nomic-embed-text --yes
KB_INDEX_TYPE=hnsw kb models add ollama nomic-embed-text --yes
```

or an explicit per-model registration flag:

```bash
kb models add ollama nomic-embed-text --index-type=sq8 --yes
kb models add ollama nomic-embed-text --index-type=hnsw --yes
```

Existing models keep their current index until rebuilt. To change an existing
model, remove and re-add it or build a fresh model id, then run the same
retrieval evaluation fixture against the old and new index types before making
the new model active.

HNSW tuning is controlled by environment variables and recorded in
`index.vN/integrity.json`:

| Env var | Default | Meaning |
| --- | ---: | --- |
| `KB_HNSW_M` | `32` | Graph connectivity. |
| `KB_HNSW_EF_CONSTRUCTION` | `200` | Build-time candidate list size. Must be at least `KB_HNSW_M`. |
| `KB_HNSW_EF_SEARCH` | `100` | Query-time candidate list size, reapplied after every load. |
| `KB_HNSW_RANDOM_SEED` | `100` | Build seed recorded in the manifest. |

## Verify

```bash
kb stats
kb stats --format=json
```

The stats payload exposes `embedding.index_type`; markdown output prints
`Index type: flat`, `Index type: sq8`, or `Index type: hnsw`.

Use `kb eval` on the same fixture before and after SQ8. Promote only if the
Recall@K delta is acceptable for the shelf. SQ8 is most appropriate for large,
memory-bound corpora; keep `flat` for small corpora or recall-sensitive
retrieval.

## HNSW / ANN Status

HNSW is implemented as a dedicated `hnswlib-node` backend, not as an arbitrary
FAISS factory string. This follows ADR
[`0011-hnsw-binding-evaluation`](../architecture/adr/0011-hnsw-binding-evaluation.md):
status-quo `faiss-node` can encode `M` through descriptors such as
`HNSW32,SQ8`, but it exposes no `efConstruction` or `efSearch` setter. The
current backend stores `hnsw.index`, a project-owned JSON `docstore.json`, and
explicit HNSW parameters in the integrity manifest under each `index.vN/`.

HNSW is approximate. Promote it only after comparing recall, nDCG, latency, and
memory against `flat` or `sq8` on representative fixtures. Keep `flat` for small
corpora or recall-sensitive shelves where exact search latency is acceptable.
