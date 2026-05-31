# Retrieval Eval Command

### FR-RETRIEVAL-EVAL-001: Fixture-Driven Retrieval Evaluation

**Status:** Implemented
**Priority:** High

**Requirement:** The system shall run retrieval evaluation fixtures that define a query, optional knowledge-base scope, required sources, forbidden sources, expected metadata, duplicate-source budget, stale-policy expectation, and gate behavior.

**Acceptance Criteria:**

- [x] Given a fixture case with required sources, when `kb eval` runs the query, then the case fails if any required source is missing.
- [x] Given a fixture case with forbidden sources, when a forbidden source appears in the results, then the case fails.
- [x] Given a fixture case with a duplicate-source budget, when the number of repeated-source groups exceeds the budget, then the case fails.
- [x] Given a fixture case without gate behavior, when the case fails, then the command reports the failure as a warning and exits 0.
- [x] Given a fixture case with gate behavior, when the case fails, then the command exits nonzero.

**Linked Tests:** TS-RETRIEVAL-EVAL-001

**Authoring Guidance:** See [Retrieval eval fixture methodology](../testing/retrieval-eval-methodology.md) for fixture archetypes, gating policy, contamination guardrails, and the worked starter fixture.

### FR-RETRIEVAL-EVAL-509: Replayable Benchmark Tuning

**Status:** Implemented
**Priority:** High

**Requirement:** The system shall support optional Optuna-driven benchmark tuning without adding Optuna to the default benchmark path.
**Rationale:** Retrieval benchmark experiments need reproducible tuning runs whose best trial can be replayed without relying on transient terminal output or mandatory optional dependencies.

**Acceptance Criteria:**

- [x] Given `npm run bench:tune` is invoked with a benchmark command and tunable environment variables, when Optuna is installed, then the tuner shall optimize the selected numeric metric.
- [x] Given Optuna is not installed, when tuning is requested, then the tuner shall fail with actionable setup guidance.
- [x] Given a tuning run completes, then the tuner shall write a replay config containing the benchmark command and best-trial environment values.
- [x] Given a replay config, when replay is requested, then the tuner shall run the recorded command with the recorded environment without requiring Optuna.
- [x] Given a BEIR benchmark config file, when `bench:beir` runs with `--config`, then the runner shall apply retrieval parameters and environment overrides from that JSON file.

**Linked Tests:** TS-RETRIEVAL-EVAL-509
