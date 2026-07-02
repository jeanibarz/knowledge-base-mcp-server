# RFC 021 — Heuristic Contextual Prefaces + Preface-Strategy Eval Gate

**Status:** Draft (v4 — final; 3 critic rounds + empirical probes; converged)
**Date:** 2026-07-02
**Author:** Jean Ibarz (with Claude)
**Depends on:** RFC 017 (contextual retrieval), RFC 020 (eval harness, significance rules), RFC 013 (per-model index layout)
**Tracks:** cost barrier to enabling contextual retrieval; retrieval quality parity across preface strategies

## Problem

RFC 017 (contextual retrieval) is implemented — and **off**. `KB_CONTEXTUAL_RETRIEVAL` defaults to
`off` (`src/config/schema.ts:190`), no environment or config override sets it on this box
(verified 2026-07-02), and RFC 017's M2 full-corpus rollout never ran. The **active index today
contains no contextual prefaces at all**: during the 2026-07-02 full rebuild, zero preface sidecar
files were touched (all 4,425 predate the run), i.e. the rebuild embedded raw chunks.

Why has a shipped feature stayed off? Cost. The LLM preface stage prices at **1–2 s per chunk warm,
5–8 s contended** (RFC 017 §5's own estimator uses 8 s as the upper bound). At the corpus's
~29.7k chunks that is **8–16 h of LLM generation** (66 h upper bound) on top of the base rebuild —
and the base rebuild is already substantial: the 2026-07-02 **embed-only** full rebuild took
**~2 h 19 m wall** measured (scan + nomic-embed + FAISS build, no LLM calls).

> Incident provenance, corrected from v1: the 2026-07-02 rebuild was forced by the
> nomic task-prefix rollout (#587 added `search_query:`/`search_document:` prefixes; #567 had
> adjudicated them default-off after a BEIR ablation). Queries carried prefixes the old index
> lacked, so retrieval broke until the re-embed completed. **No LLM prefaces were involved.**

> **What this RFC does NOT address (stated after round-2 review):** during that 2 h 19 m rebuild,
> `kb search` returned degraded results and silently broke a downstream consumer — but that pain
> is **rebuild-as-outage**, and it persists identically under every preface strategy (enabling the
> heuristic still requires a full rebuild). A non-blocking / shadow-index rebuild is plausibly the
> higher-value follow-up for that specific pain; this RFC deliberately does not attempt it. What
> this RFC addresses is the *marginal* cost that keeps RFC 017's idea priced out of adoption.

So the real problem statement is: **RFC 017's intent — context-aware chunk embeddings — is priced
out of adoption by its LLM stage.** Turning it on means every future full rebuild costs ~2.3 h
(embed) + 8–16 h (prefaces, cold) instead of ~2.3 h, and bulk ingest of a new shelf pays
1–2 s/chunk. The sidecar cache (RFC 017 §2) amortizes *unchanged* chunks; cold events — new
shelves, splitter/config changes, embedding-model migrations like #587 — pay full price.

Meanwhile the corpus is structured markdown: frontmatter `title:`/`tags:`, `##` headings, one
topic per note. Empirical spot-check (2026-07-02): even the arXiv shelves' opaque-looking
filenames (`2606.17872.md`) carry real frontmatter titles ("AnchorKV: Safety-Aware KV Cache
Compression …"). A meaningful share of the "where does this chunk sit" signal the LLM preface
articulates is already present as **document structure**, extractable deterministically at
~zero cost. And retrieval is already hybrid BM25+dense+RRF (#206), an independent exact-term lane.

RFC 020's guiding principle — *measure before build* — applies symmetrically as *measure before
keeping (or adopting)*: we should not enable an 8–16 h/rebuild LLM stage, nor reject RFC 017's
idea, without measuring both against a near-free alternative on our own fixtures.

## Goal

0. **Demand check first (M0.5, cheap, added after round-2 review; evidence protocol corrected
   after round 3).** The canonical request log stores queries as `query_sha256` — **no plaintext**
   (`canonical-log.ts`), so "mine the logs for queries" is not executable as written. The real
   protocol: cluster repeated `query_sha256` values and their `top_sources`, and have the operator
   retrospectively label ≥ **3** (crisp threshold) real queries — from memory of intent, recent
   shell history, or re-issued live — where the surfaced chunk/note was wrong and document-identity
   or section context would plausibly fix it. **Negative outcome is a committed artifact**
   (`docs/rfcs/021-gate-results/demand-check.json` `{qualifying_queries, threshold: 3, outcome}` +
   this RFC's status set to *Withdrawn (demand check negative)*) — a stop-gate with no artifact can
   be silently bypassed. Demand-check queries are **held out of the scored fixture set** (they may
   inform archetype design, but scoring fixtures on the exact queries that motivated the work
   biases the gate). The rest of this RFC executes only if the demand check passes.
1. Add a **deterministic heuristic preface strategy** — title + tags + heading breadcrumb —
   computed inline at ingest (no LLM, no cache), as a selectable alternative to the LLM preface.
2. Run a **three-arm eval gate** (`llm` vs `heuristic` vs `none`) as full-corpus index builds
   compared with existing instruments (`kb eval --compare-index`, `kb diff-index`, RFC 020
   significance rules), with per-archetype decisions and a pre-registered non-inferiority margin,
   to decide **whether contextual retrieval turns on at all, and with which strategy**.
3. If the heuristic passes: contextual retrieval becomes enable-able at **zero marginal rebuild
   cost** (a heuristic-on full rebuild ≈ today's embed-only ~2.3 h), removing the barrier that
   has kept RFC 017 off.

**What the heuristic is NOT claimed to be.** RFC 017's motivating example is mid-document
coreference: *"We pin it to CPU because the 24 GB card is already maxed by the gate model"* —
resolving *it/card/gate model* needs the surrounding paragraphs, which the LLM preface reads and
the heuristic does not. The heuristic supplies **document identity + section location**, a
strictly weaker signal. The gate measures whether that difference matters on this corpus's
fixtures — it does not assert equivalence.

**Non-goals:**

- Rebuild-as-outage / index availability during rebuilds (see the Problem call-out; candidate
  follow-up RFC).
- Changing retrieval ranking (hybrid BM25+dense+RRF #206, reranker RFC 019), chunking
  (`MarkdownTextSplitter`, 1000/200), or the docstore contract (callers see verbatim chunks).
- Removing the LLM strategy or its sidecar cache. `llm` remains selectable; its cache and retry
  machinery are untouched by this RFC.
- Speeding up the LLM strategy itself (smaller model, parallel slots) — see Alternatives.
- Per-KB strategy overrides. Deferred until the gate produces evidence a specific shelf needs
  `llm`; the strategy-as-parameter seam (§1) keeps that door open at zero cost.

## Design

### 1. Strategy seam — dispatch above the LLM machinery, not inside it

`KB_CONTEXTUAL_RETRIEVAL=on|off` stays the master gate. Add:

```
KB_CONTEXTUAL_STRATEGY=llm|heuristic       # default: llm (today's semantics, unchanged)
```

Validated at config-schema level (invalid value = config **error at startup**, not a silent
fall-through to the default at dispatch time — a typo like `huristic` must not silently select
the 8–16 h path).

The strategy is resolved once at the ingest call site (`buildChunkDocuments`,
src/file-ingest.ts) and **passed as a parameter**, not read from env deep in the stack:

- `heuristic` → call `heuristicPreface(...)` (new module `src/heuristic-preface.ts`, pure
  function, zero I/O) inline per chunk. `resolveContextualPrefaces()` — the LLM endpoint guard,
  48k-char document truncation, circuit breaker, retry ledger, sidecar IO — is **never entered**.
- `llm` → exactly today's path, byte-for-byte untouched.

This placement means the heuristic cannot be silently suppressed by a missing `KB_LLM_ENDPOINT`,
cannot inherit the 48k truncation failure path, and does not co-locate a pure function with async
LLM machinery. Strategy-as-parameter makes a future per-KB override a call-site-only change.

**No sidecar writes for the heuristic.** The sidecar exists to amortize expensive LLM calls; the
heuristic costs ~0 ms to recompute, so caching it buys nothing and the sidecar schema could not
hold it anyway (its `generator`/`model` are **file-level** fields — two strategies cannot coexist
per-file). Because there is no cache, a future splitter-boundary change simply produces new
prefaces on the next ingest — no stale-cache poisoning surface exists.

**Operability contract (added after round-2 review; milestone-staged after round 3 — each
item lands at the milestone where its value is real, so a feature the demand check may stop
never builds production surfaces):**

- **[M0] Per-KB strategy manifest**, versioned schema `kb.strategy-manifest.v1`, fields
  `{schema_version, generator, covered_chunks, trail_miss_files, last_run_at}` (no separate
  `strategy` field — `generator` already encodes it; `trail_miss_files` aggregated from the
  structured log at manifest-write time, not tracked separately), written at the end of each KB's
  heuristic walk, stored alongside the freshness manifest in the per-model index dir. This is the
  assertion surface for M1 (`covered_chunks == expected`).
- **[M0] Reindex output**: `formatHumanResult` emits a `strategy: heuristic (covered=N)` line on
  heuristic runs, so a heuristic rebuild is distinguishable from an embed-only run in the log.
- **[M0] Structured trail-miss log**: key `heuristic_preface.trail_miss` with `{kb, source,
  miss_count}` so the corpus-wide miss rate is filterable via `kb logs`.
- **[M1] Debuggability**: `kb inspect <file> --preface` renders the heuristic preface per chunk
  on demand — the no-cache equivalent of reading the LLM sidecar; its first real use is the
  archetype-4 manual chunk-rank review, so it lands with M1, not M0.
- **[M2] `kb stats`**: the contextual block (`computeContextualPrefaceBlock`) reads the manifest
  when no sidecars exist and reports `state: heuristic_complete (covered=N)` — production
  operator UI, needed once the feature is live; until M2 the manifest file itself is the
  assertion surface.
- **[M2] `kb doctor`**: a `contextual_strategy` check comparing env against the on-disk
  manifests; **WARN on mismatch** — detection for "flipped the env but never rebuilt" (the
  mixed-index footgun). That footgun only exists in production, so the check ships with adoption.

**Reindex estimator becomes strategy-aware.** The estimator path unconditionally calls the
sidecar classifier and would price a heuristic run at 8 s/chunk (empty-sidecar ⇒ `allCold`),
tripping the LRA-cron-window guard against the very run this RFC enables. Under
`strategy=heuristic` the preface term is ~0 s/chunk and `contextual_estimate` reports
`strategy: heuristic, llm_cost: none`.

### 2. The heuristic preface

For a chunk of document `D`:

```
Doc: {frontmatter.title || filename stem} ({knowledgeBase}/{relativePath})
Tags: {frontmatter.tags, comma-joined}                      # omitted when empty
Section: {h1} › {h2} › {h3}                                 # heading trail at the chunk's midpoint
```

~30–60 tokens, prepended exactly like the LLM preface (`{preface}\n\n{chunk}` at embed time; the
docstore keeps the verbatim chunk). Rendered preface capped at 300 chars.

Field notes:

- **Doc/Tags** carry the note's topic identity into every chunk vector. Verified: arXiv shelves'
  frontmatter titles are real paper titles. (v1 had a fourth "Lead" field motivated by opaque
  titles; the probe showed the motivation is empirically void, so it was cut. If the gate's arXiv
  archetype underperforms, Lead returns as a measured follow-up.)
- **Section trail** locates the chunk in document structure. The heading scanner **skips fenced
  code blocks** (`#` lines inside fences are shell comments, not headings), handles **setext
  headings** (`===`/`---` underlines, with the frontmatter-delimiter ambiguity excluded by
  parsing after frontmatter strip), and anchors the trail at the **chunk midpoint** (with
  200-char overlap a chunk can start in section A's tail while its mass is in section B).

**Trail computation and its empirical basis.** Chunk metadata carries no heading trail and the
splitter exposes no offsets, so the generator locates each chunk by monotone substring search:

```
pos(i) = D.indexOf(chunkText_i, searchFrom);  searchFrom = pos(i) + 1
trail(i) = heading stack at (pos(i) + chunkText_i.length / 2), fences skipped
```

Probed 2026-07-02 against the real splitter config (`MarkdownTextSplitter`, 1000/200,
`keepSeparator: false`) on three shelf archetypes (275 chunks): **100 % verbatim hit rate, 100 %
monotone hit rate.** Two disciplines added after round-2 review, borrowed from the LLM path's own
`findChunkDocumentSpan`: (a) **duplicate-in-window fail-closed** — if the chunk text recurs ahead
of the cursor within the same document, emit the trail-less preface rather than trusting the
first match (monotone *hit* ≠ *correct occurrence* for short/boilerplate chunks); (b) on any
miss, emit trail-less (Doc/Tags), log the structured `trail_miss`, and reset the cursor to the
previous hit's end — a degraded preface, never a failed ingest.

**Determinism contract.** Same document bytes + same chunker config + same generator version ⇒
byte-identical preface. No clock, no RNG, no network, no cache.

### 3. The eval gate — three full-corpus arms, real BM25 statistics, honest statistics

**Arm materialization (redesigned in v3).** v2 proposed a scoped throwaway corpus; round-2 review
broke it three ways: the sidecar cache keys on **absolute source paths** (copying shelves to a
temp root silently orphans every cached preface), canary-scale BM25 IDF/avgdl statistics diverge
from production (the hybrid lane would measure a corpus that doesn't exist), and a missing
`KB_LLM_ENDPOINT` would silently turn the llm arm into a `none` arm (the endpoint guard precedes
the cache read). v3 therefore builds **three full-corpus index versions in place**:

| Arm | Build | Cost (measured/derived) |
|---|---|---|
| `none` | full rebuild, `KB_CONTEXTUAL_RETRIEVAL=off` | ~2.3 h (measured 2026-07-02) |
| `heuristic` | full rebuild, strategy=heuristic | ~2.3 h + ~0 |
| `llm` | full rebuild, strategy=llm, **from the existing sidecar cache** | ~2.3 h + cache reads |

Total ≈ 7 h wall, **zero new LLM calls**. Round-3 corrections to the build procedure:

- **One quiescent window, back-to-back.** The v3 "across quiet windows, resumable" plan was
  doubly wrong: cache-less arms (`none`, `heuristic`) have no embed checkpoint (the FAISS staging
  index is in-memory until the atomic end-of-run swap), so an interrupted arm restarts from
  chunk 0; and gate arms are ordinary inactive `index.vN` versions **not protected from gc** —
  `pruneInactiveIndexVersions` keeps `retention+1` total, so stray rebuilds during a multi-day
  window would silently evict the oldest arm. The gate therefore runs in a **single quiescent
  window** (~7 h): ingest/cron/auto-reindex disabled, `retention_previous_versions ≥ 3` for the
  window, three builds back-to-back.
- **Pinned corpus snapshot.** All three arms must embed the **same corpus state**: record the
  corpus content hash at gate start, assert it unchanged before each arm build, and **abort and
  rebuild any arm whose sources changed mid-build**. The gate artifact asserts one shared corpus
  hash across all three arms (drift between arms would measure corpus delta, not strategy delta).
- **Arm-version ledger, written before each build.** Log `{arm, index_version}` to the gate
  artifact directory *before* starting each build, so `--before/--after` pairs are unambiguous
  even after a crash-restart increments `vN`.

The three versions are compared pairwise with `kb eval --compare-index --before/--after` +
`kb diff-index` — the exact workflow those tools were built for. Production-scale BM25 statistics
by construction. The winning arm's index **is** the adoption artifact: M2 promotes it by symlink
(`index → index.vN` is a pointer flip; promoting a non-newest version is supported).

**llm-arm validity (round-2 hardening).** Probed 2026-07-02 (400-file sample of the 4,425
sidecars): 100 % `generator: contextual-preface.v2` (current), 100 % `model:
qwen3:4b-instruct-2507-q4_K_M`, `chunk_size/overlap` = 1000/200 (current config), **0 % null
prefaces**. M1 additionally asserts, per shelf: (a) `document_hash` freshness against current
file bytes (stale files get canary-scale regeneration — minutes, or are excluded and counted);
(b) **zero new LLM calls** via the endpoint-call counter; and (c) **prefaces actually present**
in the built arm (`covered_chunks == expected`, where `expected` is **independently sourced** from
the chunk manifest total minus the counted stale/excluded files — never derived from the preface
walk itself, which would make the assertion a tautology; trail-less fallbacks count as covered by
design, so (c) is a presence check and trail quality is covered by the `trail_miss` counters).
Assertion (c) exists because an unset `KB_LLM_ENDPOINT` short-circuits
`resolveContextualPrefaces` to all-null *before* the cache read, silently producing a
`none`-arm-in-disguise that passes (b) alone. The endpoint preflight is therefore an explicit
**prerequisite step before the llm arm build starts**, not a parallel M1 task.

**Fixture provenance and the coreference quota (round-2 hardening; corrected round 3).**
Fixtures are authored **before any arm is built**. The canonical log is hash-only, so `source:
log` means *reconstructed from a repeat-query cluster with operator confirmation*, not verbatim
extraction; the rest are hand-authored — provenance labeled per fixture
(`source: log-reconstructed|authored`). Archetype 1 (`operating-environment`, the LLM preface's best case)
carries a fixed quota of **coreference-style queries whose key terms do not appear in the answer
chunk** — the one query class where only the LLM preface can win. If such queries cannot be
honestly authored from real usage, that is itself a decision-relevant finding (the corpus may
have no queries where either preface matters) and is recorded.

**Canary archetypes** (fixed so the measurement cannot cherry-pick; adding shelves is allowed,
removing archetypes requires an RFC amendment):

| Archetype | Example | What it stresses |
|---|---|---|
| 1. Pronoun-heavy operational prose (+ coreference quota) | `operating-environment` | The LLM preface's best case |
| 2. arXiv paper notes | an `arxiv-*` shelf | Structured frontmatter; trail quality on long docs |
| 3. Short structured lesson notes | `agent-task-lessons` | Chunks ≈ whole notes; prefaces may add nothing |
| 4. Long multi-section documents, **chunk-level attention** | picked from `doc_onshape` or similar | Intra-document placement — the axis prefaces actually change |

**Archetype-4 scoring (round-2 adversarial resolution).** Note-level `required_sources` recall is
partially blind to intra-document placement. The formal fix — a `required_chunk` fixture-schema
extension keyed on chunk-hash (`vectorDocstoreId`, already computed in `buildChunkManifest`), not
line-ranges (chunking is char-offset, and overlap makes line-ranges ambiguous) — is **deferred to
M3** to avoid serializing M1 on an RFC 020 schema change. For M1, archetype-4 fixtures carry a
non-scored `expected_chunk_hint` field and the chunk-rank comparison is performed **manually
during the gate review** (the fixture count at one archetype makes this tractable). This is a
deliberate scope choice: the automated M1 metric under-weights the LLM arm's strongest axis, and
the manual check + coreference quota are the compensating controls.

**Statistics (per-archetype, pre-registered margin — round-2 correction).** v2 pooled all
archetypes at the fixture MDE, which (a) dilutes the one signal-bearing archetype below
detectability by construction, and (b) used MDE — a *power* quantity — as the non-inferiority
*margin*, biasing toward the cheaper arm. v3:

- **Fixture floor**: ~25 log-sourced-or-authored queries per archetype (~100 total) before any
  arm is built. At n≈25/archetype, per-archetype MDE ≈ 16–20 recall pts (large effects only —
  stated, not hidden); pooled MDE ≈ 8–10 pts.
- **Pre-registered non-inferiority margin δ = 5 recall@5 points** (chosen for decision relevance
  — the quality we are willing to trade for a free strategy — independent of what the fixtures
  can detect; if measured differences are below MDE, the result is *inconclusive*, never
  "equivalent").
- **Paired per-query bootstrap** (RFC 020 §3), reported **per archetype and per mode**
  (dense-only and hybrid — a BM25-lane shift must not mask a dense-lane regression).
- **Adoption requires**: heuristic non-inferior to llm within δ on **every** archetype in
  **both** modes, *and* superior to none beyond MDE on at least one archetype. Archetype 4 and
  the coreference quota are evaluated separately and can individually veto.

**Decision rule** (status quo: contextual retrieval is OFF; "adopt" = turn on corpus-wide):

| Outcome | Action |
|---|---|
| heuristic non-inferior to llm (δ, all archetypes+modes) and > none (≥ MDE, ≥ 1 archetype) | Enable: `KB_CONTEXTUAL_RETRIEVAL=on`, `KB_CONTEXTUAL_STRATEGY=heuristic`; promote the heuristic arm's index. |
| llm beats heuristic beyond δ on any archetype/mode and > none | The LLM preface measurably earns something. Its adoption-cost question returns; evaluate the smaller-model arm (qwen3:0.6b/1.7b, Alternatives) before deciding. |
| neither strategy > none beyond MDE anywhere | Contextual retrieval stays off; RFC 017's status annotated with the measured bound. Closing a shipped-but-off feature with data is a valid outcome. |
| inconclusive (differences < MDE where a decision needs them) | Stay off; record the bound; expanding fixtures is the only path to a stronger claim. |

**Gate artifact (round-2 operability).** Each gate run writes a machine-readable
`docs/rfcs/021-gate-results/<date>.json`: arm index versions, fixture-set content hash,
per-archetype per-mode numbers, MDE, δ, selected decision row — the durable record
distinguishing "gate ran, inconclusive" from "gate never ran", reproducible per RFC 020 §7
(the ledger here is this committed artifact, not MLflow — `kb eval`/`kb diff-index` are not
MLflow producers).

The gate re-runs per strategy-version (`heuristic-preface.v1`); a slim CI variant
(heuristic-vs-none on one archetype) is folded into the RFC 020 §4 CI gate as M3 —
**precondition**: the CI environment provides the embedding model (nomic-embed via Ollama or the
HF path); if it cannot, M3 downgrades to a scheduled local job, not CI.

### 4. Cost accounting (measured where possible)

| Event | Today (prefaces off) | LLM prefaces on | Heuristic prefaces on |
|---|---|---|---|
| Full rebuild (~29.7k chunks) | **~2 h 19 m** (measured 2026-07-02) | + 8–16 h cold / +0 warm-cache | **≈ same ~2.3 h** (+~0) |
| Bulk ingest, 500-doc shelf | ~minutes–tens of minutes | +1–2 s × chunks (~1–2 h) | ≈ same (+~0) |
| New/changed file | ~seconds | +1–2 s × new chunks | ≈ same (+~0) |
| GPU during rebuild | embed model only | + qwen3:4b resident for hours | embed model only |
| $ | 0 (all local) | 0 | 0 |
| Retrieval quality | baseline | Anthropic-benchmark-proven, **locally unmeasured** | measured by this RFC's gate |

The strategic payoff: today the choice is "no contextual retrieval" vs "adopt an 8–16 h/rebuild
tax". The heuristic adds a third option whose marginal cost is ~zero, and the gate tells us which
of the three is actually best on our fixtures. The one-time gate cost is ~7 h of embed-only
rebuilds, zero LLM calls.

## Files to change

- `src/heuristic-preface.ts` (new) — pure generator: Doc/Tags rendering, fence- and setext-aware
  heading scan, monotone chunk location with duplicate-in-window fail-closed, midpoint trail,
  300-char cap. Unit tests: determinism, trail correctness (incl. code-fence and setext
  fixtures), no-headings/no-title fallbacks, duplicate-chunk fail-closed, >48k-char doc,
  overlap-midpoint tie-break.
- `src/file-ingest.ts` — resolve `KB_CONTEXTUAL_STRATEGY` at the `buildChunkDocuments` seam;
  dispatch heuristic inline / LLM path unchanged; write the per-KB strategy manifest
  (`kb.strategy-manifest.v1`) on heuristic runs.
- `src/config/schema.ts` — `KB_CONTEXTUAL_STRATEGY` enum with **startup validation** (invalid
  value = config error, never a silent default).
- Reindex estimator (`classifyContextualSidecarChunks` call path in `reindex-runner.ts`) —
  strategy-aware pricing; `contextual_estimate` labels the strategy.
- `src/cli-reindex.ts` (`formatHumanResult`) — `strategy: heuristic (covered=N)` output line.
- `src/kb-stats.ts` (`computeContextualPrefaceBlock`) — merge manifest-derived heuristic coverage
  with sidecar-derived LLM coverage into one non-contradicting block. **[M2]**
- `src/cli-doctor.ts` — `contextual_strategy` check (env vs manifest agreement; WARN on
  flip-without-rebuild). **[M2]**
- `src/cli-inspect.ts` — `--preface` flag rendering the heuristic preface per chunk. **[M1]**
- `docs/testing/fixtures/` — expanded canary fixtures (~25/archetype, provenance-labeled,
  coreference quota in archetype 1, `expected_chunk_hint` in archetype 4).
- `docs/rfcs/021-gate-results/` — machine-readable gate artifacts.
- `src/contextual-preface.ts` — **no changes** (LLM path untouched; dispatch happens above it).

## Edge cases

- **No headings / PDF-extracted prose**: trail empty; preface is Doc/Tags. Still ≥ `none`.
- **Missing frontmatter title**: filename stem (verified rare — even arXiv notes carry titles).
- **`indexOf` miss or in-window duplicate**: trail-less fallback + structured `trail_miss` log +
  manifest counter; cursor resets to the previous hit's end, never backward. Measured 0/275
  misses on three archetypes; the counters exist to catch corpus drift.
- **Huge documents**: monotone search linear in practice; docs capped by `applyExtractedTextLimit`.
- **Mixed-strategy embedding space**: flipping env is inert for existing vectors; the index goes
  strategy-mixed only via incremental ingest between flip and rebuild. Rule: **flip and full
  rebuild happen together** (cheap under heuristic), and `kb doctor`'s env-vs-manifest check
  WARNs whenever they have drifted apart — detection, not just documentation.
- **Noisy auto-generated tags**: included verbatim in v1 of the generator; if a shelf's tags
  measurably hurt, per-shelf tag filtering at generation time is a data fix, not a new mechanism.

## Failure modes

- **Fixtures still too small after expansion.** RFC 020 §3 discipline: report MDE, never conclude
  below it. The "inconclusive" row is an acceptable outcome that still bounds the LLM preface's
  value.
- **Trail wrong on pathological markdown** (unclosed fences, HTML headings): deterministic, so
  reproducible and debuggable via `kb inspect --preface`; bounded impact (one preface).
- **Gate gamed by shelf or fixture choice**: archetypes fixed here; fixture provenance labeled;
  coreference quota mandatory; removal of any requires an RFC amendment.
- **llm arm silently degenerate** (missing endpoint → all-null prefaces): M1 asserts
  prefaces-present (`covered_chunks == expected`), not just zero-LLM-calls.
- **Stale llm sidecars bias the comparison**: M1 asserts per-shelf `document_hash` freshness;
  mismatches regenerate at canary scale or are excluded and counted in the gate artifact.
- **Winner promoted stale** (corpus changed between gate and M2): the gate artifact records the
  pinned corpus hash; >~1 % chunk drift ⇒ full rebuild instead of promotion (quantitative rule,
  M2). Intra-gate drift is prevented, not repaired: single quiescent window + per-arm snapshot
  assertion (§3).
- **Gate arm evicted by gc**: arms are ordinary inactive `index.vN` versions; the prune keeps
  `retention+1` total. Mitigated by the single-window procedure (no stray rebuilds while the gate
  runs) + retention ≥ 3; the arm-version ledger makes any eviction immediately visible as a
  missing `--before/--after` target rather than a silently wrong comparison.

## Alternatives considered

- **Smaller preface LLM** (`qwen3:0.6b`/`1.7b`, already pulled): 3–8× on the cold path, quality
  unknown — a fourth measurement point. Not in the initial gate: the three-arm gate first
  establishes whether LLM prefaces beat the free heuristic at all; the small-model arm is the
  named next step of decision-row 2 only.
- **Parallel llama-server slots**: trades the KV document-prefix reuse that makes the warm path
  1–2 s; RFC 017 §4 measured contended cost at 5–8 s. Bounded upside, operational complexity.
- **Title-prepend only**: ≈ the heuristic minus the trail; the trail is the only field addressing
  intra-document placement (archetype 4). If the gate shows the trail adds nothing, simplifying
  is an implementation detail.
- **Caching heuristic prefaces in the RFC 017 sidecar**: rejected — schema is
  single-generator-per-file and caching a ~0 ms computation buys nothing.
- **Scoped throwaway-corpus gate** (v2's design): rejected in round 2 — absolute-path sidecar
  keys orphan the cache on copy; canary-scale BM25 IDF/avgdl diverges from production; full-corpus
  arms cost only ~2.3 h each with zero LLM calls, which removes the reason the throwaway existed.
- **Run-once gate with no CI presence**: rejected — a silent splitter/frontmatter regression
  could invert the decision invisibly; the slim CI canary (M3) is cheap.

## Open questions

- `kb inspect --preface` vs a dedicated `kb explain --preface` surface — pick during M0 by
  whichever CLI already loads per-file chunk manifests.
- Whether the M3 CI environment can host the embedding model; if not, M3 becomes a scheduled
  local job (stated in §3).

## Milestones and acceptance

- **M0.5 — demand check.** Mine `kb logs` for ≥3 real queries where document/section context
  would plausibly fix a wrong result; record them (they seed the fixtures). Accept: the queries
  exist (else the RFC stops here and says so).
- **M0 — generator + seam (two PRs).** **PR 1:** `src/heuristic-preface.ts` + unit tests +
  the `KB_CONTEXTUAL_STRATEGY` schema enum — pure additive code, zero blast radius. **PR 2:** the
  `buildChunkDocuments` dispatch seam, manifest write, strategy-aware estimator, reindex output
  line, structured trail-miss log — the ingest-hot-path change lands alone, reviewable as a
  single concern. Accept: existing contextual-preface tests untouched and green; a heuristic
  reindex of one shelf completes with **zero LLM calls** (endpoint-call counter) and correct
  `estimated_seconds`; the manifest file is written and correct (direct read assertion — the
  `kb stats`/`kb doctor` surfaces land later at their own milestones).
- **M1 — fixtures + gate (ordered sub-steps).** (1) Expand fixtures (~25/archetype,
  provenance-labeled, coreference quota, `expected_chunk_hint`); `kb inspect --preface` lands
  here. (2) Pin the corpus snapshot; quiesce ingest/cron; raise retention ≥ 3. (3) **Endpoint
  preflight + llm-arm freshness assertions (document_hash) — prerequisites, not parallel
  tasks.** (4) Build the three arms back-to-back in one window, logging `{arm, index_version}`
  to the gate directory *before* each build. (5) Paired per-archetype per-mode comparisons + the
  manual archetype-4 chunk-rank review; write the gate artifact (asserting one shared corpus
  hash across arms). Accept: a decision-table row selected under the pre-registered δ and
  measured MDE, artifact committed — or the inconclusive row recorded with the bound.
- **M2 — apply the decision + rollback SOP.** Enact the selected row. If enabling: **pin
  `KB_CONTEXTUAL_STRATEGY=heuristic` + `KB_CONTEXTUAL_RETRIEVAL=on` in the environment BEFORE any
  drift-repair ingest** (else incremental ingest pollutes the promoted arm with llm/none
  prefaces), then promote the heuristic arm's index by symlink; "fresh" is quantitative — more
  than ~1 % of chunks changed since the gate ⇒ full rebuild instead of promotion. The `kb stats`
  merge and `kb doctor` env-vs-manifest WARN ship here. **Rollback SOP:** the `none` arm remains
  on disk while retention ≥ 3 and fewer than two post-promotion rebuilds have run — rollback is
  an instant symlink promotion of that version, not a 2.3 h rebuild; keep retention at 3 for a
  stability window (~1 week) before restoring the default (2), and verify the prune triggered by
  lowering it does not evict the active version. Accept: (a) timed heuristic rebuild or promoted
  arm ≈ embed-only cost, (b) search-availability check, (c) doctor clean on env-vs-manifest,
  (d) rollback SOP documented in the ops notes with the retention timeline.
- **M3 (follow-up) — CI canary + `required_chunk`.** Slim heuristic-vs-none arm in the RFC 020
  §4 CI gate (embed-model precondition); formal `required_chunk` fixture schema keyed on
  chunk-hash (`vectorDocstoreId`), replacing the manual archetype-4 review.

## Critic feedback incorporated

### Round 1 (2026-07-02) — 5 critics

- **socratic-challenger 2026-07-02: novel finding.** Premise reframed (feature is default-off; M2
  never ran); #567/#587 incident corrected (embed-only, measured 2 h 19 m); ε=2 was below the
  fixture noise floor → MDE-based statistics; chunk-level archetype added; honest scope statement
  (heuristic ≠ coreference); title-prepend floor recorded.
- **failure-mode-analyst 2026-07-02: novel finding.** Sidecar is single-generator-per-file (v1's
  "caches coexist" false) → resolved by removing heuristic caching; no shelf-scoped index build →
  gate redesign; estimator prices heuristic at 8 s/chunk → strategy-aware estimator; `indexOf`
  assumption → probed 100 % on 275 chunks; mixed-space flip → flip+rebuild rule; `model: null`
  observability → manifest.
- **design-minimalist 2026-07-02: novel finding.** Heuristic sidecar caching cut (dissolving the
  cache-coexistence critical); Lead field cut (probe: arXiv titles are real); per-KB override
  syntax and truncation-priority detail removed.
- **boundary-critic 2026-07-02: novel finding.** Dispatch above `resolveContextualPrefaces`;
  heuristic in its own module; strategy as parameter; `GENERATOR_VERSION` single-constant break
  mooted by no-cache design.
- **ambition-amplifier 2026-07-02: novel finding.** CI presence for the gate (M3); act on
  `llm ≈ none` directly (decision row 3); per-mode deltas; timed-rebuild M2 acceptance; fourth
  small-LLM arm rejected for round 1 (staged as decision-row-2's named next step).
- **Empirical checkpoint (mandatory, run inline):** sidecar mtimes (0/4,425 touched 2026-07-02 ⇒
  embed-only rebuild); `KB_CONTEXTUAL_RETRIEVAL` default-off confirmed; splitter probe (100 %
  verbatim/monotone on 275 chunks, real config); arXiv titles real (Lead cut); #567/#587 git
  history reconciled.

### Round 2 (2026-07-02) — 4 critics vs v2

- **socratic-challenger: novel finding.** (1) No named demand for the feature → **M0.5 demand
  check** added as a stop-gate; (2) the *real* incident pain (rebuild-as-outage) is untouched by
  any preface strategy → explicit out-of-scope call-out + shadow-rebuild named as candidate
  follow-up; (3) canary-scale BM25 IDF/avgdl ≠ production → **full-corpus arms** (see below);
  (4) stale-sidecar bias against the llm arm → M1 `document_hash` freshness assertion;
  (5) fixture authorship bias → provenance labels (`kb logs`-sourced), coreference quota.
- **failure-mode-analyst: novel finding.** (A) sidecar filenames key on **absolute paths** —
  v2's copy-to-throwaway silently orphaned the entire llm cache → dissolved by full-corpus arms;
  (B) missing `KB_LLM_ENDPOINT` short-circuits before the cache read → llm arm degenerates to
  `none` while passing the zero-calls assert → M1 adds prefaces-present assertion + endpoint
  preflight; (C) sidecar validity unproven → **probed: 400-file sample = 100 % current generator
  v2, current chunk config, 0 % null prefaces**; M1 still asserts per-shelf hash freshness;
  (D) pooled-at-MDE dilutes archetype 4 by construction and MDE-as-margin biases toward the cheap
  arm → per-archetype decisions + pre-registered δ=5 pts; (E) line-range chunk fixtures are
  ambiguous under overlap → chunk-hash (`vectorDocstoreId`) keying, deferred to M3 with manual
  M1 review; (F) monotone hit ≠ correct occurrence → duplicate-in-window fail-closed; (H) setext
  headings → scanner support + fixture; (K) enable footgun → doctor WARN; (L) CI embed-model
  precondition stated.
- **design-minimalist: novel finding.** (1) throwaway-corpus llm arm's sidecar-key assumption
  flagged independently (converged with failure-A) → full-corpus fallback adopted as the design;
  (2) `required_chunk` schema as M1 blocker would serialize on RFC 020 → deferred to M3 with the
  `expected_chunk_hint` manual protocol; (3) manifest `strategy` field redundant with `generator`
  → cut.
- **operability-reviewer: novel finding.** `kb stats` would report heuristic-covered KBs as
  never-contextualized; no detection for flip-without-rebuild; doctor blind to strategy; heuristic
  runs indistinguishable from embed-only in reindex output; no per-chunk preface debuggability
  without a sidecar; gate results ephemeral → the **operability contract** in §1 (versioned
  manifest, stats merge, doctor check, output line, `kb inspect --preface`, structured trail-miss
  log) and the committed **gate artifact** in §3; MLflow non-applicability corrected.
- **Adversarial resolution (failure-mode-analyst vs design-minimalist on archetype-4 scoring):**
  sided with the minimalist's deferral (manual M1 review + M3 formal schema) because serializing
  M1 on an RFC 020 fixture-schema change costs more than the automation buys at n≈25, while the
  analyst's chunk-hash keying (not line-ranges) is adopted as the M3 design — the compensating
  controls (coreference quota, per-archetype veto) keep the LLM arm's strongest axis measured.

### Round 3 (2026-07-02) — 3 critics vs v3 (converged)

- **failure-mode-analyst: novel finding.** Confirmed all round-1/2 resolutions sound; found new
  gaps only in v3's operational envelope: (1) gate arms not gc-protected (prune keeps
  `retention+1`; a stray rebuild evicts the oldest arm) → single quiescent window, ingest/cron
  quiesced, arm-version ledger; (2) intra-gate corpus drift confounds arms → pinned snapshot +
  shared-hash assertion + abort-on-drift; (3) **the canonical log stores `query_sha256` only —
  no plaintext** → M0.5 evidence protocol redefined (repeat-cluster + operator labeling), crisp
  threshold (≥3), committed negative-outcome artifact, demand queries held out of scored
  fixtures, `source: log` provenance corrected to `log-reconstructed`; (4) resumability claim
  false for cache-less arms → dropped, arms are atomic single-window runs; (5) drift-repair
  ingest could pollute the promoted arm → strategy env pinned before any M2 ingest; (6)
  `expected` in assertion (c) now independently sourced from the chunk manifest; (7) retention
  reset step specified in M2.
- **design-minimalist: minor findings only (convergence signal).** Operability items re-staged
  to the milestone where their value is real: `kb doctor` + `kb stats` → M2, `kb inspect
  --preface` → M1, `trail_miss_files` aggregated from the structured log rather than tracked
  twice. M0 shrinks to the generator + seam.
- **delivery-pragmatist: verdict "shippable with revisions".** (1) M0 split into two PRs (pure
  additive module first; the ingest-hot-path seam alone second); (2) endpoint preflight made an
  explicit prerequisite inside M1's ordered sub-steps; (3) arm-version ledger written before each
  build; (4) M2 rollback SOP documented (instant symlink rollback to the `none` arm while
  retention holds; ~1-week stability window before restoring retention); (5) M0.5
  negative-outcome artifact specified. Also verified: the statistical tooling
  (`benchmarks/significance.ts`) and comparison CLI already exist — no hidden prerequisites.
- **Convergence:** round 3 produced no structural objections — all findings were procedural
  (preconditions, acceptance criteria, milestone staging) and are incorporated above. Review
  closed at three rounds per the workflow default.

Intent preservation check: the original ask — "can we drop the LLM for speed, using only the
embedder, without losing too much retrieval quality?" — remains the spine; round 2 added the
prior question "does anyone need this on at all?" (M0.5) rather than replacing it, and the
measure-don't-assume constraint from the ask is strengthened (per-archetype, pre-registered δ).
