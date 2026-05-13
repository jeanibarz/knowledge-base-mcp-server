# Retrieval Eval Command Tests

### TS-RETRIEVAL-EVAL-001: Fixture Evaluator Coverage

The unit tests in `src/retrieval-eval.test.ts` cover:

- Passing fixture cases with required sources, expected metadata, stale policy, and duplicate budget.
- Missing required source failures.
- Forbidden source failures.
- Duplicate-source budget failures.
- Exit-code behavior where ungated failures warn and gated failures fail CI.
- Retrieval mode parsing for `dense`, `lexical`, `hybrid`, and `auto`.
- Fixture-level and case-level retrieval mode normalization.
- Per-case requested/effective retrieval mode reporting.
- Optional ranked relevance judgments via `relevant_sources` and `judgments`.
- Ranked IR metrics for perfect ranking, relevant-but-low-ranked sources,
  missing judged sources, graded relevance, and aggregate reporting.
- Source diversity diagnostics for every case, including unique-source@k,
  duplicate-groups@k, and max-source-share@k.
- Intent-aware diversity diagnostics when relevant source labels include
  `group`, `groups`, `intent`, or `intents`.
- Parse coverage for the worked example in `docs/testing/fixtures/methodology-starter.yml`.

`kb eval` defaults to dense retrieval to preserve the original evaluator behavior.
Pass `--mode=lexical`, `--mode=hybrid`, or `--mode=auto` to exercise the same
mode choices exposed by `kb search`. A fixture can also set top-level `mode` as
its default, and individual cases can override it with case-level `mode`.
JSON output records `requested_mode`, `effective_mode`, and `auto_mode` when
auto selection is used.

Use `kb eval scaffold "<query>"` to turn a live retrieval query into starter
fixture YAML on stdout:

```bash
kb eval scaffold "rollback procedure" --kb=work --mode=hybrid --k=5
```

The scaffold output is intentionally not written to disk. It seeds one ungated
case with top unique result sources as `required_sources`, simple metadata
expectations when the retrieved chunks already expose them, and a stale policy
that validates through `normalizeRetrievalEvalFixture`.

Every case emits `diversity_metrics` in JSON and a diversity summary in
markdown. Source-level diagnostics include unique-source@k, duplicate-groups@k,
and max-source-share@k, with aggregate means across cases.

Cases with `relevant_sources` or `judgments` also emit `ranked_metrics` in both
markdown and JSON. The evaluator reports per-case `nDCG@10`, `MRR@10`,
`Recall@k`, `Precision@k`, `MAP`, `MAP@k`, and hit rate, then reports aggregate
means across judged cases. When positive judgments carry `group`, `groups`,
`intent`, or `intents`, `diversity_metrics.intent` adds intent recall@k and
alpha-nDCG@k. Cases without judgments preserve the original binary pass/fail
output shape, plus the source diversity diagnostics.

For authoring guidance, see [Retrieval eval fixture methodology](retrieval-eval-methodology.md).
