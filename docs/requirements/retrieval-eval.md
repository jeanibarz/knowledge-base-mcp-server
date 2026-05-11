# Retrieval Eval Command

### FR-RETRIEVAL-EVAL-001: Fixture-Driven Retrieval Evaluation

**Status:** Implemented
**Priority:** High

**Requirement:** The system shall run retrieval evaluation fixtures that define a query, optional knowledge-base scope, required sources, forbidden sources, expected metadata, duplicate-source budget, stale-policy expectation, and gate behavior.

**Acceptance Criteria:**

- [ ] Given a fixture case with required sources, when `kb eval` runs the query, then the case fails if any required source is missing.
- [ ] Given a fixture case with forbidden sources, when a forbidden source appears in the results, then the case fails.
- [ ] Given a fixture case with a duplicate-source budget, when the number of repeated-source groups exceeds the budget, then the case fails.
- [ ] Given a fixture case without gate behavior, when the case fails, then the command reports the failure as a warning and exits 0.
- [ ] Given a fixture case with gate behavior, when the case fails, then the command exits nonzero.

**Linked Tests:** TS-RETRIEVAL-EVAL-001

**Authoring Guidance:** See [Retrieval eval fixture methodology](../testing/retrieval-eval-methodology.md) for fixture archetypes, gating policy, contamination guardrails, and the worked starter fixture.
