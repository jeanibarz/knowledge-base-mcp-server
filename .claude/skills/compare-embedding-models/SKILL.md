---
name: compare-embedding-models
description: Run an apples-to-apples benchmark of two embedding models on a fixture or your KB and produce an HTML report covering cold-start indexing, warm-query latency, batch throughput, storage, and quality.
keywords: [embeddings, benchmark, comparison, latency, throughput, models, html-report, selection]
anchors:
  - benchmarks/compare/run.ts::main                                # M5
  - benchmarks/compare/render.ts::renderReport                     # M5
  - benchmarks/scenarios/batch-query.ts::runBatchQueryScenario     # M5
  - benchmarks/scenarios/index-storage.ts::runIndexStorageScenario # M5
  - src/cli.ts::runAddModel                                        # RFC 013 M2 (cost prompt)
  - src/cli.ts::runCompare                                         # RFC 013 M2 (per-query side-by-side)
  - src/cost-estimates.ts::COSTS                                   # M5 (cost-per-MTok table)
applies_to:
  - claude-code
  - claude-desktop
  - codex-cli
  - cursor
  - continue
  - cline
last_verified: 2026-04-26
---

## When to use

- The user is choosing between two embedding models for a new knowledge base and wants concrete numbers (latency, cost, storage, quality) on **their hardware**, not a generic leaderboard.
- The user has switched models in the past and wants to verify the trade-off was worth it.
- The user is documenting a model choice for a team and needs an HTML artefact to attach to a decision record / RFC / PR.

## Prerequisites

- knowledge-base-mcp-server `0.3.x` installed (M0–M4 shipped; this skill needs `kb models {add, list}` from §4.4 of RFC 013).
- Both models reachable: Ollama running locally (`OLLAMA_BASE_URL`) for ollama models; `HUGGINGFACE_API_KEY` set for HF models; `OPENAI_API_KEY` set for OpenAI models. The orchestrator reads provider tokens from env per `src/config.ts`.
- Disk space: ~10 MiB per model index for the medium synthetic fixture; more for larger profiles.
- For paid providers: estimated cost surfaced in the orchestrator preamble; non-zero requires `--yes` or interactive confirmation (`src/cli.ts` `runAddModel` flow, RFC 013 §4.4).

## Steps

1. **Identify model ids.** `kb models list` shows registered models with their `<provider>__<slug>` ids. If a target model is not yet registered, run `kb models add <provider> <model_name>` first (the orchestrator can auto-register with `--yes`, but registering explicitly lets the user audit cost upfront).

2. **Pick a fixture profile.**
   - `--fixture=small` (~150 chunks) — sanity check, ~10 s.
   - `--fixture=medium` (~600 chunks) — default; ~1 min on Ollama, ~30 s on HF/OpenAI.
   - `--fixture=external` — runs against the corpus at `KNOWLEDGE_BASES_ROOT_DIR` (the user's real KB; no copy is made).
   - `--fixture=large` (~3000-chunk arxiv corpus) — selection-grade. **Not yet implemented in v1**; deferred to M5.1 (RFC 013 §4.13.4 follow-up).

3. **Run the comparison:**
   ```bash
   npm run bench:compare -- \
     --models=ollama__nomic-embed-text-latest,huggingface__BAAI-bge-small-en-v1.5 \
     --fixture=medium \
     --concurrency=1,4,16
   ```

4. **Read the report.** Output paths are printed at the end:
   ```
   Report: benchmarks/results/compare-<id_a>-vs-<id_b>-<utc-stamp>.html
   JSON:   benchmarks/results/compare-<id_a>-vs-<id_b>-<utc-stamp>.json
   ```
   Open the HTML:
   ```
   xdg-open <path>   # Linux
   open <path>       # macOS
   ```
   The report is fully self-contained (inline CSS + SVG, no external assets). Attach it to a PR / Slack / decision record as-is.

5. **Compare the recommendation panel against your priorities.** The panel picks a winner per axis (single-query latency, batch throughput, cost, storage, recall, diversity). If your priorities are mixed, the panel says so explicitly — pick the model that wins your highest-weighted axis.

6. **Optional: golden labels.** Reserved — `--golden=<path>` accepts a JSON `{query: [doc_paths]}` file. The merged JSON output already carries per-query top-k for both models, ready for an external scorer; report-side recall@k integration lands in M5.1.

## Verification

After the run, the report file exists, opens in a browser, and the summary table has a non-empty row for both models:

```bash
test -s benchmarks/results/compare-*.html && \
  grep -q 'cold_index_ms' benchmarks/results/compare-*.html && \
  echo OK
# expected: OK
```

For paranoid verification, the merged JSON next to the HTML has `reportA.scenarios.cold_index.chunks > 0` and the same for `reportB`.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `bench:compare: invalid model spec "<id>"` | model_id doesn't match `^[a-z]+__[A-Za-z0-9._-]+$` | Use either a parsed `<provider>__<slug>` (run `kb models list` to see registered ids) or `<provider>:<model_name>` form. |
| `bench:compare: models resolve to the same id` | both `--models=` entries derive to the same slug | Pick two different models. |
| `OLLAMA_BASE_URL unreachable` | Ollama daemon not running | `ollama serve` in another terminal; verify with `curl $OLLAMA_BASE_URL/api/tags`. |
| `HUGGINGFACE 429 — rate limited` | HF free tier throttle | Lower `--concurrency=1`; rerun. |
| `OPENAI 401` | API key missing or expired | Check `OPENAI_API_KEY`. |
| Cold index never finishes (slow CPU + paid provider) | Time budget exceeded | Drop to `--fixture=small`. |
| Report opens but storage chart is empty | `index-storage` scenario reports 0 bytes (e.g. stub provider) | Real-provider runs populate storage; stub mode is for orchestrator wiring smoke-tests only. |
| Cross-model Jaccard is `0.0` everywhere | Models return disjoint top-k or one returned zero results | Check both models' `default_recall_at_10` in the summary; if one is `0`, that model failed retrieval (likely an empty index). Re-run `kb models add --refresh` for the empty model. |

## See also

- RFC 013 §4.13 — full design rationale and orchestrator architecture.
- `benchmarks/README.md` — `Comparing two embedding models` section.
- `kb models add` — register a model before benchmarking it.
- `kb compare <query> <a> <b>` — single-query side-by-side rank table (CLI; complements the orchestrator's batch report).
