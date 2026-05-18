# RFC 018 M1 — relevance-gate canary report

**Milestone:** RFC 018 (`docs/rfcs/018-context-relevance-gating.md`) Migration **M1** — issue #372.
**Run date:** 2026-05-18 · **Mode:** live · autonomous (no human-labelling step).
**Harness:** `kb eval-gate --m1` (`src/relevance-gate-m1.ts`, `src/cli-eval-gate.ts`).

## What this run is

M0 (#369) *simulated* the gate via threshold surgery before any gate code
existed. M1 runs the **real gate** — `applyRelevanceGate`, `KB_RELEVANCE_GATE=on`,
the Stage B LLM judge live — over the committed validation fixtures and
measures, per RFC 018 §M1:

1. **Downstream answer quality** (the M0 method): each query answered by a live
   consuming agent with the raw top-k vs the real-gated set, scored by a live
   LLM grader calibrated against human labels.
2. **Recall on known-good fixtures** — does a real answer survive the gate?
3. The **position-swap probe** (RFC §5) — is the judge's verdict order-sensitive?
4. A **`KB_GATE_SCORE_FLOOR` sweep** (RFC §3) + the **BM25-veto calibration** (§6).
5. A **go/no-go** recommendation.

## Caveats — read the result through these

This is an honest canary, not the RFC's idealised "powered, human-labelled"
measurement. Three limits bound every number below:

1. **The judge model is the one RFC 018 §5 warns against.** The only local
   endpoint available was ollama `gemma3:4b` — a 4B model. RFC 018 §5 states
   plainly that a 4B model "**failed the `no-relevant-context` path**" and that
   the judge "must be capable, not merely fast." `gemma3:4b` was used here as
   judge **and** consuming agent **and** grader. Every result is therefore
   *{this corpus} × {an under-capable judge}*. A capable-judge re-run is a
   required follow-up before any M3 (default-on) decision — RFC §5: "M1
   measures the per-deployment point."
2. **The no-good-answer bucket had no headroom.** The raw (ungated) consuming
   agent already scored **100%** on no-good-answer queries — `gemma3:4b`,
   instructed to decline when the snippets lack the answer, declined correctly
   even with near-miss noise injected. A gate cannot beat 100%, so the
   directional criterion ("no-good-answer correctness trends *up*") is
   structurally unobservable on this run. It would only move if the raw
   consuming agent were actually fooled by near-misses.
3. **Hand-authored fixtures.** The 15-case set is the committed
   `rfc-018-gate-eval/queries.yml`, not candidate sets regenerated from real
   `kb search` canonical logs. Distances are grounded in the RFC §3 probe but
   the set is small; treat per-bucket numbers as directional.

## Headline

- **Go/no-go: NO-GO** for defaulting the gate on. The gate produced **no
  downstream answer-quality gain** on this run and **cost recall** (it dropped
  a real answer). `KB_RELEVANCE_GATE` stays **`off` by default**, as shipped.
- This is consistent with RFC 018's stated posture: the gate is recall-negative
  by construction, the evidence is genuinely mixed, and M3 (default-on) is
  conditional. It does **not** invalidate the gate — it says *this judge model
  on this corpus* does not yet clear the bar.

## Tuning recommendations

1. **Keep `KB_RELEVANCE_GATE=off` by default.** No change to the shipped
   default. The sunset clause (RFC §Migration) is satisfied — M1 ran.
2. **Keep `KB_GATE_SCORE_FLOOR=0.95`.** The sweep shows A1 cannot win here: the
   answer-present-but-distant answers sit at dense distance 1.05–1.07, *inside*
   the out-of-domain band, so the only recall-safe floor (1.10) clears 0% of
   no-good-answer noise — a no-op. Lowering the floor drops real answers;
   raising it disables A1. A1's floor is not the lever; **the distant-answer
   class needs the RFC 019 reranker** (RFC §3 / §Alternatives anticipated this).
3. **Position-swap: re-run the probe with a capable judge before reintroducing
   the double call.** The probe found the `no-relevant-context` verdict
   order-sensitive on 1/15 cases and the per-candidate keep-set order-sensitive
   on 73% — but with `gemma3:4b`, exactly the unreliable-judge regime. RFC §5's
   trigger ("if the probe shows the empty verdict is order-sensitive, reintroduce
   the A/B-swapped double call") is *met on signal* but *confounded by model
   capability*. Do not pay the latency-doubling cost on a 1-case signal from a
   model the RFC already disqualifies — re-measure with a capable judge first.
4. **Defer the normalized-BM25 floor.** The fixture carries one lexical-hit case
   — too few to calibrate a normalized-BM25 floor. This needs candidate sets
   regenerated from real `kb search` logs with BM25 scores attached. The veto
   ships as the M0a presence check until then.
5. **Re-validate after RFC 019.** RFC 018's Open question stands: re-run M1 once
   the cross-encoder reranker lands — it gives A1/A2 a calibrated score and may
   change the no-go.

## Full harness report

The verbatim `kb eval-gate --m1` output follows. Reproduce with:

```sh
kb eval-gate docs/testing/fixtures/rfc-018-gate-eval/queries.yml --m1 \
  --endpoint=<openai-compatible-url> --model=<judge-model> \
  --calibration=docs/testing/fixtures/rfc-018-gate-eval/grader-calibration.yml
```

---

# RFC 018 M1 — relevance-gate canary report

- Generated: 2026-05-18T23:48:07.785Z
- Fixture: `docs/testing/fixtures/rfc-018-gate-eval/queries.yml`
- Run mode: **live**
- Consuming-agent model: `gemma3:4b`
- Grader model: `gemma3:4b`

## Query set

- 15 queries across 2 KBs: `codeops`, `prose`
- has-answer: 10 · no-good-answer: 5 (no-good-answer ratio 33.3%)
- answer-present-but-distant fixtures: 2

## Directional pass criterion (pre-registered, per-bucket)

| bucket | raw | gated | delta |
|---|---|---|---|
| no-good-answer | 100.0% | 100.0% | +0.0pp |
| has-answer | 100.0% | 100.0% | +0.0pp |

- Criterion 1 — no-good-answer correctness trends up by >= +10.0pp: **NOT MET**
- Criterion 2 — has-answer correctness does not trend down (>= +0.0pp): **MET**
- **Directional verdict: NOT MET**

## Pre-registered numbers (#369 — these decide which gate parts ship)

### (i) Empty-verdict fire rate

- `no-relevant-context` fired on **4/15** queries (26.7%).
- If near-zero, the gate is effectively A1+A2 tail-trimming (~`--threshold=auto`) and most of RFC 018 §6 is dead weight.

### (ii) Per-chunk-drop contribution, isolated from the empty verdict

`gated-no-empty` runs the cascade with the empty verdict disabled (per-chunk drops + low-confidence rescue only):

| bucket | raw | gated-no-empty | delta |
|---|---|---|---|
| no-good-answer | 100.0% | 100.0% | +0.0pp |
| has-answer | 100.0% | 100.0% | +0.0pp |

### (iii) Judge false-empty rate (answer-present-but-distant class)

- The gate emitted `no-relevant-context` on **0/2** answer-present-but-distant fixtures (0.0%).
- Each false-empty here is a real, recoverable answer the gate suppressed — RFC 018 §6 residual risk.

## Grader admissibility (pre-registered first)

- Grader/human agreement over 6 calibration cases: 100.0% (threshold 70.0%).
- **Run ADMISSIBLE** — the grader can resolve the effect.

> Section 1 above is the downstream-answer-quality measurement: each query answered
> by a live consuming agent with the **raw** top-k vs the **real gate** (`KB_RELEVANCE_GATE=on`, Stage B LLM judge live), graded by a live LLM grader.
> The judge degraded to the statistical path on **0/15** cases.
> A task_context was synthesized from the query on **13/15** cases (the fixture authors only two) so Stage B is exercised across the set — a production Kookr hook (M2, RFC §11) supplies this for real.

## Recall on known-good fixtures

- has-answer recall through the real gate: **9/10** (90.0%).
- answer-present-but-distant recall: **1/2** (50.0%).
- The gate is recall-negative by construction (RFC 018) — any answer it drops is a strict regression.

## Position-swap probe (RFC 018 §5)

- Judged 15 cases forward + reversed (0 judge errors excluded).
- Overall-verdict disagreement rate: **20.0%**.
- Keep-set disagreement rate: **73.3%**.
- `no-relevant-context` order-sensitive on **1** cases.

| case | forward | reversed | overall agree | keep-set agree |
|---|---|---|---|---|
| codeops - atomic faiss save mechanism | relevant | relevant | yes | NO |
| codeops - per-file hash invalidation | relevant | relevant | yes | NO |
| codeops - hybrid rrf fusion | relevant | relevant | yes | yes |
| codeops - injection guard stage | relevant | partial | NO | NO |
| codeops - doctor command checks | relevant | relevant | yes | NO |
| codeops - rollback procedure phrased loosely | relevant | relevant | yes | NO |
| codeops - question the KB cannot answer (kubernetes) | no-relevant-context | no-relevant-context | yes | yes |
| codeops - question the KB cannot answer (billing) | no-relevant-context | no-relevant-context | yes | yes |
| prose - contextual retrieval rationale | relevant | relevant | yes | NO |
| prose - context rot narrative | partial | relevant | NO | yes |
| prose - llm-as-judge agreement caveat | relevant | relevant | yes | NO |
| prose - reranker note phrased as a question about ordering | relevant | relevant | yes | NO |
| prose - question the KB cannot answer (hiring) | no-relevant-context | no-relevant-context | yes | NO |
| prose - question the KB cannot answer (weather) | no-relevant-context | no-relevant-context | yes | NO |
| prose - no answer but a lexical decoy matches | relevant | no-relevant-context | NO | NO |

- **Recommendation:** The `no-relevant-context` verdict flipped with candidate order on 1/15 cases — RFC 018 §5: reintroduce the A/B-swapped double judge call for the empty verdict.

## Score-floor sweep — `KB_GATE_SCORE_FLOOR` (RFC 018 §3)

| floor | mean kept | has-answer recall | distant-answer recall | no-good-answer cleared |
|---|---|---|---|---|
| 0.80 | 1.40 | 80.0% | 0.0% | 100.0% |
| 0.85 | 1.53 | 80.0% | 0.0% | 100.0% |
| 0.90 | 1.73 | 80.0% | 0.0% | 100.0% |
| 0.95 | 1.80 | 80.0% | 0.0% | 100.0% |
| 1.00 | 1.80 | 80.0% | 0.0% | 100.0% |
| 1.05 | 1.93 | 90.0% | 50.0% | 0.0% |
| 1.10 | 2.47 | 100.0% | 100.0% | 0.0% |

- **Recommended `KB_GATE_SCORE_FLOOR`: 1.1.** KB_GATE_SCORE_FLOOR=1.1 is the lowest swept floor with no recall loss; it floors the most no-good-answer noise A1 can remove without dropping a real answer.

> Operator note: the harness recommends 1.1 strictly as the lowest *recall-safe*
> swept floor, but at 1.1 A1 clears 0% of no-good-answer noise — a no-op. The
> standing recommendation (above) is to **keep `KB_GATE_SCORE_FLOOR=0.95`**: A1
> cannot separate the answer-present-but-distant class from out-of-domain noise
> on this corpus, and that is the RFC 019 reranker's job, not the floor's.

## BM25-veto calibration (RFC 018 §6)

- Fixtures carrying a lexical hit: **1** (has-answer 0, no-good-answer 1).
- no-good-answer cases where the veto would block a correct empty verdict: **1**.
- The committed fixture carries only a boolean `lexical_hit` (RFC 018 M0a ships the veto as a presence check; full BM25-score normalization is deferred to M1). With this few lexical-hit fixtures the veto sample is too small to calibrate a normalized-BM25 floor — that needs candidate sets regenerated from real `kb search` logs with BM25 scores attached.

## Go / no-go

- **Decision: NO-GO**
  - Answer quality did not clear the directional bar: no-good-answer +0.0pp (needs >= +10.0pp), has-answer +0.0pp.
  - Recall loss: has-answer recall 90.0%, answer-present-but-distant recall 50.0% — the gate dropped a real answer.
  - NO-GO — answer quality did not improve; keep KB_RELEVANCE_GATE=off by default. RFC 018 Open question: re-validate once the RFC 019 reranker lands.
