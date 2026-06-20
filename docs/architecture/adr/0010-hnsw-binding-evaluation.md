# ADR 0010: HNSW Binding Evaluation

## Status

Accepted; hnswlib backend path implemented.

## Context

Issue #596 proposes an opt-in HNSW/ANN index factory for lower query latency on
large corpora. The current store builds through `faiss-node` and persists with
the versioned layout:

```text
$FAISS_INDEX_PATH/models/<model_id>/
  index -> index.vN
  index.vN/
    faiss.index
    docstore.json
    integrity.json
```

The feasibility risk is parameter control. FAISS HNSW defaults are
`efConstruction=40` and `efSearch=16`; only `M` is expressible through the
factory descriptor (`HNSW32`, `HNSW32,SQ8`, etc.). Production HNSW recall
tuning normally needs a higher build-time `efConstruction` and per-query
`efSearch`.

This ADR compares:

1. status-quo `faiss-node`;
2. `hnswlib-node`;
3. an upstream `faiss-node` accessor change.

Sources inspected on 2026-06-12:

- `faiss-node@0.5.1` npm metadata and tarball
  (`https://www.npmjs.com/package/faiss-node`,
  `https://github.com/ewfian/faiss-node`).
- `hnswlib-node@3.0.0` npm metadata and tarball
  (`https://www.npmjs.com/package/hnswlib-node`,
  `https://github.com/yoshoku/hnswlib-node`).
- FAISS upstream `IndexHNSW.h` and `impl/HNSW.h`
  (`https://github.com/facebookresearch/faiss`).
- Local repo layout in `src/faiss-store-layout.ts` and factory use in
  `src/faiss-store-adapter.ts`.

## Decision

Do not implement issue #596 as a simple `KB_INDEX_FACTORY=HNSW32,SQ8` knob on
top of status-quo `faiss-node`.

Recommended path for #596:

1. If keeping the current FAISS/LangChain persistence path is mandatory, make
   #596 depend on a `faiss-node` accessor spike first. The required surface is
   at least build-time `efConstruction` and query-time `efSearch` for
   `IndexHNSW` indexes, with round-trip tests through `Index.write/read`.
2. If accepting a new backend adapter is in scope, use `hnswlib-node` for HNSW
   instead of the generic FAISS factory. Persist it as a first-class alternate
   index file under `index.vN/`, record parameters in the manifest, and reapply
   `efSearch` after every load.
3. Keep `flat` and `sq8` as the default/recommended local-KB modes until #596
   has BEIR and local latency evidence showing the ANN trade-off is worth the
   added native binding and layout surface.

In short: **no-go for status-quo `faiss-node` HNSW factory work; conditional
go for either FAISS accessors or a dedicated `hnswlib-node` backend.**

## Current Implementation

The project has since taken the dedicated `hnswlib-node` backend path. The
implemented surface is `KB_INDEX_TYPE=hnsw` or
`kb models add --index-type=hnsw`, with tuning through `KB_HNSW_M`,
`KB_HNSW_EF_CONSTRUCTION`, `KB_HNSW_EF_SEARCH`, and
`KB_HNSW_RANDOM_SEED`.

The layout follows the recommendation in this ADR: HNSW stores
`index.vN/hnsw.index`, a project-owned JSON `docstore.json`, and HNSW
parameters in `integrity.json`; the loader reapplies `efSearch` after every
load. FAISS `flat` and `sq8` remain the default/recommended modes unless local
fixtures show the approximate HNSW trade-off is worthwhile for a shelf.

## Comparison

| Option | Parameter tunability | `index.vN` persistence fit | Maintenance risk | Recall implication |
| --- | --- | --- | --- | --- |
| `faiss-node` status quo | `Index.fromFactory(dims, descriptor, metric)` accepts HNSW descriptors, so `M` can be encoded (`HNSW32`). The typed/runtime surface exposes no `efSearch`, `efConstruction`, `ParameterSpace`, or `SearchParametersHNSW` setter. | Best fit. `FaissStore.save()` already writes `faiss.index` and `docstore.json`; `Index.write/read` round-trips factory-created HNSW indexes. | Medium-high. It is already a direct dependency, but latest npm release is `0.5.1` from 2023-10-15 and the wrapper source has a very small public API. | Frozen `efConstruction=40` and `efSearch=16` make recall a library default, not a repo policy. A deterministic local spike measured `HNSW32,SQ8` at recall@10 `0.9575` versus flat; there is no way to raise `efSearch` to recover recall without changing the binding. |
| `hnswlib-node` | Strong. `HierarchicalNSW.initIndex()` exposes `m`, `efConstruction`, `randomSeed`, and capacity; `setEf()`/`getEf()` expose query-time `ef`. | Feasible but not drop-in. It writes one native HNSW file (`writeIndexSync`/`readIndexSync`), not `faiss.index`, and bypasses `@langchain/community`'s `FaissStore`. A new adapter would need `index.vN/hnsw.index`, docstore parity checks, integrity-manifest changes, capacity/resize policy, and loader branching by backend. | Medium. Latest npm release is `3.0.0` from 2024-03-11; GitHub showed fresh pushes on 2026-06-12. It adds another native binding and would need to become a direct dependency, not just an optional LangChain peer. | Good if tuned, poor if left at defaults. On the same deterministic spike, `m=32, efConstruction=40, ef=16` measured recall@10 `0.9205`; `m=32, efConstruction=200, ef=100` measured `1.0000`. `readIndexSync()` reloads with `ef=10`, so the loader must set the configured `efSearch` after every read. |
| Upstream `faiss-node` accessors | Technically plausible. FAISS exposes `IndexHNSW::hnsw`, and `HNSW` has public `efConstruction` and `efSearch` fields. The wrapper could dynamic-cast factory-created indexes to `faiss::IndexHNSW` and expose narrow setters/getters, or expose a generic parameter API. | Best fit if accepted. It preserves `faiss.index`, `docstore.json`, LangChain `FaissStore`, legacy fallback, and current integrity semantics. | High schedule risk. The wrapper has not published since 2023; an accepted PR/release is uncertain. Carrying a fork would make this repo own native addon maintenance across Node/OS/FAISS combinations. | Likely the cleanest recall/ops compromise after implementation, because #596 could keep FAISS HNSW/SQ8 and tune `efSearch`. It still needs measured recall/latency gates after the accessor exists. |

## Spike Evidence

The spike used deterministic synthetic vectors only; it is not a replacement
for the BEIR acceptance gate required by #596. It was enough to decide whether
frozen defaults are acceptable.

Setup:

- 12,000 vectors, 64 dimensions, 64 deterministic clusters.
- 200 noisy in-corpus queries.
- recall@10 measured against FAISS `IndexFlatL2`.
- `faiss-node` loaded from the repo's existing direct dependency.
- `hnswlib-node@3.0.0` was installed under `/tmp` only; no package manifest was
  changed.

Results:

| Binding/config | recall@10 |
| --- | ---: |
| FAISS `HNSW16` | 0.9850 |
| FAISS `HNSW32` | 0.9935 |
| FAISS `HNSW64` | 1.0000 |
| FAISS `HNSW32,SQ8` | 0.9575 |
| hnswlib `m=16, efConstruction=200`, default loaded `ef=10` | 0.9395 |
| hnswlib `m=32, efConstruction=40, ef=16` | 0.9205 |
| hnswlib `m=32, efConstruction=200, ef=100` | 1.0000 |
| hnswlib `m=32, efConstruction=200, ef=200` | 1.0000 |

Persistence smoke:

- FAISS `HNSW32,SQ8` wrote and read `faiss.index` with `ntotal=5` and `dim=4`;
  this matches the current `index.vN` binary filename.
- hnswlib wrote and read `hnsw.index` with `count=5` and `dim=4`; after load,
  `getEf()` returned `10`, confirming that query-time `efSearch` must be
  reapplied by the repo's loader.

## Consequences for #596

#596 should not expose a generic ANN factory string until the binding decision
is resolved. A raw `KB_INDEX_FACTORY=HNSW32,SQ8` knob would make recall depend
on unconfigurable FAISS defaults and would not let users or benchmarks recover
recall by increasing `efSearch`.

If #596 chooses `hnswlib-node`, it should be scoped as a backend addition, not
as a small config change:

- Add a backend/index-type manifest field that distinguishes FAISS files from
  hnswlib files.
- Store the HNSW binary under `index.vN/hnsw.index` or another explicit name;
  do not overload `faiss.index`.
- Record `m`, `efConstruction`, `efSearch`, metric, capacity policy, and random
  seed in the manifest.
- Reapply `efSearch` on load before any query.
- Keep whole-index rebuild semantics. hnswlib supports delete markers, but the
  current repo safety model is still rebuild-and-swap.
- Gate promotion with BEIR/local fixtures comparing flat/SQ8 versus HNSW for
  recall, nDCG, p50/p95 latency, memory, and confidence intervals as required
  by the evaluation contract.

If #596 chooses the FAISS-accessor path, it should first land a binding spike
that proves:

- `efConstruction` can be set before `add()`;
- `efSearch` can be set before `search()`;
- the settings survive or are deliberately reapplied after `Index.read()`;
- `HNSW32,SQ8` recall improves when `efSearch` is raised;
- the wrapper still builds on the repo's supported Node versions.

## Alternatives Considered

- **Ship factory string with warnings.** Rejected. A warning does not make
  frozen `efSearch=16` observable or tunable, and users would see recall loss
  without a recovery knob.
- **Use only larger `M` through `HNSW64`.** Rejected as the main answer. Larger
  `M` can improve recall but raises graph memory and build cost, and it still
  cannot substitute for query-time `efSearch` control.
- **Make hnswlib the default.** Rejected. It is a different native backend and
  does not provide SQ8 compression; it needs direct dependency, manifest,
  loader, and evaluation work before becoming a supported default.
