# Requirements

### TS-CHAOS-001: Search-time index corruption degrades safely
**Status:** Implemented
**Priority:** Medium

**Requirement:** The search path shall handle a corrupt or missing persisted
index artifact at query time as a classified degradation or partial result,
without an uncaught exception or process crash.

**Rationale:** Read-path corruption is a distinct failure mode from ingest and
save failures. The query-serving daemon needs deterministic coverage for its
graceful-degradation contract.

**Acceptance Criteria:**
- [x] A truncated or garbage FAISS index produces a classified degradation or
  partial result and never an uncaught throw.
- [x] Torn lexical-index JSON produces a classified degradation or partial
  result and never an uncaught throw.
- [x] A missing or short metadata sidecar produces a classified degradation or
  partial result and never an uncaught throw.
- [x] The scenario runs deterministically through `npm run test:chaos`.

**Linked Tests:** `tests/chaos/scenarios/search-faults.test.ts`
**Dependencies:** Existing chaos fault harness and search degradation paths.
