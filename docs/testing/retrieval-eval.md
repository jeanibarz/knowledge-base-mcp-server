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
- Parse coverage for the worked example in `docs/testing/fixtures/methodology-starter.yml`.

`kb eval` defaults to dense retrieval to preserve the original evaluator behavior.
Pass `--mode=lexical`, `--mode=hybrid`, or `--mode=auto` to exercise the same
mode choices exposed by `kb search`. A fixture can also set top-level `mode` as
its default, and individual cases can override it with case-level `mode`.
JSON output records `requested_mode`, `effective_mode`, and `auto_mode` when
auto selection is used.

For authoring guidance, see [Retrieval eval fixture methodology](retrieval-eval-methodology.md).
