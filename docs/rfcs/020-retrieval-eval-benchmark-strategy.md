# RFC 020 — Retrieval Evaluation & Public-Benchmark Strategy

**Status:** Partially implemented (M0–M2 benchmark infrastructure largely built — BEIR matrix, MLflow ledger, compare leaderboard under benchmarks/)
**Depends on:** #206 (hybrid RRF), RFC 017 (contextual retrieval), RFC 018 (relevance gating), RFC 019 (cross-encoder reranker), RFC 013 (multi-model support)
**Composes with:** existing `src/retrieval-eval.ts` fixture framework, `benchmarks/beir/` harness, `benchmarks/observability/mlflow.ts`
**Tracks:** retrieval quality *as a measured, defensible, reproducible quantity* — and a path to public leaderboard standing without sacrificing zero-shot generality

## Problem

We ship a strong retrieval stack — dense (FAISS, Qwen3-Embedding-0.6B), BM25 (chunk + source units), hybrid RRF fusion (#206), a cross-encoder reranker (RFC 019), contextual prefaces (RFC 017), and an LLM relevance gate (RFC 018). We also have a fixture-driven eval framework (`src/retrieval-eval.ts`: nDCG@10, MRR, MAP, recall/precision@k, α-nDCG) and a BEIR harness with MLflow observability.

And yet we cannot currently answer the one question that matters: **how does our real retrieval pipeline rank against the field on a standard benchmark, and is it getting better or worse over time?**

Three concrete gaps:

1. **We benchmark BM25, not our system.** `benchmarks/beir/run.ts:352` throws unless `--mode=lexical`:

   ```ts
   if (mode !== 'lexical') throw new Error('BEIR benchmark currently supports --mode=lexical only');
   ```

   Our only recorded BEIR result is lexical/source on SciFact: **nDCG@10 = 0.669** — a pure-BM25 number. The dense + hybrid + rerank pipeline we actually built and ship is *never measured against BEIR qrels*. On SciFact, a Qwen3-Embedding + RRF + cross-encoder stack lands in the ~0.74–0.77 band. We are quoting ourselves ~7–10 nDCG points low because the harness can't exercise the real path.

2. **No regression gate on quality.** `benchmarks/scenarios/retrieval-quality.ts` checks a *synthetic* `recall@10 ≥ 0.95` invariant (RFC 007 §6.4.1) on generated corpora. Nothing in CI catches a real-corpus nDCG regression when someone retunes RRF `c`, swaps a reranker, or changes chunking. Quality drift is invisible until a user reports bad results.

3. **No public-ranking story, and no defense against overfitting one.** We have no reproducible, citable result on any public leaderboard, and no statistical machinery to claim "config B beats config A" without it being eyeballed noise. Worse: the obvious way to climb a single benchmark — tune to its corpus — directly erodes the **general knowledge research** capability that is the product's reason to exist.

This RFC is the *measurement and program* RFC. It does not introduce a new retrieval technique. It makes retrieval quality a first-class, honestly-measured, CI-gated quantity, and lays a phased path to credible standing on **BEIR, then BRIGHT, then MTEB** — explicitly structured so that climbing those rankings *is* climbing generality, not gaming it.

## Goal

Stand up an evaluation program with four properties:

1. **Faithful** — benchmarks the pipeline we actually ship (dense / hybrid / hybrid+rerank / +contextual), across the full BEIR dataset matrix, not one dataset in one mode.
2. **Honest** — tunes on dev, reports on test; every "we improved" claim is backed by a paired significance test, not a single-run delta.
3. **Gated** — a fixed BEIR subset runs in CI and fails the build on a quality regression beyond a stated tolerance, mirroring the existing latency `budget-diff` pattern.
4. **Public** — produces reproducible, citable results targeting **BEIR (headline) → BRIGHT (reasoning, less-saturated) → MTEB (embedding-model rank)**, with a documented submission path for each, and a generalization guardrail so leaderboard climbing does not regress zero-shot or end-to-end RAG quality.

Concretely, this RFC defines:

- The harness extension (BEIR all-modes + dataset matrix; BRIGHT; MTEB submission path; end-to-end RAG eval).
- The statistical and CI machinery (bootstrap significance, the quality gate).
- The reproducibility ledger (MLflow run = commit + env + per-dataset metrics).
- A phased milestone plan (M0–M5) with acceptance metrics per phase.
- A retrieval-technique **roadmap** sequenced behind the harness — each technique gated by "show the gain on the dataset matrix first," each large technique deferred to its own downstream RFC.

**Non-goals:**

- **Implementing new retrieval techniques.** ColBERT/late-interaction, SPLADE/learned-sparse, listwise LLM rerank, HyDE/multi-query, late chunking, and domain adaptation are *named and sequenced* here but each is a separate downstream RFC. This RFC builds the scale that tells us whether any of them is worth shipping.
- **Fine-tuning / training embedding models.** Out of scope for this RFC. If pursued later (RFC 02x), it is gated behind the zero-shot guardrail defined here.
- **Replacing `src/retrieval-eval.ts`.** The fixture framework stays for project-specific golden sets; this RFC adds the *public-benchmark* and *CI-gate* layers around it.
- **Official daily leaderboard maintenance.** We define a reproducible submission path; we do not commit to a submission cadence here.

## Guiding principle — measure before build

RFC 018 adopted "validate before build"; this RFC generalizes it to the whole retrieval program. The ordering is deliberate and non-negotiable:

> No retrieval technique ships until the harness can show its gain on the full BEIR dataset matrix, on test splits, with a passing significance test, and without regressing the end-to-end RAG eval.

The harness is therefore the *first* deliverable, and it is the precondition for every technique in the roadmap. We have spent effort building retrieval features (RFC 017/018/019) faster than we can measure them; this RFC closes that gap before opening new ones.

## Design

### 1. Harness architecture — extend, don't replace

The BEIR runner (`benchmarks/beir/run.ts`) already does the hard parts: it materializes a temporary KB corpus, maps `kb` hits back to BEIR document IDs, scores against qrels (`benchmarks/beir/metrics.ts`: nDCG@10, MAP@100, Recall@10/100), and emits TREC run files + a markdown report. It is dependency-injected (`loadLexicalIndex`) and is the right seam.

The change is to generalize its single `mode: 'lexical'` axis into the full retrieval-mode space the product already exposes:

```
mode ∈ { lexical, dense, hybrid, hybrid+rerank, hybrid+rerank+contextual }
```

Each mode drives the **same code paths the product ships** — `src/search-core.ts` mode resolution, `src/hybrid-retrieval.ts` RRF, `src/reranker.ts` — not a benchmark-only reimplementation. This is the central correctness property: *a BEIR number is only meaningful if it exercises the production retrieval path.* The runner's job is corpus materialization, ID mapping, and qrels scoring; retrieval itself must call into `src/`.

Dense/hybrid modes require an embedding provider and (for rerank) the cross-encoder. The runner already supports the credential-free `lexical` mode for CI; dense modes run with `EMBEDDING_PROVIDER` set (Ollama locally, or the `fake` provider for harness self-tests). Mode availability is reported, not silently skipped: a dense run with no provider fails loudly with a `kb doctor`-style diagnostic.

### 2. The dataset matrix

A single dataset is overfittable; the field quotes the **multi-dataset mean**. The harness gains a dataset registry and a sweep runner:

- **BEIR core (CI subset):** SciFact, NFCorpus, FiQA-2018 — small, fast, domain-diverse (science / bio / finance). This is the gate subset (§4).
- **BEIR full (release sweep):** the standard public set — TREC-COVID, NFCorpus, NQ, HotpotQA, FiQA, ArguAna, Touché-2020, Quora, DBPedia, SciDocs, FEVER, Climate-FEVER, SciFact, plus CQADupStack — run on the headline metric (nDCG@10), averaged.

Output is one row per `(dataset × mode)` and a per-mode mean across datasets. The mean-across-domains is the headline number precisely because overfitting any single corpus *lowers* it — the metric is structurally aligned with generality (§6).

### 3. Statistical significance — stop chasing noise

Per-query metrics are already computed (`QueryMetric` in `benchmarks/beir/metrics.ts`). Add a comparator that takes two run files (per-query nDCG@10 vectors over the same query set) and reports:

- **Paired bootstrap** (10k resamples) confidence interval on the mean delta, and a **paired t-test** p-value.
- A stated **minimum detectable effect (MDE)** for each metric/corpus, derived from the evaluated query count. For bounded recall-like metrics use the binomial approximation `SE = sqrt(p(1-p)/n)` and `MDE = 2 * SE`; paired comparisons also report the empirical paired-delta SE.
- A verdict: `improvement` / `regression` / `no-significant-change` / `inconclusive-below-noise-floor` at α = 0.05. A delta is actionable only when its absolute value exceeds both the stated MDE and `2 * paired SE`; otherwise the comparator is inconclusive even if the point estimate looks favorable.
- **Multiple-comparison correction.** A sweep compares many configs at once; reporting each delta at α = 0.05 inflates false positives. Apply **Bonferroni** (or Holm) correction across the comparison family. The risk is concrete, not theoretical: in the KB survey, a study of ranking comparisons found a naive binomial test marked all 4 primary comparisons significant, while a corrected **wild-cluster bootstrap** left only 1 surviving Bonferroni (`[KB: llm-as-judge/2605.27789]`). We adopt the wild-cluster variant when queries cluster by dataset/domain (the BEIR matrix does), since per-query results within a dataset are not independent.
- **Noisy-label correction for the §5 LLM-grader leg.** Bootstrap over LLM-graded labels (not human qrels) is biased: an AI-generated-label study measured naive-bootstrap CI coverage as low as **15%** vs the nominal 95%, fixed by a coupled-label bootstrap with variance correction (`[KB: labor-market-intel/2604.23770]`). The §5 e2e comparator therefore uses the bias-corrected variant; the §3 BEIR comparator (human qrels) keeps the plain paired bootstrap.

This is the arbiter for every roadmap decision and for the gate's "is this a real regression" question. It lives next to `benchmarks/budget-diff.ts` (the established two-run comparison pattern) and reuses its CLI shape.

### 4. The CI quality gate

Mirror the latency `budget-diff` gate for quality:

- A committed **baseline** under `benchmarks/results/beir/baseline/` per `(dataset × mode)` for the CI subset (§2), tagged with the commit + env that produced it.
- On every PR touching retrieval code (`src/search-core.ts`, `src/hybrid-retrieval.ts`, `src/reranker.ts`, `src/lexical-*.ts`, `src/faiss-*.ts`, chunking config), CI runs the CI-subset sweep (lexical + dense via `fake`/Ollama as available) and fails if **nDCG@10 drops below `baseline − tolerance`** on any subset dataset, where the drop is **statistically significant** per §3 and clears the MDE/`2 * SE` noise floor. A below-tolerance dip below that floor is reported as `inconclusive-below-noise-floor`, not pass or fail — avoids flaky gates and prevents accepting noise as signal.
- Baseline updates are an explicit, reviewed commit (`chore(bench): update BEIR baseline`), never automatic — the same discipline as latency baselines.

The gate runs the credential-free path (lexical always; dense via `fake` provider for determinism) so it is hermetic. Full-provider sweeps are a manual/release job, not per-PR.

### 5. End-to-end RAG eval — protect the product, with zero human labels

Retrieval metrics can improve while answers get worse (e.g. a reranker that promotes keyword-dense but unhelpful chunks). `kb ask` is the product surface; it needs its own eval. The dimensions to cover:

- **Faithfulness** — is the answer supported by the retrieved chunks (no hallucination)?
- **Answer correctness/relevance** — does the answer address the question, correctly?
- **Context precision / recall** — did retrieval surface the supporting passages? Context *precision* (fraction of retrieved chunks the answer actually uses) is a required metric, not optional: a too-large chunk size can keep faithfulness high while drowning the answer in irrelevant context, and a precision metric is what catches that chunking regression.

**Design constraint: this eval uses no human-annotated labels.** Human labels cost human time and carry their own position/anchoring/fatigue biases; we get correctness signal from *gold-bearing public datasets* and *automated cross-checks* instead, and we make the LLM judge a calibrated, bias-measured component rather than an oracle. The scheme is a four-tier cascade, deterministic-first so the LLM is used only where nothing cheaper can decide:

**Tier 1 — deterministic reference metrics (no model in the loop).** Use QA datasets that ship gold answers *and* gold supporting facts: HotpotQA (gold supporting sentences), NQ/2WikiMultiHop (short gold answers). Compute exact-match + token-F1 against the gold answer, and **context recall/precision against the gold supporting facts** — fully mechanical, the most trustworthy signal we have, and reference-based scoring beats reference-free proxies for tasks with a known answer (`[KB: llm-as-judge/patterns/multi-metric-9dc1219e]`). This already covers answer-correctness and context-recall/precision for short-answer QA without any judge.

**Tier 2 — automated model metrics, no judge prompt.** For the residue Tier 1 can't score mechanically (long-form prose, paraphrase): an **NLI/entailment model** scores faithfulness by checking each answer claim is entailed by the retrieved context (a different model family than the judge, so it cross-checks rather than echoes), and **semantic metrics (BERTScore/COMET)** stand in for lexical overlap on open-ended text (`[KB: llm-as-judge/2601.07648]` recommends semantic metrics as substitutes — we adopt that point while deliberately *declining* its companion recommendation to retain human review, see the tradeoff note below).

**Tier 3 — multi-judge panel with unsupervised calibration.** Only the genuinely subjective residue reaches an LLM judge, and never a single one: single LLM judges are "systematically unreliable… necessitating multi-judge ensembles… to cancel out individual model idiosyncrasies" (`[KB: llm-as-judge/patterns/ensemble-18ebf3ec]`). Use a **panel of ≥3 distinct model families** (e.g. DeepSeek + two others via the existing provider abstraction), aggregate by majority/mean, and derive a **confidence signal from self-consistency** — K independent samples per item, agreement fraction as confidence (`[KB: llm-reasoning/patterns/self-consistency-9b2743f5]`). Calibration is **unsupervised, not human**: run offline self-consistency sampling on the unlabeled eval set and distill a single-pass calibrated confidence predictor (ridge/isotonic), exactly the label-free recipe in `[KB: llm-reasoning/2604.19444]`. Low-confidence items are reported as *abstentions*, not silently scored. Per-judge prompts still apply double-query A/B–B/A ordering and an independent multi-dimensional rubric (`[KB: llm-as-judge/2604.22891]`).

**Tier 4 — automated bias quantification (the substitute for human calibration).** Instead of validating the judge against humans, we **measure its bias against constructed ground truth that needs no annotation**: programmatic probes whose correct verdict is known by construction — position bias = A↔B swap flip-rate (target <10%), verbosity bias = pad a Tier-1-correct answer with filler and measure score drift, self-preference = judge-on-self vs judge-on-other on items with known gold answers. These yield per-judge bias coefficients automatically, which are subtracted from scores; the statistical frame for separating bias from capability is `[KB: llm-as-judge/2604.22891]`. A judge whose probe bias exceeds a threshold is dropped from the panel — no human in the loop. Re-running the probes after any prompt change *verifies* the debiasing held.

**Provenance.** The §7 ledger records the panel composition, each grader model + exact prompt version, the self-consistency K, and the measured bias coefficients with every score, so cross-run comparisons are only made within the same eval configuration.

This is a RAGAS-style scorecard, run on release sweeps (not per-PR — it costs model calls). It is the veto on retrieval changes: a retrieval gain that drops faithfulness/correctness does not ship.

**Honest tradeoff of going human-free.** Tier 1 is bedrock and Tiers 2–4 are well-grounded, but removing humans genuinely loses something: automated proxies can miss *subtle semantic hallucination* (grammatical, fluent, factually wrong in a way no gold answer or NLI premise catches) and *reasoning-chain errors* (right steps, wrong conclusion). We accept this by **scoping the eval to objective-ground-truth datasets** — short-answer/multi-hop QA with gold answers and gold supporting facts, where Tier 1 carries most of the weight and the judge panel only breaks ties. We do *not* claim a formal correctness guarantee on open-ended generation; for that, the mitigation is a domain-specific verifier (symbolic/NLI), not a human pass.

### 6. The generalization guardrail

The product promise is *general knowledge research*. The program is structured so leaderboard climbing cannot quietly erode it:

1. **Tune on dev, report on test.** Hyperparameter search (RRF `c`, rerank `topN`, chunk size, fetch multiplier) runs on dev splits only via the existing Optuna integration (`bench:tune`), pointed at BEIR dev. Reported numbers are test-split. A config tuned on test is a defect.
2. **Headline = multi-domain mean.** Per §2, the quoted number is the average across the BEIR matrix. This is the anti-overfitting metric by construction.
3. **The e2e RAG eval (§5) is a hard veto.** No retrieval change ships if it regresses faithfulness/answer-correctness on the held-out product eval.
   The veto must use the same MDE/`2 * SE` noise-floor contract for aggregate scorecard metrics: below-floor deltas are inconclusive, not pass/fail evidence.
4. **Zero-shot only, until proven otherwise.** BEIR and BRIGHT are zero-shot benchmarks; we run them zero-shot. Any future domain adaptation / fine-tuning is gated behind a separate RFC that must report zero-shot BEIR *and* e2e RAG numbers side-by-side with the adapted numbers.

Per the KB survey, the four checks above are necessary but **not sufficient** — "tune on dev, report on test" still permits *within-zero-shot* overfitting (tuning on BEIR dev for the express purpose of climbing BEIR test). Practitioners harden this with explicit structural probes (`[KB: llm-generalization/2605.16819]`, `[KB: llm-generalization/2605.11518]`):

5. **Track a generalization gap.** Report **Δ_g = (score_seen − score_unseen) / score_seen** between the tuned/dev datasets and a held-out **unseen-generality set** — a subset of BEIR datasets reserved *and never tuned on*, distinct from the per-dataset test split used for the headline. A widening Δ_g is the overfitting alarm that a multi-domain mean alone hides.
6. **Contamination controls.** Public benchmarks leak into pretraining corpora. Exclude dataset names from any LLM-grader/judge prompt (`[KB: llm-generalization/2605.11518]` excludes dataset names to prevent pretraining-leakage cueing), and record a per-dataset contamination note in the registry (known-in-pretraining? expert vs crowdsourced qrels?). For Tier-3 GPL specifically, the query-generation stage runs on the corpus and can leak corpus signal into the eval — its generated queries must be held disjoint from any reported test split.

### 7. Reproducibility ledger

Every benchmark run is an MLflow run (`benchmarks/observability/mlflow.ts` already exists): logged with the git SHA, full env (model IDs, RRF `c`, rerank model/topN, chunk size/overlap, contextual on/off), per-dataset metrics, latency percentiles, and the TREC run-file artifact. A public "top ranking" claim is only credible if any third party can reproduce it from a commit + env; the ledger is that contract. The existing `benchmarks/compare/` HTML report becomes the human-facing leaderboard view across runs.

### 8. Public-benchmark targets and submission paths

Sequenced per the ratified ambition — **BEIR → BRIGHT → MTEB**:

- **BEIR (headline, M2).** We compete as a *retrieval system* (hybrid + rerank + contextual), not just an embedding model. Deliverable: a reproducible full-matrix report + TREC run files published in-repo, with the methodology note that this is a local reproduction, not a gamed leaderboard submission. The honest framing — "retrieval pipeline result" — is our strength, since the pipeline is the differentiator.
- **BRIGHT (M3).** Reasoning-intensive retrieval (2024), where pure dense retrievers underperform and rerank / LLM-in-the-loop helps — directly the strength of RFC 018/019 plus the roadmap's listwise rerank. Less saturated → realistic top-tier standing. Needs a BRIGHT dataset adapter alongside the BEIR one (same runner seam, different qrels/format).
- **MTEB (M4).** This ranks the *embedding model*, not our pipeline. The path is to run the official `mteb` package against our active embedding model (Qwen3-Embedding-0.6B and any successor under RFC 013) and, if the result is competitive, open the leaderboard PR. This governs **model selection** more than pipeline work, and feeds back into which dense model the product defaults to.

### 9. The retrieval-technique roadmap (sequenced behind the harness)

Each item below is gated by §3/§5 and (for the large ones) deferred to its own RFC. They are listed in expected payoff-per-effort order so the harness can adjudicate them empirically:

**Tier 0 — already built, just measure (this RFC's M0–M2):** dense/hybrid/rerank through BEIR; tune RRF `c`, rerank `topN`, and **chunk size/overlap** on dev. Expected to be the single largest recorded jump, for ~zero new retrieval code. **Chunk size is front-loaded into M0, not deferred:** the KB survey shows chunking/granularity is a *first-order* lever (hierarchical/multi-granularity retrieval alone yields ~+5% F1 over flat retrieval — `[KB: llm-agents/2604.12766]` NaviRAG — and the gain is convergent across multiple memory-system papers, `[KB: llm-memory/patterns/hierarchical-memory-b0e1b34e]`), yet it is *cheap* to test (reindex-only, no new retrieval code). The current `1000/200` split (`src/config/indexing.ts`) has never been measured against alternatives. A `chunk_size ∈ {500,1000,1500,2000} × overlap ∈ {100,200,300}` sweep on the CI subset is part of M0, reporting nDCG@10 *and* precision@10 (precision exposes chunk-boundary↔qrel-span mismatch — oversized chunks hit the qrel but dilute precision).

**Tier 1 — off-the-shelf, high payoff (downstream RFCs):**
- Reranker upgrade: `ms-marco-MiniLM-L-12-v2` → `bge-reranker-v2-m3` / `mxbai-rerank-large-v2` / `Qwen3-Reranker`. The KB survey supplies a concrete BEIR-grounded payoff for this path: augmenting **Qwen3-Reranker-4B** added **+1.54 nDCG@10 on BEIR-QA** (`[KB: llm-as-judge/2604.23734]` Prism-Reranker), making it the best-evidenced upgrade target. Pluggable via existing `KB_RERANK_MODEL`. **Critical caveat — reranking is not a universal win.** The KB survey found two independent cases where a cross-encoder *degraded* quality: skills-matching nDCG@5 fell 0.94 → 0.814 with significant added latency (`[KB: labor-market-intel/2605.01582]`), and reranking was "generally detrimental to functional correctness" in code retrieval, where BM25 beat dense and k=3 was optimal (`[KB: ai-software-engineering/2605.14503]`). BEIR is predominantly NL-QA where rerank helps, but the upgrade therefore ships only behind (a) a per-domain measurement gate and (b) a **skip-rerank fallback** for high-precision/lexical domains — never on by default for all corpora.
- Listwise LLM rerank over top-20 — natural extension of the RFC 018 judge; strong on BRIGHT/reasoning. The RankZephyr/RankGPT family is the well-known reference, but the KB survey surfaces a newer, stronger baseline: **QRRanker** (attention-head listwise scoring, no token generation → less hallucination/cost; a 4B backbone competitive with 32B, beating Qwen-Reranker/ReasonRank/GroupRank on multi-hop QA — `[KB: small-model-reasoning-training/2602.12192]`). Evaluate against QRRanker, not just RankGPT.
- HyDE + multi-query / RAG-Fusion — extends existing query-composition (`--plus/--minus`); strong on FiQA/HotpotQA/BRIGHT. Gate on a latency budget (each HyDE generation is an LLM forward pass) and sequence *after* cheaper query-side wins — instruction-tuned query prefixes and sparse/dense query routing — which the roadmap should test first.
- Score-normalized weighted fusion as an alternative to rank-only RRF (production precedent: min-max normalization + weighted blend, `[KB: job-search-agents/2605.27656]`). Note RRF is magnitude-insensitive while weighted fusion assumes comparable score distributions and needs a tuned blend per corpus — so it is a *dev-tuned* candidate, not a drop-in.

**Tier 2 — architectural, top-of-leaderboard (downstream RFCs):**
- Late-interaction / multi-vector (ColBERTv2 + PLAID) as a retrieval *tier* under the RFC 006 tiered-retrieval frame. **Note:** the "tops BEIR/LoTTE" claim is from training knowledge, *not* KB-verified (the KB survey returned no ColBERT/SPLADE material) and must be confirmed by a standalone eval on our own harness before any Tier-2 investment — the KB's silence is a weak signal that dense+rerank hybrids may have displaced it.
- Learned-sparse (SPLADE) leg alongside BM25 in the hybrid — same verification caveat as ColBERT (no KB grounding; confirm on-harness first).
- Late chunking (Jina) + semantic/proposition chunking. The "complements RFC 017, cheaper" claim is *unverified*: late chunking trades ingest-time preface generation for inference-time span work and is not inherently cheaper. Run it as an early A/B against the RFC 017 contextual-preface baseline on the CI subset (cost + nDCG side by side) before committing it to a tier.
- Matryoshka embeddings for a cost/quality dial.

**Tier 3 — domain adaptation (gated, downstream RFC):** unsupervised GPL per-KB, behind the §6 guardrail (must report zero-shot + e2e numbers).

## Milestones and acceptance metrics

| Milestone | Deliverable | Acceptance metric |
|---|---|---|
| **M0** | BEIR runner supports `dense` + `hybrid` modes (calling `src/` paths); CI-subset baselines recorded; **chunk size/overlap sweep** (Tier-0) | SciFact `hybrid` nDCG@10 recorded and **> lexical 0.669** by a §3-significant margin; chunk-size sensitivity curve (nDCG@10 + precision@10) recorded on ≥2 CI datasets |
| **M1** | `hybrid+rerank` + `+contextual` modes; bootstrap/t-test comparator with Bonferroni/wild-cluster correction (§3) | Each enabled stage's contribution on the CI subset is measured and significance-tested *with multiple-comparison correction* (gain or no-change, per stage) |
| **M2** | Full BEIR matrix sweep + MLflow ledger + `compare/` leaderboard view; **BEIR headline** report; per-domain breakdown + Δ_g vs unseen-generality set (§6) | Multi-domain mean nDCG@10 for the shipped pipeline recorded and reproducible from commit+env; Δ_g reported |
| **M3** | CI quality gate live; **BRIGHT** adapter + report | Gate fails a seeded regression in test; BRIGHT nDCG recorded for hybrid+rerank vs dense baseline |
| **M4** | End-to-end RAG eval, **fully human-label-free** (Tier 1 gold-answer/supporting-fact metrics → Tier 2 NLI/semantic → Tier 3 multi-judge panel w/ unsupervised self-consistency calibration → Tier 4 automated bias probes — §5); **MTEB** submission of active embedding model | e2e scorecard recorded on held-out gold-bearing QA; panel self-consistency confidence + per-judge probe-measured bias coefficients reported (no human labels); MTEB result obtained for the default model |
| **M5** | First Tier-1 technique adjudicated through the full harness | A ship/no-ship decision backed by §3 significance, stated MDE, observed delta vs `2 * SE`, and §5 e2e veto (+ per-domain gate for reranker changes) |

### M4 implementation note

The four-tier cascade lands under `benchmarks/rag-eval/` and the MTEB submission
under `benchmarks/mteb/` + `benchmarks/mteb_submit.py`:

- **Tier 1 — deterministic reference metrics** (`benchmarks/rag-eval/reference.ts`):
  SQuAD-normalized exact-match + token-F1 against gold answers, and context
  recall/precision against gold supporting facts. No model in the loop.
- **Tier 2 — automated model metrics** (`benchmarks/rag-eval/model-metrics.ts`):
  an injected NLI/entailment model scores faithfulness claim-by-claim; an injected
  BERTScore/COMET model scores open-ended text. Deterministic token-overlap stubs
  make the tier hermetic in tests.
- **Tier 3 — multi-judge panel** (`benchmarks/rag-eval/panel.ts`,
  `benchmarks/rag-eval/judges.ts`, `benchmarks/rag-eval/calibration.ts`): ≥3
  distinct judge families over the existing provider abstraction, majority/mean
  aggregation, double-query A/B–B/A ordering + multi-dimensional rubric,
  self-consistency confidence distilled into an **unsupervised** isotonic/ridge
  calibrator, low-confidence items abstain.
- **Tier 4 — automated bias probes** (`benchmarks/rag-eval/bias-probes.ts`):
  position (A↔B flip-rate), verbosity (filler-padding drift), self-preference
  (judge-on-self vs -on-other); per-judge coefficients subtracted, over-threshold
  judges dropped. No human in the loop.
- **Cascade + scorecard** (`benchmarks/rag-eval/cascade.ts`,
  `benchmarks/rag-eval/scorecard.ts`): deterministic-first routing; the scorecard
  records panel composition, self-consistency K, calibration method, and per-judge
  bias coefficients (§7 provenance). Unwired tiers leave items *pending* — never a
  fabricated score. Runner: `npm run bench:rag-eval` (`--fake` is a hermetic
  self-test).
- **MTEB** (`benchmarks/mteb_submit.py`, `benchmarks/mteb/registry.ts`,
  `benchmarks/mteb/result.ts`, `benchmarks/mteb/run.ts`): the Python helper runs
  the official `mteb` package against the active embedding model
  (`Qwen/Qwen3-Embedding-0.6B`, RFC 013 default); the TS side records the per-task
  + mean main scores and logs the §7 ledger. `npm run bench:mteb:submit` then
  `npm run bench:mteb`.

A fully-populated run needs the gold-QA datasets, an NLI checkpoint + a
BERTScore/COMET model, ≥3 live judge families, and the `mteb` package with the
embedding model served; where those are unavailable the machinery + unit tests
ship and the scorecard self-describes which tiers ran.

## Evidence base & provenance

This RFC was reviewed against the project's own knowledge bases via a six-domain `kb-scout` survey (eval/benchmarks, dense/fusion, rerank/late-interaction, chunking, e2e/generalization, and human-label-free judge reliability). Two provenance facts must travel with the document:

1. **The KBs contain no core IR-benchmark material.** Direct queries for BEIR, BRIGHT, MTEB, LoTTE, ColBERT, SPLADE, and classical IR metrics returned misses or off-topic hits across all five surveys. Consequently, the **leaderboard-specific claims in this RFC are from model training knowledge, not KB-verified**, and remain to be confirmed by a web pass before any are published: the SciFact reference band (~0.74–0.77 for dense+rerank), the BEIR full-dataset list and its version/qrels, "ColBERT/SPLADE top BEIR/LoTTE," current top reranker/embedding model names, and the `mteb` package behavior. Treat every such figure here as a hypothesis the harness (or the web) must verify.

2. **The KB-grounded claims are tagged inline** with `[KB: shelf/note-id]`. These come from *adjacent* literature the KBs do hold — LLM-as-judge reliability, memory/chunking granularity, generalization methodology, statistical correction, and a handful of reranker results that happen to report BEIR numbers. Several were surfaced independently by 2–3 of the five scouts (e.g. cross-encoder degradation on code/skills tasks, the Qwen3-Reranker BEIR delta), which raises confidence. Per the kb-scout honor-system caveat, any `[KB: …]` citation that becomes load-bearing for an implementation decision should be re-read at source before it is acted on.

## Failure modes

- **Benchmark-only retrieval path drifts from production.** Mitigation: modes call `src/` (search-core/hybrid/reranker) directly — never a harness reimplementation. A unit test asserts the runner invokes the production search entrypoint.
- **Flaky gate from non-determinism (ANN noise, model nondeterminism).** Mitigation: CI gate uses the `fake` deterministic embedding provider for dense; only *significant* drops fail (non-significant dips are reported). Full-provider runs are release-only.
- **Overfitting to the CI subset.** Mitigation: tune on dev splits; headline is the full-matrix mean; CI subset is a regression tripwire, not the optimization target.
- **e2e RAG eval cost/instability (multi-judge panel).** Mitigation: deterministic Tier-1 gold metrics carry most items so the panel only adjudicates the residue; release-only cadence; cache verdicts (RFC 018 pattern); report panel composition + per-model prompt version + self-consistency K in the ledger so scores are comparable across runs.
- **Judge-trust without humans.** Risk: an automated eval that trusts a biased judge is a veto built on noise. Mitigation: §5's deterministic-first cascade + automated bias probes (constructed ground truth) + unsupervised self-consistency calibration; judges exceeding a measured bias threshold are dropped from the panel. Residual risk (subtle semantic hallucination / reasoning-chain errors) is bounded by scoping the eval to gold-bearing QA datasets — stated explicitly in §5, not hidden.
- **Public claim is unreproducible.** Mitigation: §7 ledger — no number is published without a commit+env+artifact triple.
- **Dataset licensing / size.** BEIR/BRIGHT datasets are large and have varied licenses. Mitigation: datasets are fetched to a gitignored cache (`benchmarks/.cache/`), never vendored; the registry records source + license per dataset.

## Open questions

1. **CI dense path:** is the `fake` provider faithful enough to gate dense regressions, or does the gate need a tiny real model (e.g. bge-small via transformers.js) for representativeness? Lean: start with `fake`, revisit if it misses real regressions.
2. **Gate tolerance:** absolute nDCG delta vs relative %? Lean: relative %, with an absolute floor on tiny datasets.
3. **BRIGHT before or after the CI gate?** M3 currently bundles both; they are separable if BRIGHT adapter work slips.
4. **MTEB as a system vs model:** MTEB ranks models; do we also want a public "retrieval system" result page (BEIR-style) as our primary external artifact? Lean: yes — the pipeline is the differentiator, MTEB is secondary.
5. **Where does the e2e RAG QA set come from** — public (NQ/HotpotQA) only, or also a curated in-domain set reflecting real `kb` usage? Lean: both, reported separately.
6. **Panel size/composition for §5.** How many judge families, and which, to balance bias-cancellation against cost? Lean: ≥3 distinct families via the existing provider abstraction; size set at M4 by the point where adding a judge no longer moves the self-consistency confidence or the probe-measured bias. (Note: human calibration is explicitly out — calibration is unsupervised self-consistency + automated bias probes per §5.)
7. **`fake`-provider faithfulness for chunk-size gating.** The M0 chunk-size sweep needs a real embedding model to be meaningful (the `fake` provider has no semantic geometry), so the sweep is an Ollama/release job, not a per-PR `fake` gate. Confirm this split holds as more Tier-0 knobs move into CI.

## Alternatives considered

- **Keep lexical-only BEIR, add dense as a one-off script.** Rejected: a one-off doesn't compose with the gate, the ledger, or the matrix, and re-implements retrieval outside `src/` (the exact faithfulness trap).
- **Adopt an external eval framework (RAGAS/ARES/BEIR-PyPI) wholesale.** Rejected as the primary path: our harness already maps `kb` → qrels and emits TREC files, and must call our TS retrieval code; a Python framework would re-implement retrieval. We *borrow their metrics/datasets* (and use `mteb` for the MTEB submission specifically) but keep the runner in-repo.
- **Fine-tune to top a single benchmark fast.** Rejected: directly violates the generalization promise; deferred to a gated Tier-3 RFC at best.
