# `kb eval-gate` — RFC 018 Relevance-Gate Validation Harness

`kb eval-gate` is the measurement tool for the RFC 018 relevance gate. It
answers a simple operator question: *does turning the gate on make my
downstream answers better, worse, or roughly the same?*

The harness has two modes:

| Mode | When | What it measures |
| --- | --- | --- |
| **M0** (default) | Before turning the gate on in production | Simulated gate via threshold surgery vs. raw top-k. Always emits a report — falls back to an offline causal model when no endpoint is reachable. |
| **M1** (`--m1`) | After the gate is wired up, before promoting tuning changes | The *real* gate with `KB_RELEVANCE_GATE=on` and Stage B judge live. Requires a reachable endpoint. |

Both modes consume a labelled-queries fixture and emit a stable JSON or
markdown report. M0 always exits `0` (it is a measurement, not a gate); M1
exits non-zero when the endpoint is unreachable or the run cannot complete.

## M0 — validate before build

Use M0 to decide whether the gate is worth enabling at all for your KB shape.
It does not require a live LLM; the offline causal model treats the gate
keep/drop decision as the thing under test.

```bash
# Offline (always works, simulation mode):
kb eval-gate docs/testing/fixtures/rfc-018-gate-eval/queries.yml --dry-run --format=md

# Live (uses the local llama-server / Ollama / OpenAI-compatible endpoint):
KB_LLM_ENDPOINT=http://127.0.0.1:8080/v1/chat/completions \
kb eval-gate docs/testing/fixtures/rfc-018-gate-eval/queries.yml --format=json
```

The report's `summary` block carries three pre-registered numbers from
RFC 018:

| Field | What to look at |
| --- | --- |
| `empty_verdict_fire_rate` | How often the gate decides "no answer". Too high = recall regression. |
| `per_chunk_drop_no_good_answer_delta` | Whether the gate's *chunk* dropping (separate from the empty verdict) helps. Negative is better — fewer wrong answers. |
| `judge_false_empty_rate` | How often Stage B incorrectly returns empty. The gate's tail risk. |
| `directional_pass` | The single pre-registered go/no-go boolean. `true` means the M0 result clears the bar to keep iterating. |

When `directional_pass` is `false`, the gate is not worth enabling on this
KB *yet*. Tune `KB_GATE_SCORE_FLOOR`, re-run, and compare.

## M1 — real-gate canary

Use M1 when M0 said yes, after the Stage B judge is wired up, and you want
ground-truth numbers before promoting a `KB_GATE_*` tuning change.

```bash
KB_LLM_ENDPOINT=http://127.0.0.1:8080/v1/chat/completions \
kb eval-gate docs/testing/fixtures/rfc-018-gate-eval/queries.yml \
  --m1 \
  --calibration=docs/testing/fixtures/rfc-018-gate-eval/grader-calibration.yml \
  --floor-sweep=0.85:1.00:0.025 \
  --format=json \
  --out=runs/rfc-018-m1-$(date -u +%Y%m%dT%H%M%SZ).json
```

The M1 report adds (see `docs/rfcs/018-m1-canary-report.md` for the full
field list):

- Per-floor sweep points showing how recall and false-empty rate trade.
- A position-swap probe (RFC §5) showing whether the gate's ranking is
  stable when candidates are reordered.
- BM25-veto calibration against the grader fixture.
- A `recommendation` with a clear go/no-go and the recommended floor.

M1 *does not* fall back to simulation. If the endpoint is not reachable it
exits with code `2` — that is by design: a simulated M1 would be misleading.

## Fixture layout

`docs/testing/fixtures/rfc-018-gate-eval/` ships the reference fixture:

| File | Purpose |
| --- | --- |
| `queries.yml` | The labelled-queries fixture. Each case has `query`, `kb`, optional `task_context`, and a `gate_sim` block (the threshold surgery to apply). |
| `grader-calibration.yml` | Grader/human agreement fixture used as an admissibility threshold for live M0 and M1 runs. |

Use the shipped fixture as a starting point and add your own cases as the gate
matures.

## Tuning loop

1. **M0 baseline** — run `kb eval-gate <fixture> --dry-run` and record the
   three pre-registered numbers.
2. **Wire the gate** — set `KB_RELEVANCE_GATE=on` and verify behavior with
   `kb search --gate --task-context="…"`.
3. **M1 canary** — `kb eval-gate <fixture> --m1 --endpoint=…` and review the
   recommendation. Adjust `KB_GATE_SCORE_FLOOR`, `KB_GATE_JUDGE_INPUT`, or
   the judge prompt.
4. **Promote** — once M1 recommends go, update the operator-default env vars
   (see [`docs/feature-flags.md`](../feature-flags.md#relevance-gate)).
5. **Lock in** — promote any newly-judged borderline queries through
   [`kb feedback`](feedback-workflow.md) so the next M1 has more coverage.

## JSON contract

See [`docs/cli-json-contracts.md`](../cli-json-contracts.md#kb-eval-gate) for
the stable M0 envelope. The M1 envelope is documented in
[`docs/rfcs/018-m1-canary-report.md`](../rfcs/018-m1-canary-report.md).

## Related

- [RFC 018 — Context Relevance Gating](../rfcs/018-context-relevance-gating.md)
- [`docs/feature-flags.md` — Relevance Gate](../feature-flags.md#relevance-gate)
- [`kb feedback`](feedback-workflow.md) for accumulating gate-relevant
  judgments.
