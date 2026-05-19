# RFC 018 — Context Relevance Gating

**Status:** Accepted (v4 — 3 critic rounds + empirical probe; user-ratified 2026-05-17 — see "Ratified decisions")
**Depends on:** RFC 009 (error taxonomy), RFC 010 (MCP surface), RFC 015 (warm-LLM endpoint discovery), #206 (hybrid RRF), #358 (`--explain-empty`)
**Related:** ADR 0006 (injection-guard — the existing post-retrieval inspection stage)
**Tracks:** context pollution — irrelevant retrieved chunks injected into the consuming agent's context window

## Problem

`retrieve_knowledge` (MCP) and `kb search` return the top-`k` results ranked by similarity, subject only to a per-result `--threshold` cap. Every surviving result is handed to the caller, and in an agent loop that means every surviving result is **injected into the model's context window**. But "ranked highest among what we have" is not "relevant to what the agent is doing." Two concrete pollution modes:

1. **No-good-answer queries.** When the KB holds nothing relevant, retrieval still returns its `k` best — a ranked list of near-misses. The agent receives plausible-looking but unrelated context and may anchor on it. A per-result `--threshold` helps only if a meaningful *absolute* cutoff exists; under hybrid RRF the fused score is rank-based (the per-rank RRF contribution is ≈ 0.016 at rank 1 with c=60; inter-rank spacing is ~0.00026 — both are uninformative as an absolute relevance signal).

2. **Topically-near but task-irrelevant chunks.** A chunk can sit close to the *query string* in embedding space yet be useless for the *current task*: wrong API version, wrong subsystem, a historical tangent. Similarity is query-aware; it is not task-aware. The retriever never sees what the agent is actually trying to accomplish.

### The evidence is genuinely mixed — and that shapes the whole RFC

It would be dishonest to present "irrelevant context pollutes, therefore gate it" as settled. The literature cuts both ways:

- **For gating:** removing irrelevant context measurably helps some agentic consumers — decoupling inspection from planning context cut non-cached input tokens ~34% and lifted task resolve rate ~2pp in one coding-agent study; bounded-context ablations have shown catastrophic regressions when injection is *un*bounded.
- **Against gating:** other agentic-memory ablations find the precision/recall trade-off "skews decisively toward recall" — relaxing the similarity threshold and feeding a *broader, noisier* candidate set produced the single largest improvement in a five-stage ablation. Precision filtering has matched a noisier set on final answer quality.

The honest reading: whether injected-but-irrelevant context hurts depends on the consumer, the task, and the *kind* of noise. The failure case is the **confident no-good-answer** — a tidy ranked list that *looks* authoritative when the KB simply had nothing.

This has a hard consequence. **The gate can only remove results; it can never add one.** So it is *recall-negative by construction*: a false-keep is a no-op (no worse than today), but every false-drop is a strict regression. Its entire value is removing *genuine* noise without dropping genuine answers — an empirical claim about a specific corpus and judge, not a foregone conclusion. The RFC therefore adopts a **validate-before-build** posture (see "Guiding principle") with an M0 validation gate that must show *downstream answer* benefit before any machinery is built.

### What the codebase already has

- A per-result `--threshold` and `--threshold=auto` knee detector (`computeAutoThreshold`, `src/search-core.ts:73-107`).
- A hybrid path that already runs dense + a BM25 **lexical leg** and fuses them (`src/hybrid-retrieval.ts`, `src/rrf.ts`, #206). The lexical leg matters below: it is a retrieval signal genuinely independent of dense embedding distance.
- `--explain-empty` diagnostics for the zero-result case (#358).
- A warm local LLM over an OpenAI-compatible endpoint (RFC 015) and an LLM client (`src/llm-client.ts`).
- An **injection-guard** stage (`src/injection-guard.ts`, ADR 0006) that already inspects retrieved content post-retrieval, pre-caller — precedent that a post-retrieval inspection stage is accepted architecture.

What is missing: a stage that decides, over the candidate **set**, whether the retrieved context is relevant *enough to inject at all* — and that may answer **"inject nothing."**

## Goal

Add a **relevance gate**: a post-retrieval, pre-injection stage that takes the retrieved candidate set plus an optional description of the current task, and returns a *gated* set — possibly empty — with a machine-readable verdict explaining what was dropped and why.

Concretely:

- Make **"inject nothing"** a first-class, well-typed outcome, distinct from an error and from an empty index.
- Make the gate **task-aware**: callers may pass a `task_context` string; when present, an LLM judge scores candidates against the *task*.
- Keep the gate a **short cascade**: one cheap statistical floor, then *either* a statistical knee (no task context) *or* an LLM judge.
- **Fail-degraded**: any *judge-stage* failure falls back to the statistical path. The gate never blocks retrieval, and never returns empty *because the judge failed*.
- Never suppress all context on a single signal: a truly empty result requires the LLM judge **and** the independent lexical-retrieval signal to agree (Design §6).
- Feature-gate behind `KB_RELEVANCE_GATE=off|on` (off by default — behavior identical to today), with a per-call override for diagnostics.
- Define the **consumer contract** for a Kookr context-injection hook, including a schema artifact so the cross-repo contract is machine-checked.

**Non-goals:**

- **Reranking / reordering.** The gate decides keep/drop, full stop. It emits no ordering signal (v2's "advisory order" was cut in v3 — see Alternatives). A cross-encoder reranker is a separate RFC.
- **Redundancy/dedup as a gate stage.** Cut in v2; see Alternatives.
- **Gating Kookr memory recall / checkpoint injection.** The gate is KB-retrieval-specific. The session-level multi-source budget arbiter is named in "Future direction," not built here.
- **Query rewriting / HyDE / decomposition.**
- **Replacing `--threshold`** (it stays as a per-result cap ahead of the gate) or **changing ranking/fusion** (#206 unchanged).
- **A self-improvement learning loop.** §12 commits only a log schema; the loop is a committed *follow-on* RFC, conditional on M1.

## Guiding principle — validate before build

The gate is recall-negative by construction, so the expensive/risky parts are gated behind a cheap empirical check. **M0 is a concrete deliverable, not a vibe** (round-2 delivery critique — v2's M0 had no harness). M0 fully specified:

- **Query set:** queries whose has-answer / no-good-answer ratio **matches observed production** (do not curate toward no-good-answer — that flatters the gate where it shines and hides the false-drop regression), sourced from real `kb search` canonical logs where possible. Drawn from **at least two structurally different KBs** — e.g. a code/ops KB and a prose KB — because whether gating helps is corpus-specific (round-3 socratic); a single-corpus M0 does not license M3 ("default on") for all corpora.
- **Ground truth:** human-labeled expected answers, or held-out reference-answer span match. If an LLM grader is used it is blinded to condition, and **its own human agreement is measured and pre-registered as an admissibility threshold first** — a grader whose agreement is near the documented ~0.44–0.62 noise floor cannot resolve a small effect and disqualifies the run (round-3).
- **Conditions:** a consuming agent answers each query (a) with the raw top-`k` and (b) with the gated set. The agent runner is a thin script around `kb ask` / an MCP client; M0 builds it (~1 week if scoped to this).
- **Pass criterion (pre-registered, *directional* — round-3 design-minimalist).** M0 is honestly a go/no-go *directional* check, not a statistically-powered gate: at a realistic M0 sample size a small per-bucket effect cannot carry a tight confidence interval, so the RFC does not pretend to one. A pass requires, reported as *separate buckets*: (1) no-good-answer answer correctness trends **up** by at least a pre-set ε; (2) has-answer correctness does **not** trend down. A single aggregate number is not accepted. M1 is the powered measurement.
- **M0 must also report three pre-registered numbers** (round-3 — these decide *which* parts of the gate are worth shipping, not just whether to ship): (i) the **empty-verdict fire rate** — how often `no-relevant-context` actually fires; if it is near-zero the gate is effectively just A1+A2 tail-trimming (≈ `--threshold=auto`) and most of §6 is dead weight; (ii) the **per-chunk-drop contribution isolated from the empty-verdict contribution** — run a condition with the empty verdict disabled, since per-chunk dropping is the part the literature is most skeptical of and it must justify itself separately; (iii) the **judge false-empty rate** on the "answer-present-but-distant" fixtures (§6 residual risk).

Per the user's ratified decision (the context-dilution / context-rot harm of injecting irrelevant content is accepted as real — see "Ratified decisions"), the implementation chain **runs straight through**: M0 does not halt it. M0 still gates *configuration*, not existence — if report (i) shows the empty verdict rarely fires or (iii) shows its false-empty rate is unacceptable, the gate ships with the **empty verdict disabled** (per-chunk drops + `low-confidence` rescue only); a clearly negative M0 is surfaced loudly for the user before M3 (default-on). M0a/M0c build regardless; every milestone is *informed* by M0.

## Design

### 1. Where the gate lives, and the task-context problem

The gate is a stage *inside* the kb-mcp-server (`src/relevance-gate.ts`), shared by the MCP `retrieve_knowledge` handler and `kb search`. It runs **after** retrieval + fusion + injection-guard and **before** result assembly.

It is a **KB-retrieval-specific module** (round-2 design-minimalist: v2's "source-agnostic" abstraction had one caller and already leaked — Stage A1 needs a dense distance, a KB-retrieval concept). The future multi-source arbiter (see "Future direction") will extract a generic interface *then*, against a real second caller — a cheap refactor, cheaper than guessing the abstraction now.

The hard part: the statistical stages need only the candidate set, but the LLM judge needs to know *what the agent is doing* — and the server only receives a query string. So:

- MCP `retrieve_knowledge` gains an optional `task_context` parameter (string, hard-truncated to 2000 chars).
- `kb search` gains `--task-context=<str>` and `--task-context-file=<path>`.
- When `task_context` is **absent, empty, or degenerate** (< 8 tokens after normalization), the gate runs the **statistical path only** (A1 + A2), logged as `judge.skipped: <enum reason>`.

### 2. The cascade

One cheap statistical floor, then a branch. **Within the cascade every stage only removes candidates — no stage reorders, and no stage resurrects a candidate a prior stage dropped.** The `low-confidence` rescue (§6) is explicitly *not* a cascade stage; it is a terminal safety net, and §2's no-resurrection rule does not govern it.

```
retrieval + fusion + injection-guard  →  candidate set
        │
        ▼
  A1  Absolute floor          (universal; cannot empty the set alone — §6)
        │
        ▼
   branch on task_context:
   ├─ absent / degenerate ──▶  A2  Distribution knee   ──▶ keep set
   └─ present (≥ min signal) ─▶ B  LLM relevance judge ──▶ keep set
                                     (on B failure → fall back to A2; never empty-because-judge-failed)
        │
        ▼
  §6  Empty-verdict guard (LLM judgment + independent lexical signal must agree)
  §6  low-confidence rescue (terminal net: re-admit top-1 if the cascade emptied the set unsafely)
```

A1 is universal. A2 and B are *alternatives* for "which survivors are relevant" — never stacked.

### 3. Stage A1 — Absolute floor

Drops candidates whose *native dense distance* is worse than `KB_GATE_SCORE_FLOOR`. Empirical probing on `nomic-embed-text` over four KBs found a clean separation: in-domain top-1 distances 0.43–0.74, out-of-domain 1.00–1.09. **Default `0.95`** (v1's 1.10 sat above every out-of-domain query tested — a near-no-op; corrected by the probe). M1 re-tunes per corpus.

**Dense distance is supplied via a side-channel, not a `FusedResult` change** (round-2 delivery critique — v2's plan to add `denseDistance` to `FusedResult` shipped a public-type change *outside* the feature flag, breaking the "rollback = clear the flag" claim). Instead: the dense leg already produces scored documents whose `.score` is the FAISS distance; `fuseHybridResults` (`src/hybrid-retrieval.ts`) is extended to *also* return a `Map<chunkId, number>` of dense distances built from the dense leg **before** RRF overwrites `.score` with the fused score. `rrf.ts` and the `FusedResult` interface are untouched. The gate consumes `{ results, denseDistanceById }`. A candidate absent from the map is lexical-only — it has no dense distance and is **passed through A1 unfiltered**; A1 asserts that any candidate the dense leg *did* contribute has a finite distance (a missing-but-expected distance is a programmer error and throws, rather than silently disabling A1).

Honest limitation: `resolveAutoSearchMode` auto-selects hybrid mode for identifier / path / error-code queries (`src/search-core.ts:33-50`) — exactly the query class agents issue most against a code/ops KB — so a meaningful fraction of real queries have lexical-only candidates A1 cannot floor. The lexical leg is instead used as the *independent witness* for the empty verdict (§6), which is where it carries real weight. M1 also calibrates a normalized-BM25 floor; whether BM25 normalizes cleanly is an Open question, and §6 is designed to degrade *safely* if it does not.

A1 **never emits the terminal empty verdict on its own** (§6).

### 4. Stage A2 — Distribution knee

The statistical relevance decision when there is no usable task context. Reuses `computeAutoThreshold` (`src/search-core.ts`) to cut the long tail after the largest score gap.

**Input-contract caveat (round-1/2 finding).** `computeAutoThreshold` was designed for a raw FAISS top-K list; the gate feeds it a post-A1 survivor list that may be small or flat. M0a pins and unit-tests A2 on survivor lists of size 1, 2, 3 and flat distributions: size 1 → keep it; flat → keep all. **A2 alone never empties the set.**

### 5. Stage B — LLM relevance judge

Runs when `task_context` is present and above the minimum-signal threshold. **One batched LLM call** sees the task context, the query, and the surviving candidates (up to `KB_GATE_JUDGE_INPUT` = 10; if more survive A1, the lowest-ranked overflow is **kept un-judged**, never silently dropped — recorded with `stage: "B-input-overflow"`, consistent with bias-toward-keep). It returns JSON:

```json
{
  "overall": "relevant" | "partial" | "no-relevant-context",
  "verdicts": [
    { "id": "<id>", "decision": "keep", "reason": "<=12 words" },
    { "id": "<id>", "decision": "drop", "reason": "states v2 default; task pins v3 config" }
  ]
}
```

Design decisions, several driven by round-1/2 evidence:

- **Batched, not per-chunk** — the judge must see the whole set to recognize the no-good-answer case and keep `overall` coherent.
- **No self-reported confidence field** (round-2 consensus, failure-mode + design-minimalist). v2 had the judge emit a per-verdict `confidence` and downgraded low-confidence drops. The KB evidence is blunt: LLM self-reported confidence in structured output at `temperature 0` is saturated and uninterpretable (VERDI; validity-screening literature). v2's `KB_GATE_DROP_CONFIDENCE` constant gated behavior on a meaningless number. **Cut.** Bias-toward-keep is now *structural* (next two points).
- **Structural bias toward keep — the empty case.** The catastrophic false-drop is "drop everything." That is constrained by §6: the judge must *argue* emptiness with a specific-absence reason, the BM25 veto blocks an empty verdict whenever a lexical hit exists, and the statistical path can never emit empty at all.
- **Structural bias toward keep — the per-chunk case.** The judge is instructed that a `drop` MUST cite a *specific disqualifying fact* (a concrete contradiction or mismatch). The orchestrator validates this with a **token-overlap check** (round-3 design-minimalist, replacing v3's denylist): a `drop`'s `reason` must share at least one content term with the candidate's text, or it is downgraded to `keep`. A reason that names nothing in the chunk it claims to disqualify is, by construction, not citing a specific fact about that chunk. This is verifiable from the output and does not need a maintained phrase list. **Honest limit (round-3 failure-mode):** the check catches *contentless* drops; it does not catch a *content-specific but false* reason (a judge that hallucinates "states v2 default" about a chunk that says no such thing — the §7 example reason has exactly that shape). So this narrows per-chunk false-drops, it does not close them; M1 measures the residual rate on a human-labeled fixture set.
- **Multi-hop / synthesis queries** (round-2 failure-mode, CARE). Per-candidate keep/drop systematically false-drops chunks that are each *one necessary piece* of a multi-part answer. Mitigation: the judge prompt explicitly instructs "a candidate that is one necessary part of a multi-step or comparative answer is `keep`, even if incomplete alone"; and when the judge returns `overall: "partial"` it is treated as a synthesis signal — per-candidate `drop`s are **suppressed** and the full set is kept (the judge is saying the pieces combine).
- **Randomized presentation order; single call** (round-1/2/3 failure-mode + design-minimalist). Candidates are presented to the judge shuffled, addressed by stable `id` not rank position — this de-biases the *population* of verdicts. v3 specified an A/B-swapped *double* call for the empty verdict; round-3 review cut it: it doubles latency on the gate's most important path, the swap-disagreement branch was undefined, it collided with the cache key, and position bias for a *set-level* "is anything useful here" verdict is structurally weaker than for pairwise ranking. v4 makes a **single** shuffled call. The M1 position-swap probe measures whether the `no-relevant-context` verdict is in fact order-sensitive; *if it is*, the double call is reintroduced in M1 with data justifying it — not assumed now. The shuffle is seeded deterministically from the verdict-cache key (§9), so verdicts are reproducible.
- **The judge model must be capable, not merely fast.** The empirical probe falsified v1's "prefer a flash-class model": a 4B local model handled obvious cases but **failed the `no-relevant-context` path** — hallucinated keep-reasons, contradicted itself, returned `relevant` for a clearly no-context case. `no-relevant-context` detection is the gate's core value and the hardest path. The judge model is configurable (`KB_GATE_LLM_ENDPOINT`) but **must pass the M0/M0b `no-relevant-context` capability check**. Latency and capability genuinely trade off; M1 measures the per-deployment point.
- **JSON parsing is two-step.** Instruction-tuned models consistently wrap JSON in markdown fences (probe-confirmed). Parse = strip ``` fences then `JSON.parse`; on failure, one repair-reparse; on failure, degrade to A2.
- `temperature: 0`; `max_tokens` bounded for 10 verdicts.
- B may drop an A1 survivor but cannot resurrect an A1 drop.

### 6. The empty verdict — the judge's call, vetoable by lexical evidence

A truly empty result (`verdict: no-relevant-context`) is the gate's most dangerous output: per §11 the Kookr hook injects *silence*, so a wrong empty verdict is invisible by design. The design history here is instructive and worth stating plainly: v1's invariant was conditional on A1; v2 claimed "two independent stages (A1 + B)" and round-2 review rejected it (A1 dense-distance and an LLM judge read the *same* semantic signal — correlated); v3 claimed a BM25 "second independent witness" and **round-3 review rejected that too** — BM25 is independent of embedding *geometry* but is *query-scoped*, while the judge is *task-scoped*, so "judge says nothing AND BM25 says nothing" conflates two different propositions ("task-irrelevant" and "lexically-distant") rather than jointly establishing "no relevant context."

v4 stops chasing a second independent witness, because **there is no signal genuinely independent of an LLM task-relevance judgment that also speaks to task-relevance.** Instead it uses each signal only where it is logically valid:

**The empty verdict is the LLM judge's call** — and only the judge's. The gate emits `verdict: no-relevant-context` only when the LLM judge returns `overall: no-relevant-context` *and* the judge's `overall` reason passes the §5 token-overlap check naming a *specific absence* (e.g. "candidates cover the v1 and v2 token flows; task needs the v3 migration steps"). A bare "nothing here is relevant" is downgraded — emptiness must be argued, not asserted.

**BM25 is a veto, not a witness.** The lexical leg is consulted, but used *asymmetrically* — this is the round-3 correction. BM25 *finding a strong term-overlap hit* is genuine evidence the KB contains a lexically-matching chunk the dense judge may have wrongly dismissed → it **vetoes** the empty verdict, and the gate returns that hit flagged `low_confidence`. BM25 finding *nothing* is **not** treated as corroboration of emptiness (absence of lexical overlap is not absence of a relevant answer — a relevant chunk can be phrased in entirely different words). So the lexical signal can only ever *block* an empty verdict, never *cause* one. This makes BM25-normalization quality a non-blocker: a weak or inconclusive veto simply means the judge's call stands, which is the conservative-on-recall direction only in the sense that it does not *add* false-keeps — the honest consequence is that the empty verdict rests on the judge alone.

**The statistical path (no task context) never emits `no-relevant-context`.** Statistical signals alone are not trusted to suppress *all* context. If the statistical cascade would empty the set, the `low-confidence` rescue fires.

**The `low-confidence` rescue** is a terminal safety net — explicitly **not** a cascade stage, and explicitly exempt from §2's no-resurrection rule. When the cascade (or a vetoed/blocked empty verdict) leaves an empty set, the rescue re-admits exactly **one** candidate — the highest fused-score one — and the response carries `low_confidence: true`. It re-admits *across* all prior drops, including explicit Stage-B drops, by design: it is the gate saying "the system's single best guess, treat it with suspicion." Using the fused RRF score here is acceptable even though §Problem calls that score uninformative as an *absolute threshold* — this is a *single relative pick* ("rank 1"), not a cutoff, and rank-1-by-fusion is a defensible "best guess of last resort." A degraded judge (§8) can never reach the empty verdict — degraded ⇒ at minimum the top-1 `low_confidence` result.

**Residual risk, stated honestly (round-3 failure-mode + socratic).** Because v4 drops the second-witness claim, the empty verdict's correctness *is* the judge's correctness on the hardest path. The dangerous case is a real, task-relevant answer the judge wrongly rejects — and if that chunk is also lexically distant from the query, the BM25 veto will not save it. This is not a rare corner; for paraphrased or vocabulary-shifted answers it is the common shape. The honest position: the empty verdict is a recall-negative bet on judge quality, and **M0/M1 must measure it** — see the empty-verdict fire rate and correlated-false-empty metrics in the Migration plan. If M1 shows the judge's false-empty rate is unacceptable, the correct response is to ship the gate with the empty verdict *disabled* (per-chunk drops + `low-confidence` rescue only) rather than to add more witnesses.

### 7. The verdict object

Every gated response carries a `gate_verdict` — audit record and self-improvement signal (§12). Its schema is a published artifact (`src/relevance-gate-schema.ts`, §11).

```json
{
  "mode": "llm",
  "verdict": "injected",
  "low_confidence": false,
  "candidates_in": 9,
  "injected": 3,
  "dropped": [
    { "id": "...", "source": "...", "stage": "A1-floor", "reason": "dense distance 1.31 > floor 0.95" },
    { "id": "...", "source": "...", "stage": "B-judge",  "reason": "states v2 default; task pins v3" }
  ],
  "degraded": false,
  "judge": { "model": "<id>", "prompt_hash": "<hash>", "floor": 0.95 }
}
```

- `verdict ∈ { injected, no-relevant-context, empty-index, bypassed }`. **`empty-index`** (retrieval returned zero candidates — gate is a no-op) is structurally distinct from **`no-relevant-context`** (retrieval found candidates, the gate suppressed them all) — round-2 operability demanded these never look alike; a distinct verdict value *is* that structural distinction. `injected` = a set was returned. `bypassed` = gate off.
- `low_confidence: true` accompanies `injected` when the §6 rescue fired (replaces v2's separate `low-confidence` verdict state — round-2 design-minimalist: it is a flag on a result, not a caller-branch).
- `judge` carries the **reproduction inputs** (model id, prompt-template hash, floor value) — round-2 operability: a verdict that cannot be reproduced cannot be debugged.
- **MCP contract:** `gate_verdict` is a named top-level field of the `retrieve_knowledge` tool response, **always present** (carrying `verdict: bypassed` when the gate is off — an absent field and a `bypassed` field are different API contracts; the field is always there).
- Surfaced through: the MCP response; `kb search --format=json`; a one-line `kb search` markdown footer with a **by-stage** drop breakdown (`gate: injected — 3 kept, 6 dropped [A1:4 B:2]`); the full `dropped` list under `kb search --explain` (which prints a consistent record for *every* verdict type, including `bypassed`).
- Logged as canonical line `relevance-gate.decision` (§12).

### 8. Fail-degraded behavior

| judge-stage failure | detection | response |
|---|---|---|
| Stage B LLM unreachable / timeout | connection error / exceeds `KB_GATE_LLM_TIMEOUT_MS` | fall back to A2; `degraded: true`, with a `degrade_reason` enum. |
| Stage B malformed output | fence-strip + parse fails, then repair-reparse fails | fall back to A2; `degraded: true`. |
| Stage B verdict references an unknown id | id not in input | ignore that row, keep the candidate; `warn`. |
| `task_context` over the 2000-char budget / degenerate | length / token count | head-truncate, or run the statistical path; `judge.skipped: <enum>`. |

The gate **never**: blocks the response beyond `KB_GATE_LLM_TIMEOUT_MS`; returns `no-relevant-context` because the judge failed (a degraded call cannot reach the §6 empty verdict); throws on a gate-internal failure — a gate-internal exception is caught at the gate boundary and degrades to passing the raw retrieval set through with `verdict: bypassed` and an error log. A gate bug must never break retrieval.

### 9. In-memory verdict cache

A small in-memory `Map`, process-lifetime, bounded LRU (no disk tier — v2's L2 cache was cut: the key includes `task_context`, which changes nearly every turn, so cross-session hit rate is ~0). Key = `sha256(judge_prompt_template_hash | judge_model_id | normalize(task_context) | normalize(query) | sorted(candidate_content_sha256[]))`. `normalize()` is NFKC + trim + collapse-whitespace, unit-tested not to collide distinct contexts. The prompt-template hash is computed at process start from the actual template string — it cannot drift from the prompt. The cache stores the **resolved `gate_verdict`** (the gate's final decision after the §5/§6 orchestration), not the raw judge response — a cache hit replays the decision, it does not re-enter the orchestration with a stale intermediate. The §5 candidate shuffle is seeded deterministically from this key, so a recomputed verdict matches a cached one.

### 10. Configuration surface

Core env vars are listed below (`KB_GATE_DROP_CONFIDENCE` was cut with the confidence field).
Operator defaults, per-call overrides, and validation commands are summarized in
[`docs/feature-flags.md`](../feature-flags.md#relevance-gate).

| env var | default | effect |
|---|---|---|
| `KB_RELEVANCE_GATE` | `off` | `off` (identical to today) \| `on` (A1 + A2, or A1 + B with a task context). |
| `KB_GATE_SCORE_FLOOR` | `0.95` | A1 dense-distance floor (probe-corrected from 1.10). M1 re-tunes; also calibrates a normalized-BM25 floor. |
| `KB_GATE_LLM_TIMEOUT_MS` | `8000` | Stage B latency budget (probe: warm 10-candidate calls measured 4.2–4.6 s; 4000 ms would degrade nearly every call). |
| `KB_GATE_LLM_ENDPOINT` | (RFC 015 `KB_LLM_ENDPOINT`) | judge endpoint; model must pass the §5 capability check. |

Hard-coded constants: `KB_GATE_JUDGE_INPUT = 10`; `KB_GATE_TASK_CONTEXT_MAX = 2000`; minimum task-context signal = 8 tokens; degrade-rate alarm threshold = 10% over a rolling window (§12). CLI: `--gate=off|on`, `--task-context=<str>`, `--task-context-file=<path>`, `--no-gate` (per-call override), `--explain`. **Per-call override:** `retrieve_knowledge` accepts an optional `gate: "off"` parameter and `kb search` accepts `--no-gate`, so a client suspecting a bad gating decision can fetch the ungated set for one diagnostic call without touching server env (round-2 operability).

### 11. Kookr hook consumer contract

This RFC delivers the kb-mcp-server mechanism; the Kookr-side hook is cross-repo (Migration M2). The contract:

- Call `kb search "<query>" --gate=on --task-context-file=<task-summary> --format=json`.
- The **`task_context`** is a short description of the current task / turn (active `CHECKPOINT.json` `task_id` + `next_actions`, or the current user message). The hook assembles it.
- **Freshness contract.** The hook MUST stamp `task_context` with a monotonically-increasing turn id and MUST NOT reuse a context older than the current turn. A stale `task_context` makes the judge score against a finished task and silently false-drop — documented as a hook responsibility because the server cannot detect it.
- **Honor the verdict.** `verdict: no-relevant-context` → inject nothing (silence, not a notice). `verdict: empty-index` → inject nothing (and the absence of KB content is itself worth surfacing to the operator, distinct from suppression). `injected` with `low_confidence: true` → inject the result(s) but propagate the `low_confidence` flag onto each result item the agent sees, so an agent that does not parse `gate_verdict` still knows the context is weak. Inject only the post-gate set.
- **Surface, don't hide.** Echo `gate_verdict` (at least by-stage drop counts and `degraded`) to a collapsed/debug channel.

**Schema artifact (round-2 delivery — cross-repo contract enforcement).** The `gate_verdict` shape is exported as a validatable schema, `src/relevance-gate-schema.ts` (a Zod schema, also emitted as JSON Schema). An M0a test asserts the server's actual output validates against it. The Kookr hook imports/copies this schema and validates what it receives — so a schema change is caught at the hook's test layer, not silently at runtime. There is deliberately no version *token* (tokens go stale); the schema artifact plus contract tests on both sides is the mechanism.

**`task_context` is a trust-boundary input.** It is free text concatenated into the judge prompt. M0a runs the ADR 0006 injection-guard inspection over `task_context` (not just over retrieved content), and the judge prompt structurally delimits `task_context` and each candidate, instructing the judge that text inside those regions is data.

### 12. Observability and the self-improvement signal

**Canonical log.** Each `relevance-gate.decision` line carries the full **reproduction record** (round-2 operability): `request_id`, `task_context_sha`, `query_sha`, per-candidate `(content_sha, kept|dropped, stage, reason)`, plus `judge_model`, `judge_prompt_hash`, `floor`, the shuffled order presented, `degraded` + `degrade_reason`, and `judge.skipped` reason (a structured enum, not free text). A gating decision is reconstructable from its log line alone.

**`kb stats` counters** — named, stage-granular: `gated_queries`, `verdict_injected` / `verdict_no_relevant_context` / `verdict_empty_index` (separate — never a merged "no results" rate), `low_confidence_rate`, `drop_rate_A1` / `drop_rate_A2` / `drop_rate_B`, `judge_degrade_rate`. When `judge_degrade_rate` exceeds 10% over the rolling window, the server emits a `WARN` canonical line with a recovery hint — so "`on` is effectively running as the statistical path because the judge keeps failing" is an *alarm*, not a counter nobody reads.

**Self-improvement signal.** The decision log is a stream of `(task, query, candidate, kept|dropped, reason)` tuples — relevance labels produced at query time. v2 proposed a calibration-report script in M0c; round-2 review cut it (no input data until the gate runs; M1's human-labeled run is the real calibration instrument; a one-page human report is not a machine-consumable loop). v3 commitment is narrower and honest:

- M0c delivers only the **log schema** above and the `kb stats` counters.
- Judge keep/drop verdicts MAY *seed* `retrieval-eval` fixtures, but such fixtures are tagged `provenance: judge-suggested, unverified` and **may never be a passing-required regression assertion** until a human confirms them — a biased judge must not encode its bias as "expected" in the fixtures meant to catch it.
- The actual feedback loop (mining the log to retune the floor, two-timescale calibration) is a **committed follow-on RFC**, drafted only if M1 succeeds. It is named here so it is not lost, and explicitly *not* built on an unvalidated judge signal.

## Failure modes

| failure | detection | response |
|---|---|---|
| Gate on, query against empty index | retrieval returns zero candidates | `verdict: empty-index`; gate is a no-op; composes with `--explain-empty` (#358). |
| A1 floor mis-set too high | recall regression on M1 known-good fixtures | A1 cannot empty the set alone (§6); worst case it shrinks the set feeding A2/B. Env-tunable. |
| Stage B false-DROP (per-chunk) | M1 measures it on a human-labeled fixture set; standing `kb stats` metric | structural bias-to-keep: a `drop` must cite a specific disqualifying fact or it is downgraded to keep. Not "no worse than today" — the gate is recall-negative; M1 must show benefit > drop loss before M3. |
| Stage B drops the *whole* set wrongly (false-empty) | M1 empty-verdict fire rate + "answer-present-but-distant" fixture class | §6 — emptiness must be *argued* (specific-absence reason); the BM25 veto blocks it when a lexical hit exists. Residual: the empty verdict rests on judge quality and M1 measures the false-empty rate; if unacceptable, ship with the empty verdict disabled (§6, Migration). |
| Multi-hop / synthesis query, pieces look irrelevant alone | M1 multi-hop fixture | judge instructed to keep necessary-but-incomplete pieces; `overall: partial` suppresses per-candidate drops and keeps the set. |
| Stage B false-KEEP | not detectable in-band | accepted — equals today's no-gate behavior (a genuine no-op, not a regression). |
| Position / verbosity bias in the judge | M1 position-swap probe (reversed-order disagreement rate) | randomized presentation order de-biases the verdict population; `reason` hard-capped at 12 words so length cannot drive the keep/drop token. If the M1 probe shows the empty verdict is order-sensitive, an A/B-swapped double call is added then (§5). |
| Judge model under-detects `no-relevant-context` (small/weak model) | M0 + M0a fixture asserting `no-relevant-context` is reachable | the judge model must pass the capability check before `on` is trusted (§5). |
| `KB_GATE_JUDGE_INPUT` overflow (> 10 survivors) | survivor count | the lowest-ranked overflow is **kept un-judged** (`stage: B-input-overflow`), never silently dropped. |
| Stale `task_context` | none in-band — server cannot detect it | §11 freshness contract makes the hook responsible; documented silent-false-drop source. |
| Degenerate / adversarial `task_context` | token count; ADR 0006 injection-guard over `task_context` + structural delimiting in the judge prompt | degenerate → statistical path; injected instructions inside delimited data regions are treated as data. |
| Judge latency exceeds budget | `judge_degrade_rate` in `kb stats` + WARN alarm at 10% | default raised to 8000 ms; a persistently high rate is alarmed, not silent — `on` is then effectively the statistical path and the operator is told. |
| Hybrid mode, candidates lack a dense leg | absent from `denseDistanceById` | A1 passes them; the BM25 floor + A2/B decide; the lexical leg is the §6 independent witness. |
| `denseDistanceById` missing an expected dense-leg distance | gate asserts finite distance for dense-contributed ids | throws at the gate boundary (programmer error) rather than silently disabling A1. |
| `computeAutoThreshold` fed a tiny/flat survivor list | — | M0a pins and tests A2 for sizes 1/2/3 and flat; A2 alone never empties the set. |
| Gate-internal exception | caught at the gate boundary | degrade to passing the raw retrieval set through, `verdict: bypassed`, error logged. Retrieval never breaks. |

## Alternatives considered

- **Annotate, don't remove** (round-3 socratic — a genuine design fork, surfaced for the user). Instead of *removing* irrelevant candidates, the gate could *annotate* every candidate with `relevance: strong | weak | no-good-answer` plus the judge's one-line reason, and inject them all. The consuming agent (a capable model) reads the annotations and discounts what is marked weak. This is **recall-neutral by construction** — there is no false-drop, so the entire §6 apparatus (empty-verdict logic, BM25 veto, low-confidence rescue, the resurrection exemption) collapses, and "the gate is recall-negative" — the framing that drives half this RFC's complexity — no longer applies. It differs from "client-side gating": the server still runs the judge; it just stops making the destructive decision. **Why this RFC chooses removal:** the operator's stated goal is that irrelevant context "should not be injected" — annotation still spends the tokens and still lets a less-careful consumer be distracted; a fixed-budget injection hook (the Kookr use case, §11) needs the set *pre-trimmed*, not annotated. But the trade is real — annotation trades token spend for zero false-drop risk — and the choice of *remove* vs *annotate* is flagged as a decision for the user to ratify, not a settled matter. (A hybrid is possible: remove only on the `no-relevant-context` verdict, annotate otherwise.)
- **Client-side gating only** (the consuming agent gates its own context; the server returns scores + a confidence band). Rejected as the *sole* design — every MCP client would re-implement the judge and most never would. But the verdict object is deliberately rich and a per-call `gate: off` override exists, so a client *can* override or bypass the gate.
- **Reranker first, gate later.** A calibrated cross-encoder reranker would give an absolute relevance score, making A1's floor and A2's knee genuinely meaningful. This RFC is sequenced as *composable with* a future reranker: the gate's task-awareness and no-good-answer detection are orthogonal to ranking quality. If a reranker lands first, A1/A2 get better inputs and Stage B's job narrows. (Open question: if a reranker or RFC 017 contextual retrieval makes the gate's gain disappear, M1 must catch that — see Open questions.)
- **Pure-statistical gate, no LLM.** This is the `on`-without-task-context path (A1 + A2). Real and shipped — but it cannot do task-awareness (pollution mode #2), the operator's primary complaint, and per §6 it can never emit `no-relevant-context`. The LLM judge is the part that addresses the actual problem.
- **Advisory order from the judge** (v2 had it). Cut in v3. Round-2 review: a judge that has read every candidate produces an ordering as a byproduct, but emitting it "as advisory, ignore it" is the worst of both worlds — full cost (logged, typed, serialized), no committed consumer, and callers silently grow dependencies on it. A judge ordering over *shuffled* input is itself position-biased. Ordering belongs to a reranker RFC or nowhere; the half-step is cut.
- **Self-reported judge confidence** (v2 had it, gating drops on `KB_GATE_DROP_CONFIDENCE`). Cut in v3 — LLM structured-output confidence at temp 0 is uninterpretable; structural bias-to-keep (§5/§6) replaces it.
- **Dedup stage** (v1's A3). Cut in v2: A2's knee already collapses flat-score clusters, and the adjacent-`chunkIndex` rule was actively wrong (with ~200-char overlap, adjacent chunks are mostly distinct content). Redundancy collapse, if M1 shows it is needed, returns as its own pass.

## Migration / rollout

**M0 — Validation gate** (no production code; fully specified above under "Guiding principle"). Builds the eval harness, runs the agent-answer comparison, validates the chosen judge model can produce `no-relevant-context`. **If the pre-registered pass criterion is not met, the RFC stops here.**

**M0a — Gate core + Stage B, single PR** (conditional on M0). v2 split this into M0a (stats) + M0b (judge); round-2 review merged them — M0a-without-M0b is inert code (A1 needs a flag that is only meaningful once the judge path exists) and the split created an untestable intermediate state.
- `src/relevance-gate.ts` (KB-specific cascade orchestrator, A1, A2, §6 empty verdict + BM25 veto + low-confidence rescue), `src/relevance-judge.ts` (single batched shuffled call, two-step JSON parse, token-overlap drop-reason check, fail-degraded fallback).
- The `hybrid-retrieval.ts` side-channel returning `denseDistanceById` (no `rrf.ts` / `FusedResult` change — rollback stays total).
- The BM25 veto ships as a **simple presence check** (a strong query-term-overlap hit exists); full BM25-score normalization is deferred to M1, where its signal quality is actually measured — building the normalization before M1 risks building it twice (round-3).
- `KB_RELEVANCE_GATE` + the env surface; the per-call `gate`/`--no-gate` override; wire into `src/search-core.ts` behind the flag.
- `task_context` MCP parameter + `--task-context*` flags; ADR 0006 injection-guard over `task_context`.
- `gate_verdict` in the MCP response (always present) + `kb search` JSON/footer; the `src/relevance-gate-schema.ts` artifact + a test asserting server output validates against it; `KBError` codes per RFC 009.
- In-memory verdict cache; `relevance-gate.decision` canonical log line.
- Default `KB_RELEVANCE_GATE=off` — zero behavior change for every existing caller.
- Tests (fake-LLM, RFC 017's pattern): A1 cannot empty the set alone; A2 pinned on sizes 1/2/3 and flat; the §6 empty path (judge `no-relevant-context` with a specific-absence reason) and the BM25 veto blocking it on a lexical hit; the low-confidence-rescue path including the resurrection exemption; `verdict` states incl. `empty-index` vs `no-relevant-context`; degrade-on-timeout / malformed / fence-wrapped; `no-relevant-context` reachable with a capable judge; multi-hop `overall: partial` keeps the set; token-overlap drop-reason downgrade; schema-validation test.

**M0c — Observability** (one PR). `kb stats` stage-granular counters + the degrade-rate WARN alarm; `relevance-gate.decision` reproduction fields; `kb search --explain` full `dropped` list for every verdict type; `retrieval-eval` `expectedGateVerdict` fixture field (judge-seeded entries tagged `unverified`).

**M1 — Canary** (operator-driven, post-M0c). Run a representative query set — including no-good-answer and the "answer-present-but-distant" fixture class — with `KB_RELEVANCE_GATE=on`. Success = downstream answer quality (per the M0 method), plus recall on known-good fixtures; injection-rate is reported but is **not** a success criterion. Run the position-swap probe. Tune the dense and BM25 floors. Go/no-go: keep `on` only if answer quality improves without recall loss.

> **M1 ran 2026-05-18 (#372)** — `kb eval-gate --m1`; full report in `docs/rfcs/018-m1-canary-report.md`. Result: **NO-GO** for default-on — no downstream answer-quality gain and a recall regression, measured with the only available local judge (`gemma3:4b`, which §5 classes as under-capable). `KB_RELEVANCE_GATE` stays `off` by default. The M0a/M0c code is validated, not removed (sunset clause satisfied). Re-validate with a capable judge model and after the RFC 019 reranker lands.

**M2 — Kookr hook integration** (cross-repo, separate task). The hook adopts §11. **Acceptance criteria:** the hook passes a freshness-stamped `task_context`; validates the response against the `relevance-gate-schema` artifact; honors `no-relevant-context` / `empty-index` (integration test injecting nothing on the respective fixtures) and propagates `low_confidence`; echoes `gate_verdict` to the debug channel.

**M3 — Default the gate on.** Out of scope; conditional on M1.

**Sunset clause (round-2 delivery — guard against the RFC 017 M1/M2 stall).** If M1 has not been run within **60 days of M0a merging**, the M0a/M0c code is removed by a tracked cleanup PR. The feature is merge-and-validate or merge-and-revert — not merge-and-forget.

**Rollback:** clear `KB_RELEVANCE_GATE`. v3 keeps every change inside the flag boundary — the `denseDistanceById` side-channel is additive and inert when the gate is off, and there is no `FusedResult`/`rrf.ts` change. Disabling the gate is genuinely instantaneous and total.

## Future direction (not in scope)

The operator's real complaint is *context-window* pollution, and KB retrieval is one injection source among several — memory recall, checkpoint injection, tool-result injection also fire, often on the same turn. The end-state is a **session-level multi-source budget arbiter** that gates all sources against one relevance/budget view, so they cannot each conservatively pass content that collectively over-fills the window. This RFC's gate is the first concrete component. The arbiter is a separate, larger RFC. v3 makes a soft commitment round-2 review asked for: **if M1 succeeds, the arbiter RFC is drafted as the immediate follow-on** rather than left as open-ended "future work."

## Open questions

- **Does the gate help *this* corpus's downstream answer quality at all?** The central premise; M0 must answer it before M0a.
- **Is the gate redundant with better retrieval? — a sequencing decision for the user to ratify (round-3 socratic).** The gate's statistical stages (A1 floor, A2 knee) are admittedly weak *because* the underlying scores are not calibrated relevance — and the fix for that is a reranker, which is scoped out. So the RFC builds a relevance gate on a poor relevance signal while the thing that would fix the signal is deferred. The RFC's position: the gate's task-awareness and no-good-answer detection are *orthogonal* to ranking quality, so it composes with (does not wait on) a reranker — but this is a deliberate ordering choice, not a fact. The user should explicitly ratify "build the gate before a reranker / RFC 017" or redirect. If a reranker would land within the gate's 60-day sunset window, building the gate first may be wasted motion.
- **How strong is the BM25 veto?** §6 uses BM25 asymmetrically — a strong lexical hit *vetoes* an empty verdict, lexical silence is not corroboration. M0a ships a simple presence check; M1 measures how often the veto correctly fires (catches a judge false-empty) versus how often it wrongly blocks a correct empty verdict. If the veto is too noisy in either direction, M1 decides whether to keep it, tune it, or drop it — the empty verdict still rests on the judge regardless.
- **Judge capability vs. latency.** A capable model detects `no-relevant-context` but is slower (~4.2–4.6 s warm for 10 candidates); a fast model degrades less but under-detects the core verdict. There may be no good per-deployment point.
- **Interactive latency.** Even at 8000 ms with the cache, an interactive `kb search` user pays judge latency on cache misses. Whether `on` should ever be the *interactive* default (vs. hook-only) is an M3 question.

## Critic feedback incorporated

**Round 1** — five critics (boundary-critic, failure-mode-analyst, design-minimalist, socratic-challenger, ambition-amplifier), each grounding its review in independent `kb` CLI research over the local arxiv KBs, plus a mandatory `design-experimenter` empirical checkpoint. v1 → v2: premise honesty + the validate-before-build M0 gate; cut the dedup stage, the disk cache, and `stat` mode (7 env vars → 4); a two-stage empty-verdict guard; hardened Stage B (randomized order, capable-model requirement, two-step JSON parse); `task_context` trust handling; the empirical probe falsified v1's "dense distance already in memory" and corrected the floor (1.10→0.95) and timeout (4000→8000 ms) defaults.

**Round 2** — five critics (failure-mode-analyst, design-minimalist, operability-reviewer, delivery-pragmatist, ambition-amplifier), again each doing its own `kb` research. v2 → v3:

- **§6 empty-verdict rewritten (failure-mode CRITICAL — v2's fix rejected as not real).** v2 claimed "two independent stages (A1 + B)"; A1 and an LLM judge both read semantic distance — correlated, not independent. v3's second witness is the **lexical/BM25 signal**, genuinely independent of embedding geometry, plus an A/B-swapped double judge call. If the lexical witness is inconclusive the gate degrades conservatively (no empty verdict). The statistical path can never emit `no-relevant-context`.
- **Cut the judge `confidence` field + `KB_GATE_DROP_CONFIDENCE` (failure-mode + design-minimalist consensus).** LLM self-reported confidence in structured temp-0 output is uninterpretable. Bias-toward-keep is now structural: the §6 two-witness rule for the empty case, and a drop-must-cite-a-specific-fact heuristic for the per-chunk case.
- **Multi-hop / synthesis false-drop (failure-mode, CARE paper).** Judge instructed to keep necessary-but-incomplete pieces; `overall: partial` now suppresses per-candidate drops and keeps the set. Added a failure-mode row and an M1 fixture class.
- **`denseDistance` via side-channel, not a `FusedResult` change (delivery HIGH).** v2's public-type change shipped outside the feature flag and broke the rollback claim. v3 threads dense distance as an additive `Map` from `hybrid-retrieval.ts`; `rrf.ts` untouched; rollback is genuinely total.
- **`low-confidence` collapsed to a flag; `empty-index` added (design-minimalist + operability).** Verdict states are `injected | no-relevant-context | empty-index | bypassed`; `low_confidence` is a boolean on `injected`. `empty-index` vs `no-relevant-context` are now structurally distinct everywhere.
- **§2/§6 resurrection contradiction resolved (failure-mode HIGH).** The low-confidence rescue is defined as a terminal safety net explicitly exempt from the no-resurrection rule; M0a tests the dual-floor case.
- **M0 fully specified (delivery CRITICAL).** Concrete query set with a production-matching mix, named grading method, pre-registered effect size + CI, per-bucket reporting, a ~1-week harness deliverable.
- **M0a + M0b merged into one PR (delivery + design-minimalist).** v2's split produced inert, untestable intermediate code.
- **Schema artifact for the cross-repo contract (delivery HIGH).** `relevance-gate-schema.ts` exported + validated on both sides.
- **Observability hardened (operability — 3 CRITICAL findings).** `gate_verdict` is an always-present named MCP field; the canonical log carries full reproduction inputs; the degrade rate is alarmed at 10%, not just counted; per-call `gate: off` / `--no-gate` diagnostic override.
- **`KB_GATE_JUDGE_INPUT` overflow (failure-mode).** Overflow candidates are kept un-judged, never silently dropped.
- **Cut the M0c calibration script (design-minimalist + delivery + operability).** No input data until the gate runs; M1's human-labeled run is the real calibration instrument. M0c is now just the log schema + counters; the feedback loop is a committed follow-on RFC conditional on M1, not built on an unvalidated signal.
- **KB-retrieval-specific module (design-minimalist).** v2's "source-agnostic" abstraction had one caller and already leaked; the generic interface is extracted later against a real second caller.
- **Sunset clause (delivery).** M1 within 60 days of M0a merge, or the code is removed — guarding against the RFC 017 M1/M2 stall.
- **Redundancy-with-better-retrieval risk (ambition-amplifier).** Added as an Open question — M1 must re-validate the gate's value if a reranker or RFC 017 lands.

**Invocation log.** `ambition-amplifier 2026-05-17`: novel finding — flagged the "advisory order" half-step (cut in v3) and pressed a follow-on commitment for the multi-source arbiter (added to Future direction). `design-experimenter 2026-05-17`: probes falsified one load-bearing claim (dense distance "already in memory") and corrected two defaults; recorded in the Round 1 summary.

**Adversarial pair resolution (design-minimalist ↔ ambition-amplifier), round 2.** They conflicted twice. (1) *Module abstraction:* design-minimalist wanted a concrete KB-specific module, ambition-amplifier wanted the source-agnostic shape preserved for the future arbiter. **Resolution: design-minimalist — the v2 abstraction had one caller and already leaked a KB-specific concept (dense distance); a future extraction against a real caller is cheaper than guessing now.** The arbiter survives as a named "Future direction" with a soft follow-on-RFC commitment, which is ambition-amplifier's substantive point without the speculative abstraction. (2) *Advisory order:* design-minimalist said cut, ambition-amplifier said commit-or-cut. **Both agreed the v2 half-step was wrong; resolution: cut** — committing an ordering signal is reranking, which the RFC scopes out.

**Round 3** — a focused verification pass (failure-mode-analyst, design-minimalist, socratic-challenger), each doing its own `kb` research. All three judged v3 close to ready and explicitly said no further critic round is needed — the items below are editorial. v3 → v4:

- **§6 rebuilt again — the "second independent witness" claim dropped (round-3 failure-mode CRITICAL).** v3 used BM25 as an independent witness; round-3 review showed BM25 is query-scoped while the judge is task-scoped, so "both find nothing" conflates two different propositions. v4 stops claiming a second witness: the empty verdict is the judge's call, emptiness must be *argued* with a specific-absence reason, and BM25 is used **asymmetrically as a veto** — a lexical hit blocks an empty verdict; lexical silence is not corroboration. This is honest about where the recall-negative bet actually sits, and makes BM25-normalization quality a non-blocker.
- **A/B-swapped double judge call cut (round-3 failure-mode + design-minimalist).** It doubled latency on the most important path, had an undefined disagreement branch, and collided with the cache key; position bias for a set-level verdict is weaker than for pairwise ranking. v4 makes a single shuffled call; the M1 position-swap probe decides whether the double call is reintroduced, with data.
- **Drop-reason denylist → token-overlap check (round-3 design-minimalist).** A maintained phrase list is replaced by "the drop reason must share a content term with the candidate it disqualifies." More principled, no maintenance growth. Honestly noted: it catches contentless drops, not content-specific-but-false ones.
- **M0 reframed as a directional check + three new pre-registered numbers (round-3, all three critics).** v3's per-bucket confidence-interval criterion is not resolvable at a ~40-query scale; v4 states M0 is honestly a directional go/no-go and M1 is the powered measurement. M0 now also reports the empty-verdict fire rate, the per-chunk-drop contribution isolated from the empty-verdict contribution, and the judge false-empty rate — and a weak result on those ships the gate with the empty verdict *disabled* rather than not at all. M0 spans ≥ 2 structurally different KBs; the LLM grader needs a pre-registered admissibility threshold.
- **Cache stores the resolved verdict (round-3 failure-mode).** §9 clarified — a cache hit replays the final decision, not a raw judge response, so the orchestration is never re-entered with a stale intermediate.
- **Low-confidence rescue clarified (round-3 failure-mode).** §6 states explicitly that the rescue re-admits *across* prior drops (including Stage-B drops) by design, and why "highest fused score" is acceptable for a single relative pick even though that score is rejected as an absolute threshold.
- **"Annotate, don't remove" added as a first-class Alternative (round-3 socratic).** Two rounds of incremental critique hardened the "remove" framing without ever asking whether removal is the right verb. v4 surfaces annotation — recall-neutral, collapses most of §6 — as an explicit fork for the user to ratify.
- **Sequencing made an explicit user decision (round-3 socratic).** Open questions now asks the user to ratify "build the gate before a reranker / RFC 017" rather than treating it as settled.

No round 4: round-3 critics converged ("close to shippable," "does not need another full revision," "no further critic rounds"). The remaining genuinely-open items are decisions for the user, recorded in Alternatives and Open questions, not unresolved critic findings.

## Ratified decisions (2026-05-17)

The two design forks left open for the user at the end of round 3 were resolved:

1. **Remove, not annotate.** The gate *removes* irrelevant context — it does not annotate-and-inject. Rationale (user): irrelevant content must not reach the main agent at all; even annotated, it causes context dilution / context rot. The "Annotate, don't remove" entry in *Alternatives considered* is therefore a rejected alternative, not an open fork.
2. **Gate and reranker built concurrently.** The gate (this RFC) and a cross-encoder reranker (RFC 019) proceed as concurrent tracks rather than one blocking the other. The "is the gate redundant with better retrieval?" *Open question* is resolved in favor of concurrent development; M1 still re-validates the gate's marginal value once the reranker lands.

Implementation proceeds via a self-continuing Kookr task chain over the M0 → M0a → M0c milestone issues; M0 runs straight through (it informs configuration, it does not halt the chain — see "Guiding principle").
