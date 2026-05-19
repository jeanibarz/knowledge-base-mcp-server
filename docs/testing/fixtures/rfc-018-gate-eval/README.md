# RFC 018 M0 — relevance-gate validation fixtures

These fixtures drive `kb eval-gate`, the RFC 018 M0 (#369) validation
harness. M0 answers one question **before** any gate code is built: does a
post-retrieval relevance gate improve *downstream answer quality*? The gate
is recall-negative by construction (it can only remove results), so RFC 018
adopts a "validate before build" posture.

## Files

| file | purpose |
|---|---|
| `queries.yml` | The query set — 15 queries across 2 structurally different KBs (`codeops`, `prose`), each with a replayed candidate set. |
| `grader-calibration.yml` | Human-labelled answers used to pre-register the LLM grader's admissibility (live mode only). |

## What `queries.yml` contains

- **Two structurally different KBs** (RFC 018 M0 requires ≥ 2): `codeops`
  (identifier-heavy code/ops notes) and `prose` (paraphrase-heavy research
  prose). Whether gating helps is corpus-specific.
- **Buckets.** `has-answer` (the KB holds the answer) vs `no-good-answer`
  (it does not — retrieval still returns its `k` near-misses). The mix is
  not curated toward `no-good-answer`, which RFC 018 warns flatters the gate.
- **The `answer-present-but-distant` class** — has-answer cases whose answer
  chunk sits *far* from the query in embedding space. This is the RFC 018 §6
  residual-risk class the judge-false-empty rate is measured on.
- **Replayed candidate sets.** Each case carries its retrieved candidates
  (`id` / `source` / `content` / `dense_distance`, optionally `lexical_hit`)
  so the harness is deterministic and CI-checkable without a live embedding
  provider. Dense distances are grounded in the RFC 018 §3 empirical probe
  (`nomic-embed-text`: in-domain 0.43–0.74, out-of-domain 1.00–1.09, A1
  floor 0.95). They are hand-authored; for a production-grounded run,
  regenerate the candidate sets from real `kb search` canonical logs.

## Running the harness

Simulation mode (offline — no LLM, deterministic causal model):

```sh
kb eval-gate docs/testing/fixtures/rfc-018-gate-eval/queries.yml --dry-run
```

Live mode (real consuming agent + real grader over an OpenAI-compatible
endpoint):

```sh
kb eval-gate docs/testing/fixtures/rfc-018-gate-eval/queries.yml \
  --endpoint=http://127.0.0.1:8080/v1/chat/completions \
  --calibration=docs/testing/fixtures/rfc-018-gate-eval/grader-calibration.yml
```

The report carries the pre-registered **directional pass criterion**
(per-bucket) and the three pre-registered numbers: empty-verdict fire rate;
per-chunk-drop contribution isolated from the empty verdict; and the judge
false-empty rate on the `answer-present-but-distant` class.

Simulation mode measures the gate's **keep/drop decision** — the
recall-negative risk — under an idealised "answer-present ⇔ answerable"
consumer model. It does *not* measure a real LLM's robustness to injected
near-miss noise; that needs a live run. RFC 018 M1 is the powered,
human-labelled measurement; M0 is a directional go/no-go.
