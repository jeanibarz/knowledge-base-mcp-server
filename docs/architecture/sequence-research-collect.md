# Sequence — `kb research collect`

End-to-end flow for `kb research collect "<question>" --run-dir=<path>`. The
entrypoint is `runResearch` at `src/cli-research.ts:184-214`, which dispatches
to `collectResearch` at `src/cli-research.ts:354-484` when the action is
`collect`.

The collector is deterministic and stateless across invocations: it never
calls an LLM, never writes KB content, and uses the existing CLI hybrid
search through a `deps.searchHybrid` seam so testing can mock the retrieval
boundary.

```mermaid
sequenceDiagram
  autonumber
  participant Op as Operator/agent
  participant Cli as runResearch<br/>src/cli-research.ts:184-214
  participant Collect as collectResearch<br/>:354-484
  participant Plan as buildResearchPlan<br/>:315-338
  participant Stats as deps.loadStats / loadShelfDescriptions
  participant Search as deps.searchHybrid<br/>(kb search --mode=hybrid)
  participant FS as $RUN_DIR

  Op->>Cli: kb research collect "<question>"<br/>--run-dir=<path>
  Cli->>Collect: collectResearch(args, deps)
  Collect->>FS: mkdir -p <run-dir><br/>:357
  Collect->>FS: touch events.jsonl<br/>:358-359
  Collect->>FS: appendEvent collect_started<br/>:362-367

  Collect->>Plan: buildResearchPlan(question, k)<br/>:369
  Plan->>Stats: loadShelfDescriptions() + loadStats()<br/>:321-324
  Stats-->>Plan: shelf names + descriptions + file/chunk counts
  Note over Plan: deterministic shelf scoring +<br/>query generation (:325-336)
  Plan-->>Collect: kb-research-plan.v1
  Collect->>FS: appendEvent plan_created<br/>:370-375

  loop for each (query, shelf) in plan.queries
    Collect->>Search: searchHybrid({query, shelf, k})<br/>:387-391
    alt search_failure
      Search-->>Collect: exitCode != 0
      Collect->>FS: appendEvent search_failure<br/>:401-403
    else search_completed
      Search-->>Collect: results[]
      Collect->>FS: appendEvent search_completed<br/>:406-413
      Note over Collect: toLedgerEntry per result<br/>:414-422
    end
  end

  Collect->>FS: writeJsonAtomic run.json<br/>:454
  Collect->>FS: writeJsonAtomic plan.json<br/>:455
  Collect->>FS: writeJsonAtomic ledger.json<br/>:456
  Collect->>FS: writeTextAtomic evidence_packet.md<br/>:457
  Collect->>FS: appendEvent artifacts_written<br/>:458-463
  Collect-->>Cli: { exitCode, summary }<br/>:465-484
  Cli-->>Op: kb-research-collect-summary.v1 (stdout)<br/>exit 0 (complete) or 1 (failed)
```

## Key invariants

- **No LLM call.** `collectResearch` calls only `deps.loadShelfDescriptions`,
  `deps.loadStats`, and `deps.searchHybrid`. None of those touch a language
  model.
- **Atomic per-artifact writes.** `writeJsonAtomic` / `writeTextAtomic`
  (`src/cli-research.ts` near :454-457) write to a temp file then rename, so
  a SIGINT mid-collect leaves either the previous file or no file — never a
  truncated one.
- **Events.jsonl is the audit trail.** Every state change (`collect_started`,
  `plan_created`, `search_completed`, `search_failure`, `artifacts_written`)
  appends a line. Replay it to reconstruct exactly what the collector saw.
- **Status mirrors search outcomes.** `status: failed` (exit `1`) means at
  least one `searchHybrid` call returned a non-zero exit. The successful
  shelf entries are still in the ledger; this is *partial failure*, not
  data loss.

## Cost profile

For `Q` queries × `S` shelves with `k` results each: one cold hybrid search
per `(query, shelf)` cell when called without `--daemon`, plus the constant
overhead of the planner (two parallel `loadShelfDescriptions` + `loadStats`
calls). With `kb serve` running and `--daemon` propagated, every shelf
search is warm.

## Related

- Operator walk-through: [`docs/operations/research-workflow.md`](../operations/research-workflow.md)
- JSON contract: [`docs/cli-json-contracts.md`](../cli-json-contracts.md#kb-research)
- Downstream: ledger entries feed [`kb feedback`](../operations/feedback-workflow.md)
  when an operator judges them.
