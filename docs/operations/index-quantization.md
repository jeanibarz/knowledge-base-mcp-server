# FAISS Index Quantization

`KB_INDEX_TYPE` controls the FAISS index created for a rebuilt model index.

| Value | Behavior | Trade-off |
| --- | --- | --- |
| `flat` | Full-precision `IndexFlatL2` storage. This is the default and preserves existing behavior. | Highest memory use, exact search. |
| `sq8` | Scalar-quantized 8-bit FAISS index created with the `SQ8` factory descriptor. | Lower vector memory, approximate distances. Validate recall before promoting. |

The setting is read when `FaissIndexManager` is constructed and applies to the
next index build. To convert an existing flat index to SQ8, run a forced global
rebuild with the env var set:

```bash
KB_INDEX_TYPE=sq8 kb reindex --force
kb stats
```

`kb stats` reports the active model's `embedding.index_type`, and the markdown
view prints `Index type: flat|sq8`. Each versioned index directory also records
the type in `integrity.json` as `index_type`, so retained versions remain
self-describing.

Before keeping SQ8 enabled for a corpus, compare it against the flat baseline:

```bash
KB_INDEX_TYPE=flat kb reindex --force
kb eval --mode=dense docs/testing/fixtures/dogfood-frozen-core.yml

KB_INDEX_TYPE=sq8 kb reindex --force
kb eval --mode=dense docs/testing/fixtures/dogfood-frozen-core.yml
```

Promote SQ8 only when the Recall@K / MRR delta is acceptable for the target
knowledge bases. Leave `KB_INDEX_TYPE` unset to return to `flat` on the next
forced rebuild.
