# Retrieval Eval Command Tests

### TS-RETRIEVAL-EVAL-001: Fixture Evaluator Coverage

The unit tests in `src/retrieval-eval.test.ts` cover:

- Passing fixture cases with required sources, expected metadata, stale policy, and duplicate budget.
- Missing required source failures.
- Forbidden source failures.
- Duplicate-source budget failures.
- Exit-code behavior where ungated failures warn and gated failures fail CI.
