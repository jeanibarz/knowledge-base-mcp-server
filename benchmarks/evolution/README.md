# KB CLI evolution harness

This harness runs advisor-style champion/challenger evaluations for `kb` CLI
performance and retrieval-efficiency changes. It is deliberately conservative:
it emits `decision.json` and `report.md`, but it does not rewrite defaults,
refresh baselines, or change code automatically.

## Plan file

```json
{
  "schema_version": "kb.evolution-plan.v1",
  "run_id": "iter-001",
  "objective": {
    "metric_path": "scenarios.warm_query.p95_ms",
    "direction": "lower",
    "min_absolute_improvement": 5
  },
  "gate": {
    "max_fail_rows": 0,
    "max_warn_rows": null,
    "require_metric_present": true
  },
  "champion": {
    "id": "current-defaults",
    "report": "benchmarks/results/baseline-stub-node24-linux-x64.json"
  },
  "candidates": [
    {
      "id": "chunk-768-overlap-128",
      "hypothesis": "Smaller chunks reduce warm query tail latency without quality loss.",
      "command": [
        "npm",
        "run",
        "bench"
      ],
      "env": {
        "BENCH_PROVIDER": "stub",
        "KB_CHUNK_SIZE": "768",
        "KB_CHUNK_OVERLAP": "128",
        "BENCH_INCLUDE_CLI_SEARCH": "1"
      }
    }
  ]
}
```

Each arm may provide either a precomputed `report` path or a `command` array.
Commands are executed with `BENCH_RESULTS_DIR` pointed at the run directory and
`BENCH_RESULTS_PREFIX` derived from the arm id unless the arm overrides them.

Run:

```bash
npm run bench:evol -- --plan=benchmarks/evolution/plan.json
```

Artifacts land under `benchmarks/results/evolution/<run-id>/`:

- `decision.json` — deterministic promotion decision
- `report.md` — human-readable summary
- `reports/<arm>.json` — copied benchmark reports used for the decision

## Promotion rule

A candidate qualifies only when:

- the objective metric improves by the configured absolute and/or relative
  margin;
- `budget-diff` reports no more fail/warn rows than the pre-registered gate
  allows;
- the objective metric exists unless `require_metric_present` is disabled.

The winner is the qualified candidate with the largest objective improvement.
If no candidate qualifies, the champion holds.
