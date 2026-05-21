# FAISS Index Quantization

The default FAISS index type is `flat`, which preserves the existing exact
IndexFlatL2 behavior. `sq8` is an opt-in scalar-quantized index for corpora
where vector memory is the bottleneck and a small recall trade-off is
acceptable.

## Enable SQ8

For a new model, use either the environment default:

```bash
KB_INDEX_TYPE=sq8 kb models add ollama nomic-embed-text --yes
```

or an explicit per-model registration flag:

```bash
kb models add ollama nomic-embed-text --index-type=sq8 --yes
```

Existing models keep their current index until rebuilt. To change an existing
model, remove and re-add it or build a fresh model id, then run the same
retrieval evaluation fixture against the flat and SQ8 versions before making it
active.

## Verify

```bash
kb stats
kb stats --format=json
```

The stats payload exposes `embedding.index_type`; markdown output prints
`Index type: flat` or `Index type: sq8`.

Use `kb eval` on the same fixture before and after SQ8. Promote only if the
Recall@K delta is acceptable for the shelf. SQ8 is most appropriate for large,
memory-bound corpora; keep `flat` for small corpora or recall-sensitive
retrieval.
