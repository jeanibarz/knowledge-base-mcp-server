# Retrieval Eval Fixtures

This directory contains committed fixture packs for retrieval evaluation.

The dogfood packs use the small corpus in `dogfood-corpus/` so schema and
determinism checks can run in CI without a maintainer's private knowledge
bases. The frozen core is intended for stable cases; the rotating arena is for
new bug-derived or adversarial cases before they graduate.

To run a real retrieval eval, index `docs/testing/fixtures/dogfood-corpus/` as a
KB named `dogfood`, then run:

```sh
kb eval docs/testing/fixtures/dogfood-frozen-core.yml --mode=auto
kb eval docs/testing/fixtures/dogfood-rotating-arena.yml --mode=auto
KB_RERANK=off kb eval docs/testing/fixtures/rfc-019-reranker-eval.yml --format=json
KB_RERANK=on kb eval docs/testing/fixtures/rfc-019-reranker-eval.yml --format=json
```

The listed packs are warning-only for now (`gate: false`). Promote a case to
gated use only after it is stable across the supported provider matrix and its
source-of-truth comment still matches the committed corpus or shelf note.
