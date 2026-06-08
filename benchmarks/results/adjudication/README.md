# Reranker upgrade — ship/no-ship adjudication (RFC 020 M5 · issue #565)

This directory holds the **first Tier-1 technique adjudicated through the full
RFC 020 harness**: the reranker upgrade
`Xenova/ms-marco-MiniLM-L-6-v2` → `BAAI/bge-reranker-v2-m3`.

## Decision

**PROVISIONAL — NO-SHIP pending the load-bearing benchmark runs.**

The adjudication machinery (per-domain §3 significance gate + §5 e2e veto + §9
skip-rerank fallback) is implemented, tested, and wired. The numeric evidence it
needs cannot be produced in this offline, model-free environment, so **no ship
decision is made on real numbers and none is fabricated**. The conservative,
RFC-aligned posture until the evidence arrives is *do not enable the candidate*.

See the machine-generated decision in
[`reranker-bge-v2-m3-adjudication.md`](reranker-bge-v2-m3-adjudication.md)
(and `.json`), produced by:

```bash
npm run bench:adjudicate -- \
    --manifest benchmarks/results/adjudication/reranker-bge-v2-m3-manifest.json \
    --output-dir benchmarks/results/adjudication \
    --report-name reranker-bge-v2-m3-adjudication
```

## How the candidate ships (the gate, once evidence exists)

Per RFC §9 a reranker upgrade is **never on by default for all corpora**. The
wiring landed in this PR makes the candidate selectable and gateable:

- **Model selection** — `KB_RERANK_MODEL=BAAI/bge-reranker-v2-m3` routes the
  production `src/reranker.ts` cross-encoder to the candidate. No code change.
- **Per-domain gate / skip-rerank fallback** — `KB_RERANK_SKIP_DOMAINS=code,skills`
  force-disables reranking for the listed KB scopes even under `KB_RERANK=on`.
  This is enforced at the single execution seam (`applyRerankerIfEnabled`) and
  honored by the CLI, MCP, and retrieval-eval paths, so a domain the survey/gate
  flags as cross-encoder-degraded keeps the cheaper un-reranked path.

The adjudicator turns measured per-domain verdicts into exactly this config:
improving domains → `ENABLE`, regressing/no-change domains → the skip list.

## Evidence status

| Leg | Status | Notes |
|---|---|---|
| Per-domain BEIR (§3 significance, per-domain gate §9) | **PENDING** | Needs SciFact/NFCorpus/FiQA + a code/skills domain, a real embedding provider (Ollama), and the candidate cross-encoder downloaded. Compares baseline vs candidate per-query nDCG@10 with Bonferroni/Holm + wild-cluster correction. |
| e2e RAG veto (§5) | **PENDING** (leg proven) | The hermetic `--fake` cascade ran end-to-end (see below). A real veto needs baseline-vs-candidate rag-eval over gold-QA with ≥3 live judge families. |

### Hermetic e2e self-test (proves the §5 leg runs)

`./e2e-selftest/` holds a **real** four-tier-cascade scorecard produced offline
from the committed gold fixture `./e2e-selftest-gold/hotpotqa.jsonl`:

```bash
node build/benchmarks/rag-eval/run.js --fake --datasets=hotpotqa \
    --data-dir=benchmarks/results/adjudication/e2e-selftest-gold \
    --output-dir=benchmarks/results/adjudication/e2e-selftest
```

It scores Tier-1 items=3, exact-match/token-F1/context-recall/precision = 1.0,
accuracy = 1.0. **This is a plumbing self-test** (the `--fake` answerer echoes
the gold answers), *not* a quality measurement and *not* a veto delta — it only
demonstrates the cascade is wired and runnable.

## Reproducing the full adjudication (when datasets + models are available)

```bash
# 1. Per-domain BEIR: baseline vs candidate reranker (real provider + models).
for d in scifact nfcorpus fiqa code; do
  KB_RERANK_MODEL=Xenova/ms-marco-MiniLM-L-6-v2 \
    npm run bench:beir -- --dataset=$d --mode=hybrid+rerank --provider=ollama \
      --output-dir=benchmarks/results/adjudication/beir/baseline
  KB_RERANK_MODEL=BAAI/bge-reranker-v2-m3 \
    npm run bench:beir -- --dataset=$d --mode=hybrid+rerank --provider=ollama \
      --output-dir=benchmarks/results/adjudication/beir/candidate
done

# 2. e2e RAG veto: baseline vs candidate, ≥3 live judge families.
#    (run bench:rag-eval twice with --judges=judges.json, one per reranker model)

# 3. Point the manifest's `domains[]` at the run JSONs from step 1 and
#    `e2eScorecards`/`e2e[]` at step 2, clear `pending`/`provisional`, then:
npm run bench:adjudicate -- --manifest benchmarks/results/adjudication/reranker-bge-v2-m3-manifest.json
```

The adjudicator will then emit a **final** SHIP / SHIP-GATED / NO-SHIP decision
and the per-domain `KB_RERANK_SKIP_DOMAINS` policy to apply.

## Worked examples

The decision logic across all paths (ship, ship-gated, no-ship, e2e veto,
Bonferroni/Holm correction, manifest loading) is exercised by
`benchmarks/adjudication/adjudicate.test.ts`.
