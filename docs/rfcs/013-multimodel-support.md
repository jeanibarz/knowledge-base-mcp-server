# RFC 013 — Multi-model embedding support: keep many indexes side-by-side

- **Status:** Draft (v4 — operator-requested addition: §4.13 embedding-comparison benchmarking skill + M5 milestone. Multi-model rails (M0-M4) unchanged from v3.)
- **Author:** Jean Ibarz (drafted by automation)
- **Target:** `jeanibarz/knowledge-base-mcp-server` `main`
- **Related:** RFC 012 (CLI distribution — adds the `kb` bin, split-lock coordination, model-mismatch check), RFC 011 (arxiv-backend ingestion pipeline), RFC 010 (MCP surface v2)
- **References (GitHub issues):** [#100](https://github.com/jeanibarz/knowledge-base-mcp-server/issues/100). Implementation milestones get one issue each after RFC approval.

## 1. Summary

Today the server keeps **one** FAISS index per `FAISS_INDEX_PATH`, built with one embedding model. Switching `EMBEDDING_PROVIDER` or any of the model env vars (`OLLAMA_MODEL`, `HUGGINGFACE_MODEL_NAME`, `OPENAI_MODEL_NAME`) trips the auto-rebuild guard at `src/FaissIndexManager.ts:356-371` and re-embeds every file from scratch — destructively. There is no path back.

This RFC proposes **side-by-side multi-model indexes**:

1. **Per-model index layout.** `${FAISS_INDEX_PATH}/models/<model_id>/{faiss.index/, model_name.txt}` instead of `${FAISS_INDEX_PATH}/{faiss.index/, model_name.txt}`. Each model is fully isolated; deleting one leaves the others intact. The 0.2.x layout auto-migrates on first 0.3.0 start (one `mkdir + 2 renames` ≈ 12 ms measured — §10 E2).
2. **Deterministic, filesystem-safe `<model_id>` slug** derived from `(provider, modelName)` as typed (e.g. `ollama__nomic-embed-text-latest`, `openai__text-embedding-3-small`). Deterministic so the same env on two machines produces the same id; no operator-managed alias state.
3. **`${FAISS_INDEX_PATH}/active.txt`** — one line, the active `<model_id>`. Single-writer invariant: written **only** by migration (one-shot) and `kb models set-active` (explicit operator command). **Never** by `updateIndex` or `kb models add` (round-1 failure-mode F7 — silent-revert race). `KB_ACTIVE_MODEL` env overrides for the lifetime of the process.
4. **Two CLI subcommands at the surface boundary.** `kb search --model=<id>` (per-call override) and `kb models {list, add, set-active, remove}`. `kb compare <query> <model_a> <model_b>` lands in M2 — it's the actual operator workflow (round-1 ambition F1; §2.2 motivation is a verb, not a noun).
5. **MCP narrows additions.** `retrieve_knowledge` gains optional `model_name` arg. New `list_models` tool surfaces what's registered. **No `add_model` / `set_active_model` MCP tools** — operator-driven side effects, deferred to a future RFC under MCP elicitation semantics (round-1 ambition F6, deferred not vetoed).
6. **Per-model write locks.** `${FAISS_INDEX_PATH}/models/<id>/.kb-write.lock`. A long-running `kb models add openai text-embedding-3-large` (multi-minute embedding pass) does **not** block `kb search` against an unrelated model. Per-model lock-path nesting adds <0.1 ms p95 vs RFC 012's flat path (measured — §10 E3). Single-instance PID advisory at `${FAISS_INDEX_PATH}/.kb-mcp.pid` is unchanged.
7. **`lock.ts` splits** into `src/instance-lock.ts` (PID advisory, single concern: enforce one MCP per `FAISS_INDEX_PATH`) and `src/write-lock.ts` (`withWriteLock(resource, fn)`, no model-knowledge). Deferred from RFC 012 round-3 (§11); RFC 013 adds per-model semantics so this is the right moment to split (round-1 boundary F1+F7).
8. **`FaissIndexManager` constructor takes `{ provider, modelName }`** (round-1 boundary F2 — `{modelId, indexDirOverride?}` conflates two concerns, and the existing constructor reads provider/model from `config.ts` at construction time). Path is derived inside the manager.
9. **Layout bootstrap is split from `initialize()`** (round-2 boundary F2 — `initialize()` was conflating process-lifecycle, directory recovery, and per-instance load). New `FaissIndexManager.bootstrapLayout()` is a static one-shot — runs migration, writes `active.txt` if missing on a fresh install (round-2 failure N2). Called once per process by `KnowledgeBaseServer.run()` after `acquireInstanceAdvisory()` and once at the top of CLI subcommand dispatch (under `${PATH}/.kb-migration.lock`). Module-level cache prevents same-process double-call races (round-2 failure N1). Per-instance `initialize()` is load-only. No `KB_SKIP_MIGRATION` opt-out (round-1 minimalist F7, delivery F1 — flag promised "rollback" but produced "silently broken").
10. **Cost UX is honest but unceremonious** (round-1 minimalist F4, delivery F4). Paid-provider `kb models add` prints `"Will embed N chunks (~M tokens) via OpenAI text-embedding-3-small. Estimated cost ~$X.XX (see openai.com/api/pricing). Continue? [y/N]"` and exits 2 in non-TTY contexts without `--yes` (round-1 failure F9 — never block on stdin). Constants are hard-coded; quarterly manual review documented in `src/cost-estimates.ts` header. **No CI auto-fetch** (provider pricing pages are JS-rendered; the v1 "10% drift gate" was aspirational).

The deliverable is one RFC and (after approval) **four PRs** with a precursor lock-split landing first (round-2 delivery F1 — surgical 0.2.2 PR de-risks the bigger 0.3.0 PR):

- **M0 (1 PR, 0.2.2 patch).** Lock-module split — `src/lock.ts` → `src/instance-lock.ts` + `src/write-lock.ts`. `withWriteLock` signature `(fn)` → `(resource, fn)` (resource = `FAISS_INDEX_PATH` for now; multi-model lands in M1). Mechanical refactor, ~150 LoC including tests, RFC 012 round-3-deferred. Lands a week ahead of M1 to pre-clear lock-module risk.
- **M1+M2 (1 PR, 0.3.0 minor).** Layout, migration (`bootstrapLayout` + `initialize` split — round-2 boundary F2), `active-model.ts`, `kb models *` family, `kb search --model=<id>`, `kb compare`. CHANGELOG flags **technically breaking** (round-1 delivery F2). ~1100 LoC (lower than v2's 1300 because M0 carved out the lock split). Internal commit-staging: (1) per-model layout + migration, (2) `kb models *` family, (3) `kb compare`. Reviewer can sign off commit-by-commit.
- **M3 (1 PR, 0.3.x minor).** MCP `list_models` tool + `model_name` arg on `retrieve_knowledge`. ~150 LoC.
- **M4 (1 PR, 0.3.x patch).** Docs — README "comparing embedding models", `docs/clients.md` snippet, threat-model update. Doc-only.

## 2. Motivation

### 2.1 Evidence from code — model switch is destructive

`src/FaissIndexManager.ts:33` derives `MODEL_NAME_FILE` as a single, top-level `${FAISS_INDEX_PATH}/model_name.txt`. The atomic write at `src/FaissIndexManager.ts:43-47` (`writeModelNameAtomic`) is unconditional under the read-write path; `initialize()` reads it back at `349-354`, compares to the configured model at `356`, and on mismatch deletes the entire `${FAISS_INDEX_PATH}/faiss.index/` directory at line `364`. The previous embeddings are gone.

```ts
// src/FaissIndexManager.ts:356-371
if (storedModelName && storedModelName !== this.modelName) {
  logger.warn(`Model name has changed from ${storedModelName} to ${this.modelName}. Recreating index.`);
  if (await pathExists(indexFilePath)) {
    await fsp.rm(indexFilePath, { recursive: true, force: true });
  }
  this.faissIndex = null;
}
```

### 2.2 Operator pain — comparative analysis is the actual product

The operator's report verbatim (issue [#100](https://github.com/jeanibarz/knowledge-base-mcp-server/issues/100)):

> "Do you think it could be a good feature to enable support of multiple embedding models to the knowledge base tools? Allowing to switch models for comparative analysis for example without having to rebuild every time the index because model has been changed?"

The framing is **comparative analysis** — a verb, not a noun. The natural workflow is:

1. Operator has nomic-embed-text running on Ollama (free, local, ~3.79 MiB binary at the current 1294-vector corpus).
2. Operator wants to compare against OpenAI text-embedding-3-small. Today: pay for the embed pass and **lose** nomic. To go back: pay again.
3. Operator wants `kb compare <query> ollama__nomic openai__text-embedding-3-small` and a unified table showing rank/score per model. Today this requires terminal-pane eyeballing.

RFC 013 ships indexes coexisting (G1-G6) **and** the comparison primitive (G11). Round-1 ambition-amplifier F1 made this case decisively: shipping multi-model rails without `kb compare` is shipping the engine without a steering wheel.

### 2.3 Operator pain — RFC 012's mismatch check has no third option

RFC 012's model-mismatch check (`src/cli.ts:269-288`) detects env divergence between CLI and MCP and offers two recoveries: align the env, or `--refresh` to rebuild. Neither lets the operator **keep both models alongside**. Multi-model is the natural answer to the question that error message exists in the absence of.

### 2.4 What today's storage cost looks like, measured

Empirically validated against the operator's actual `${FAISS_INDEX_PATH}` (round-1 design-experimenter — §10 E1):

```
/home/jean/knowledge_bases/.faiss/
├── faiss.index/
│   ├── faiss.index    3,975,213 B = 3.79 MiB    (1294 × 768 × 4 + 45 B header)
│   └── docstore.json  1,894,260 B = 1.81 MiB    (chunk text + metadata)
└── model_name.txt     27 B                       ("nomic-embed-text:latest\n")
```

**FAISS storage formula** (verified for D ∈ {384, 768, 1024, 1536} at N=1294 — all four cases produced exactly `N × D × 4 + 45` bytes):

| Provider | Model | Dim | Binary at 1294 vec | Docstore | Total per model |
|---|---|---|---|---|---|
| Ollama | `nomic-embed-text:latest` | 768 | 3,975,213 B (measured) | 1,894,260 B | ~5.6 MiB |
| Ollama | `dengcao/Qwen3-Embedding-0.6B:Q8_0` (current default) | 1024 | 5,300,269 B (computed) | 1,894,260 B | ~6.9 MiB |
| OpenAI | `text-embedding-3-small` | 1536 | 7,950,381 B (computed) | 1,894,260 B | ~9.4 MiB |
| HuggingFace | `BAAI/bge-small-en-v1.5` | 384 | 1,987,629 B (computed) | 1,894,260 B | ~3.7 MiB |

The "computed" rows are not estimates — the formula is exact (45 B header is flat, model-independent). Three models side-by-side for this KB ≈ 19 MiB. At 10× growth (~13 k vectors): ~190 MiB. **Storage is not the binding constraint; embedding wall time and (paid providers) money are.**

### 2.5 Why this is a separate RFC, not a tweak to RFC 012

RFC 012 §4.7 (model-mismatch check) and §4.8.2 (write lock) **assume one model per `FAISS_INDEX_PATH`**. The on-disk layout, the lock path, and the CLI's error message are all single-model-shaped. Folding multi-model into RFC 012 would have made it a 1500-line document that didn't ship; keeping them separate let RFC 012 land, get reviewed, and get used. RFC 013 extends it.

## 3. Goals / Non-goals

### 3.1 Goals

- **G1.** Two or more embedding models live side-by-side under one `FAISS_INDEX_PATH`. Adding model B does not delete model A's vectors.
- **G2.** `kb search --model=<id>` returns results from the specified model. Default `kb search` uses the active model.
- **G3.** MCP `retrieve_knowledge` gains an optional `model_name` argument with the same semantics. Tools that didn't pass the argument keep working unchanged.
- **G4.** A long-running `kb models add` against model B does not block `kb search` against model A. The fast path (read against active model) is unaffected by writers in other model directories.
- **G5.** Existing 0.2.x deployments auto-migrate on first 0.3.0 start. No manual `kb models import`. No data loss.
- **G6.** Embedding-cost UX is honest: paid providers show estimated cost + provider pricing URL and prompt for confirmation. Non-TTY contexts require `--yes` or exit 2 — never block on stdin (round-1 failure F9). Free providers show estimated wall time only.
- **G7.** Freshness signal identifies which model produced the results. When `kb compare` runs, the footer shows comparative freshness gap between the two models (round-1 ambition F9).
- **G8.** On-disk layout has a deterministic, filesystem-safe `<model_id>` derivation. Same `(provider, model_name)` as typed produces the same id on any machine.
- **G9.** Removing a model is a single command (`kb models remove <id>`) with confirmation. Removing the active model is refused unless the operator names a new active model first.
- **G10.** Threat model and on-disk-layout docs reflect the new shape — `${FAISS_INDEX_PATH}` is still the trust boundary, now containing a `models/` subtree.
- **G11.** `kb compare <query> <model_a> <model_b>` returns a unified rank-and-score table over both models' top-k. Lands in M2 (round-1 ambition F1).
- **G12.** **Embedding-model selection workflow.** A user choosing between two embedding models (e.g. nomic-embed-text vs bge-small-en-v1.5) can run `npm run bench:compare -- --models=<id_a>,<id_b>` against the bundled fixture or their own KB and get a self-contained HTML report covering: cold-start indexing time + RSS + tokens + estimated cost; warm-query latency p50/p95/p99 (single-query); batch-query throughput and tail latency under concurrency 1→N; on-disk storage per model; cross-model top-k agreement (Jaccard + Spearman) + recall@10 if a golden set is supplied. The report includes a "Recommendation" panel that picks a winner per axis (latency-sensitive / cost-sensitive / quality-sensitive). The orchestrator dogfoods M0-M4 (`kb models add`, `kb search --model=<id>`, `kb compare`, `kb models list`, `kb models remove`); shipping it without those rails is impossible by construction. Lands in M5 (operator request 2026-04-26).

### 3.2 Non-goals

- **N1.** Cross-model retrieval fusion (RRF, ensemble re-ranking). The user can query each model and `kb compare` externally; fusion is its own design space.
- **N2.** Re-embedding optimisation (incremental, batch-resumable). `kb models add` reuses the existing per-file SHA256 sidecar logic at `src/FaissIndexManager.ts:528-589`; if it crashes, the next call resumes.
- **N3.** Per-KB model selection. Out of scope here; would require a per-KB config file. Round-1 ambition F2 pushed back; deferred to **a future RFC seed in §8.9** rather than buried.
- **N4.** ~~Atomic `FaissStore.save()`. RFC 012 N7 already deferred this; per-model isolation narrows the blast radius (a save mid-write only affects readers of that one model). Tracked separately.~~ **Lifted by [RFC 014](./014-atomic-faiss-save.md)** — versioned-dir layout with symlink swap and reader-side pre-resolution makes save+load directory-atomic for the versioned layout.
- **N5.** Removing the existing `EMBEDDING_PROVIDER`/`OLLAMA_MODEL`/etc. env vars. They keep their meaning ("default model when nothing else is specified"). `KB_ACTIVE_MODEL` overrides; `active.txt` is the persisted default.
- **N6.** GUI / dashboard. Pure CLI + MCP surface.
- **N7.** Quantized index types (`IndexIVFPQ`). Storage isn't the binding constraint per §2.4. Tracked separately if it ever is.
- **N8.** Sharing `docstore.json` across models via hardlink. Round-1 ambition F7 + empirical E5 verified the chunk *content* is byte-identical across models, but `FaissStore` assigns fresh per-document UUIDs on every save, so naive hardlink fails. A canonicalize-then-hardlink pass is tractable but saves only ~1.81 MiB × (M-1) — not worth v1 complexity for ≤4-model deployments. Future-RFC seed in §8.9.
- **N9.** Cumulative cost tracking (`models/<id>/.cost.json`). Round-1 ambition F4 proposed it; deferred — adds bookkeeping that minimalist F4 cut from upstream design. Future-RFC seed.
- **N10.** Academic IR benchmarking (BEIR, MTEB, MS MARCO leaderboards). The bundled fixture is large enough to be **insightful for selection** (~3000 chunks, statistically meaningful latency bands, query overlap signal), not large enough for **published claims**. M5's HTML report explicitly disclaims this in its "Recommendation" panel: "Use this report to choose between the two models for **your KB**; it is not an MTEB-grade leaderboard." A future RFC may add MTEB integration if a use case appears.
- **N11.** A new `kb-bench` CLI binary. M5 piggybacks on the existing `npm run bench` entrypoint (RFC 007 PR 0.1 baseline); the new behavior is a flag (`bench:compare`). Adding a second installable binary expands the public surface; not worth it for a maintainer/operator workflow.

## 4. Design

### 4.1 Surface decision matrix

The core surface question is **how the on-disk layout, active-model selection, and per-call model selection interact**.

| Option | On-disk layout | Active selection | Per-call override | Verdict |
|---|---|---|---|---|
| **A. Status quo** | `${PATH}/faiss.index/` | env vars only | none (rebuild required) | Rejected — issue #100 exists. |
| **B. Side-by-side, env-var only** | `${PATH}/<provider>__<model>/faiss.index/` | env vars resolve at startup | none | Rejected — no per-call override means MCP can't compare. |
| **C. Side-by-side, deterministic id, no `active.txt`** | `${PATH}/models/<id>/faiss.index/` | `KB_ACTIVE_MODEL` env > legacy env vars | CLI `--model=<id>`, MCP `model_name` | Rejected — round-1 minimalist F2 argued for this; rejected because operators on shells without env-var alignment hit RFC 012 mismatch errors on every invocation, and `mcp.json` is a static file rare to edit. |
| **D. Side-by-side, deterministic id, `active.txt`, env override** *(adopted)* | `${PATH}/models/<id>/faiss.index/` | `active.txt` (migration / `set-active`); `KB_ACTIVE_MODEL` env overrides | CLI `--model=<id>`, MCP `model_name` | Adopted. |
| **E. Per-model `FAISS_INDEX_PATH`** | Operator runs N MCP servers with N paths | trivially separate | trivially separate | Rejected — defeats §2.2 goal of comparing within one session; doubles process supervision. |
| **F. Single index with model dimension as an axis** | One `IndexIDMap2`-style structure | not applicable | not applicable | Rejected — FAISS native indexes are fixed-dim; would need an index-per-dim wrapper, which is exactly D. |

Option D is adopted. The rest of §4 specifies it.

### 4.2 Recommended design (Option D)

```
${FAISS_INDEX_PATH}/
├── active.txt                          # one line: <model_id> of the active model
├── .kb-mcp.pid                         # unchanged — single-instance advisory (RFC 012 §4.8.1)
└── models/
    ├── ollama__nomic-embed-text-latest/
    │   ├── faiss.index/
    │   │   ├── faiss.index             # 1294 × 768 × 4 + 45 B header (E1-validated formula)
    │   │   └── docstore.json           # chunk text + metadata
    │   ├── model_name.txt              # full model name, scoped to this dir (round-1 boundary F9 — readers take modelId param)
    │   ├── .kb-write.lock              # per-model write lock
    │   └── .adding                     # sentinel — present only during in-flight `kb models add` (round-1 delivery F3, failure F6)
    ├── openai__text-embedding-3-small/
    │   └── ... (same shape)
    └── huggingface__BAAI-bge-small-en-v1.5/
        └── ... (same shape)
```

Invariants:

- **One `models/<id>/` subdirectory per registered model.** Adding creates it; removing deletes it. The directory is the unit of isolation.
- **`active.txt` is authoritative** for "which model does default `kb search` and unscoped MCP `retrieve_knowledge` use". One line, no trailing-newline tolerance gotchas — see §4.7 robust reader.
- **Single-writer for `active.txt`:** only `kb models set-active` and the migration write to it. **`updateIndex` and `kb models add` MUST NOT touch it** (round-1 failure F7). Asserted by a Jest test.
- **`KB_ACTIVE_MODEL` env overrides `active.txt`** for the process lifetime. Lets a CI run pin a specific model without mutating disk. If the env names a non-existent model, the process fails fast.
- **Per-model lock paths.** Acquired by directory, not by model id (round-1 boundary F1 — `withWriteLock(resource, fn)` is the lock primitive's signature; the resource IS the model dir). Single-instance PID advisory stays root-level (one MCP per `FAISS_INDEX_PATH` constraint is unchanged).
- **`.adding` sentinel** at `models/<id>/.adding` is written before any embedding work and removed on success. `kb models list`, `list_models` MCP tool, and the migration code skip directories with `.adding` present. Catches the partial-add interrupt failure mode.

### 4.3 Deterministic `<model_id>` derivation

```ts
// src/model-id.ts (NEW — M1)
export function deriveModelId(
  provider: 'ollama' | 'openai' | 'huggingface',
  modelName: string,
): string {
  // Filesystem-safe: replace any character not in [A-Za-z0-9._-] with `-`.
  // Collapse runs of `-`. Trim leading/trailing `-`. Lowercase the provider.
  // `__` separator so `-` collisions are impossible.
  const slug = modelName.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (`${provider}__${slug}`.length > 240) {
    throw new ModelIdTooLongError(provider, modelName);
  }
  return `${provider.toLowerCase()}__${slug}`;
}

export function parseModelId(id: string): { provider: string; slugBody: string } {
  const m = /^([a-z]+)__([A-Za-z0-9._-]+)$/.exec(id);
  if (!m) throw new InvalidModelIdError(id);
  return { provider: m[1], slugBody: m[2] };
}
```

Examples:

| (provider, modelName) | `<model_id>` |
|---|---|
| `('ollama', 'nomic-embed-text:latest')` | `ollama__nomic-embed-text-latest` |
| `('openai', 'text-embedding-3-small')` | `openai__text-embedding-3-small` |
| `('huggingface', 'BAAI/bge-small-en-v1.5')` | `huggingface__BAAI-bge-small-en-v1.5` |
| `('ollama', 'dengcao/Qwen3-Embedding-0.6B:Q8_0')` | `ollama__dengcao-Qwen3-Embedding-0.6B-Q8_0` |

**Determinism caveat (round-1 failure F13):** the slug is derived from `(provider, modelName)` **as typed**, not canonicalized. `OLLAMA_MODEL=nomic-embed-text` and `OLLAMA_MODEL=nomic-embed-text:latest` both pull the same model from Ollama at request time but produce different ids on disk. Operators sharing a `models/` subtree across machines must pin env values exactly. Documented in §7 + M4 quickstart.

**Round-1 minimalist F8 incorporated:** the truncate-and-hash fallback for >255-byte path components is **dropped**; `deriveModelId` throws `ModelIdTooLongError` for overlong names. No model in any provider's catalogue today exceeds 100 chars; the throw is a clear error pointing at env config rather than a silent hash.

### 4.4 CLI surface

```
kb search <query> [--model=<id>] [--refresh] [...]      # --model overrides active for this call only
kb compare <query> <model_a> <model_b> [--k=<int>]      # M2 — unified rank/score table

kb models list                                          # table: id, provider, model, dim, vec count, on-disk size, active marker
kb models add <provider> <model> [--yes] [--dry-run]    # ingest under deriveModelId(provider, model)
kb models set-active <id>                               # update active.txt
kb models remove <id> [--yes]                           # delete ${PATH}/models/<id>/ after confirmation
```

#### `kb models add` flow

1. Resolve `<model_id>` via `deriveModelId(provider, model)`. If `models/<id>/` exists and lacks `.adding`: error 2 — "Model already registered. Use `kb search --model=<id> --refresh` to re-embed, or `kb models remove <id>` first." If `models/<id>/` exists *with* `.adding`: error 2 — "Previous `kb models add` was interrupted. Run `kb models remove <id>` to clean up, then retry."
2. Walk `KNOWLEDGE_BASES_ROOT_DIR` via `getFilesRecursively + filterIngestablePaths`. Sum byte total; estimate chunks (`bytes / 800`) and tokens (`bytes / 4`).
3. **TTY check first** (round-1 failure F9): `if (!process.stdin.isTTY && !args.yes) { exit(2, 'kb models add is interactive without --yes') }`. Never block on stdin.
4. Print to stderr:
   ```
   Adding model: openai__text-embedding-3-small (provider=openai, model=text-embedding-3-small, dim=1536)
   Will embed: 249 files (~1295 chunks, ~1.3 MB of text, ~325k tokens)
   Estimated cost: ~$0.0065 (OpenAI text-embedding-3-small at $0.02/1M tokens)
   See provider pricing: https://openai.com/api/pricing
   Continue? [y/N]:
   ```
5. On `y` (or `--yes`): `mkdir -p models/<id>`, `touch models/<id>/.adding`, acquire per-model write lock, run `FaissIndexManager.initialize() + updateIndex()`, on success delete `.adding`. **If `active.txt` does not exist, atomically write the new model_id as active** (round-2 failure N2 — fresh-install operator's first-added model becomes active by convention, otherwise step-4 fallback's silent env-var dependency surprises them). On `--dry-run`: print the estimate and exit 0; no directory created.
6. Free providers (Ollama) skip the dollar line but keep chunk + wall-time estimate.

**Retry UX** (round-2 failure N4). On interrupt (`SIGINT` / network drop), `.adding` persists and `kb models add` re-invocation in step 1 errors with: *"Previous `kb models add` was interrupted at chunk N/M (~$X already spent on partial embedding). Run `kb models remove <id> --force-incomplete` to clean up, then retry from chunk 1 (re-spending ~$X). A `--resume` flag is a future-RFC seed (§8.9)."* The chunk-count comes from a `models/<id>/.adding-progress.txt` written every batch (~10 chunks). Operator sees the cost-of-retry up front; no surprise spend.

**`kb search --refresh` cost-prompt note** (round-2 failure N6). `kb search --model=<id> --refresh` does **NOT** prompt — it runs the existing per-file SHA256 sidecar logic, which only re-embeds *changed* files. Documented explicitly here so operators aren't surprised when a `--refresh` after dropping 5,000 new files into the corpus runs without confirmation. For paid providers, the cost-of-incremental-embed is the operator's responsibility; future RFC may add a "delta cost" prompt (§8.9 seed).

**Cost constants live in `src/cost-estimates.ts`** with a `LAST_VERIFIED: YYYY-MM-DD` comment and provider-pricing URLs. **Quarterly manual review** — the maintainer hand-checks each URL once a quarter; CI does NOT validate pricing (round-1 delivery F4 — provider pricing pages are JS-rendered; v1's "10% drift gate" was aspirational).

#### `kb models remove` flow

Refuses to remove the active model without first running `set-active <other>`. Refuses to remove a model with `.adding` present (says "use `--force-incomplete` if recovering an interrupted add"). **Safe while MCP is running** — empirically validated by round-1 design-experimenter E6: `faiss-node` reads the index into memory at `.load()` time, doesn't mmap. Unlinking the file affects only future `.load()` calls; the in-memory store keeps working until process exit. F10 (failure-mode round-1) was falsified.

#### `kb compare` flow (M2)

Run `similaritySearchWithScore(query, k)` against both models. Build a `Map<chunk_text_hash, {rank_a, score_a, rank_b, score_b}>`. Render a fixed-width table sorted by `min(rank_a, rank_b)`. Round-1 ambition F1 — operator workflow, not "shell `diff`-able."

```
rank_a  rank_b  score_a  score_b  in_both  doc_path:line
  1       3      0.81     0.62      yes     notes/foo.md:42
  2       —      0.78      —        no      notes/bar.md:11
  —       1       —       0.71      no      notes/baz.md:88
```

**Failure semantics** (round-2 failure N5). If either model is unresolvable (not registered, has `.adding` sentinel, or its `faiss.index/` is corrupt), `kb compare` fails-fast with `exit 2` naming the bad model — never renders a half-table. Scores are NOT normalized across models (cosine-distance scales differ); the table shows raw scores per model with the column header noting "(model A is L2 / model B is cosine — scores not directly comparable)" if dim or distance metric differs. The query embedding is computed twice (once per provider — they cannot share); for paid providers, both calls are billed. No cost prompt for `kb compare` — the per-query cost is below the threshold where prompts add value (the operator who runs `kb compare` is in interactive comparison mode and expects API calls).

**Boundary refinement (round-1 boundary F6 + round-2 boundary F4 — `cli.ts` size pressure).** Search and read-helpers split out so `cli.ts` stays a thin router:

- `src/cli.ts` (~150 LoC) — argv top-level dispatch, `--help`, `--version`, lazy-import dispatch.
- `src/cli-search.ts` — `runSearch`, `parseSearchArgs`, `checkModelMismatch`, `computeStaleness`, `formatFreshnessFooter`. Lazy-imported on `kb search`.
- `src/cli-read.ts` — `loadModelForRead(modelId): Promise<FaissIndexManager>` (handles construction + `loadWithJsonRetry`). Imported by both `cli-search.ts` and `cli-compare.ts` (round-2 boundary F3 — prevents the duplicated read-path drift).
- `src/cli-models.ts` — `kb models {list, add, set-active, remove}`. Lazy-imported on `kb models <verb>`.
- `src/cli-compare.ts` — `kb compare`. Lazy-imported on `kb compare`.
- `src/cli-list.ts` — `kb list` (the existing KB-list, not models). Lazy-imported.

CI smoke step asserts via `node --trace-warnings` that `kb search` doesn't open `cli-models.js`, `cli-compare.js`, or `cli-list.js` from disk.

### 4.5 MCP surface

```ts
// schema for retrieve_knowledge — additive
{
  query: z.string(),
  knowledge_base_name: z.string().optional(),
  threshold: z.number().optional(),
  model_name: z.string().optional()  // NEW — the <model_id>; default is active model
}

// new tool
mcp.tool('list_models', LIST_MODELS_DESCRIPTION, async () => {
  const models = await listRegisteredModels();   // skips .adding sentinels
  return { content: [{ type: 'text', text: JSON.stringify(models, null, 2) }] };
});
```

`list_models` returns `[{ model_id, provider, model_name, dim, vector_count, active, notes? }, ...]` — same shape as `kb models list --format=json`. The optional `notes` field reads from `models/<id>/.notes.txt` (round-1 ambition F3 — operator-populated context for "good for code queries, weak on non-English"). Round-1 minimalist F3 argued for cutting `list_models` entirely and listing models in the tool description string; rejected because the model set changes during a session (operator runs `kb models add` from a terminal while MCP is running) and a static-at-startup tool description would go stale.

**Mismatch handling**: if the agent passes a `model_name` not registered, `retrieve_knowledge` returns `isError: true` with the registered list — same envelope shape as today.

**No `add_model` / `set_active_model` MCP tools in this RFC** (round-1 ambition F6 reframing — deferred, not vetoed): a future RFC may introduce them with MCP elicitation semantics so the agent surfaces the cost estimate and the operator confirms in-session. Tracked as **OQ8**.

**`model_id` on the response envelope** (round-1 minimalist F5): the `retrieve_knowledge` MCP wire output is unchanged for callers that don't pass `model_name`. When `model_name` is passed (or when `kb search --format=json` runs), the response gains a single top-level `model_id` field — **not** per-chunk. A query is monomodal by construction; per-chunk duplication is wasted bytes. `kb compare` returns a JSON array of two response objects, each with its own `model_id`.

**Sanitizer note (round-1 boundary F5):** `src/formatter.ts:sanitizeMetadataForWire` is **strip-by-default-on-`frontmatter.extras`**, not a positive whitelist. Adding `model_id` to chunk-level metadata isn't a whitelist edit — it just appears on the wire if `FaissIndexManager` writes it. Since this RFC moves `model_id` to the response envelope (not chunk metadata), no sanitizer change is needed. RFC v1's "extend the whitelist by one field" wording was wrong; corrected here.

### 4.6 Lock design — module split + per-model resource

Round-1 boundary F1 + F7 + RFC 012 round-3 deferred nit: split `lock.ts` and re-parameterize `withWriteLock`.

```ts
// src/instance-lock.ts (NEW — M1; moved from src/lock.ts)
export class InstanceAlreadyRunningError extends Error { /* ... */ }
export async function acquireInstanceAdvisory(): Promise<void> { /* O_EXCL on ${FAISS_INDEX_PATH}/.kb-mcp.pid */ }
export async function releaseInstanceAdvisory(): Promise<void> { /* unlink */ }

// src/write-lock.ts (NEW — M1; moved from src/lock.ts)
export async function withWriteLock<T>(
  resource: string,                  // absolute directory path; the lock primitive doesn't know about models
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(resource, '.kb-write.lock');
  await fsp.mkdir(resource, { recursive: true });
  const release = await properLockfile.lock(resource, { ...WRITE_LOCK_OPTS, lockfilePath: lockPath });
  try { return await fn(); } finally { await release(); }
}
```

Callers compute the resource path:

- `KnowledgeBaseServer.handleRetrieveKnowledge`: `resolveActiveModel({explicitOverride: args.model_name})` → modelDir → `withWriteLock(modelDir, ...)`.
- `ReindexTriggerWatcher`: `resolveActiveModel()` → modelDir per fire (long-lived watcher, picks up active changes — round-1 boundary F9 + failure F7 noted that `updateIndex` must NOT itself write `active.txt`; this resolves the active model before each fire's lock acquire and write).
- `kb search --refresh`: argv `--model` takes precedence over active.
- `kb models add`: derived id from `(provider, model)`.

The `lock.ts` module disappears in M1; M1 PR title notes the split. RFC 012 round-3 deferred this nit; multi-model is the moment to act on it.

#### Why per-model granularity is the right call

Round-1 minimalist F6 argued for collapsing back to one shared lock. Rejected because:

- The whole point of multi-model is concurrent operations on different models. A `kb models add B` that takes 5 minutes against OpenAI must NOT block a `kb search --model=A` (the active model) because the operator is comparing.
- `ReindexTriggerWatcher`'s 5-second poll fires `updateIndex` against the active model. With one shared lock, every `kb models add B` blocks the watcher from polling A — a degradation invisible at first, painful in the dogfood loop.
- Empirical E3: per-model lock-path nesting adds <0.1 ms p95 vs RFC 012 baseline. The cost is below noise; the benefit (independent writers) is the design intent.

#### Slow path

A `kb search --model=A --refresh` against the active model holds A's lock for the duration of the re-embed (multi-minute on full re-build). MCP retrievals against A block. Retrievals against B continue. Identical to RFC 012 single-model behavior on its own model; bounded by the same operator-awareness mitigation. Documented in M4.

### 4.7 `active.txt` semantics, robust reader, atomic writer

```
${FAISS_INDEX_PATH}/active.txt:
ollama__nomic-embed-text-latest
```

**Resolution order** (sole owner: `src/active-model.ts:resolveActiveModel(opts?)`):

1. If `opts.explicitOverride` is set (`args.model_name` for MCP, `--model=<id>` for CLI): validate it parses + the directory exists + no `.adding` sentinel. Else error.
2. Else if `KB_ACTIVE_MODEL` env is set (read via `config.ts`-exported constant — round-1 boundary F8): validate it; error if invalid or model missing.
3. Else read `${FAISS_INDEX_PATH}/active.txt`. Robust read (round-1 failure F2, F3 + round-2 failure N3 hard-fail):
   - Strip BOM (first 3 bytes if `EF BB BF`).
   - `.replace(/\r/g, '').trim()`.
   - Validate against `^[a-z]+__[A-Za-z0-9._-]+$`.
   - **File doesn't exist OR is empty / whitespace-only after BOM+CRLF strip** → fall through to step 4 (legitimate fresh-install case).
   - **File exists with non-empty content that fails regex validation** → **hard-fail** (round-2 failure N3): log the raw bytes (hex-dumped, length-bounded to 256) AND the would-be env-derived fallback id, and exit 2 with: *"`active.txt` is malformed. Found bytes: `<hex>`. Either edit it to a registered model_id (run `kb models list`), or delete it to fall back to env-var resolution (would resolve to `<env-derived-id>`)."* Silent fallthrough on a typo would silently override operator intent.
4. Else (no `active.txt`, or empty), resolve from legacy env vars (`EMBEDDING_PROVIDER` + `OLLAMA_MODEL`/etc.). Validate that `models/<id>/` exists with no `.adding`. If not, fail-fast with: "No model registered. Run `kb models add <provider> <model>` first."

**Single resolver across CLI and MCP** (round-1 boundary F4): `resolveActiveModel` is the ONLY entry point. CLI passes `argv.model` as `explicitOverride`; MCP `handleRetrieveKnowledge` passes `args.model_name`. Two implementations are forbidden.

**Atomic writer** (`writeActiveModelAtomic` in `active-model.ts`): tmp + rename, same pattern as `writeModelNameAtomic` (RFC 012 §4.7). **Three permitted callers** (round-1 boundary F10 + failure F7 + round-2 failure N2):

1. `FaissIndexManager.bootstrapLayout` — when migrating a 0.2.x layout (one-shot per upgrade).
2. `cli-models.ts:setActive` — explicit operator command.
3. `cli-models.ts:add` — only when `active.txt` is absent (fresh-install first-model auto-promotes).

**`updateIndex`, `kb models remove`, and the trigger watcher MUST NOT write `active.txt`.** Asserted by a **grep-based Jest test** (round-2 boundary F6 + round-2 failure N7 — runtime-mock can't distinguish "FaissIndexManager.maybeMigrateLayout calls writer (allowed)" from "FaissIndexManager.updateIndex calls writer (forbidden)"). The test runs `globby('src/**/*.ts')`, parses each via `ts.createSourceFile`, walks for `writeActiveModelAtomic` call expressions, asserts the enumerated call sites match the three above and no others. ~30 LoC.

### 4.8 Auto-migration from 0.2.x layout — `bootstrapLayout()` separate from `initialize()`

Round-2 boundary F2: v2 folded migration into `FaissIndexManager.initialize()`, but `initialize()` then conflated three lifecycle phases (process-global advisory, one-shot directory recovery, per-instance load). v3 splits:

- **`FaissIndexManager.bootstrapLayout()`** — module-static, idempotent, runs at most ONCE per Node process. Acquires the appropriate cross-process serializer (instance advisory if no MCP holds it, else `${PATH}/.kb-migration.lock` for CLI), runs `maybeMigrateLayout()`, releases. Module-level `Promise<void>` cache prevents same-process double-call (round-2 failure N1 — tests, or `kb models add` constructing a fresh manager after `KnowledgeBaseServer` already constructed one).
- **`FaissIndexManager.prototype.initialize(opts)`** — per-instance, load-only. Loads `${PATH}/models/<this.modelId>/faiss.index/`, optionally writes `model_name.txt` (existing read-only flag). No migration, no advisory. Cheap.

`KnowledgeBaseServer.run()` calls `acquireInstanceAdvisory()` then `FaissIndexManager.bootstrapLayout()` then constructs the manager. CLI `cli.ts:main()` calls `FaissIndexManager.bootstrapLayout()` once at top of subcommand dispatch. Both then construct managers and call `.initialize()` per-model.

**Migration policy decision (was OQ3 — round-2 boundary F7 promotes to RFC-level).** When the 0.2.x layout has `faiss.index/` but **no `model_name.txt`** (pre-RFC-012 indexes, or hand-edited state), refuse migration with a clear recovery message. When `model_name.txt` is present but `EMBEDDING_PROVIDER` env is unset, **trust `model_name.txt`** and combine it with the `config.ts:12` default provider (`huggingface`) — the file was written by a previous server run; trusting it is the conservative answer per round-1 failure F5. Documented; not deferred.

```ts
// FaissIndexManager.ts — pseudo-code (round-2 boundary F2 incorporation)

let bootstrapPromise: Promise<void> | null = null;   // module-level cache (round-2 failure N1)

export class FaissIndexManager {
  static async bootstrapLayout(): Promise<void> {
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      // Cross-process serializer: held by self if MCP, else short-lived migration lock for CLI.
      const isOurAdvisory = await tryAcquireInstanceAdvisory();   // false if MCP already holds it
      const release = isOurAdvisory ? null : await properLockfile.lock(FAISS_INDEX_PATH, {lockfilePath: ...migration.lock, ...});
      try {
        await maybeMigrateLayout();
      } finally {
        if (!isOurAdvisory && release) await release();
      }
    })();
    return bootstrapPromise;
  }

  async initialize(opts: { readOnly?: boolean } = {}): Promise<void> {
    // Pure load. No migration. No advisory. Cheap, per-instance.
    // ... existing logic, scoped to ${PATH}/models/<this.modelId>/faiss.index/
  }
}

async function maybeMigrateLayout(): Promise<void> {
  const oldIndexDir = path.join(FAISS_INDEX_PATH, 'faiss.index');
  const oldModelFile = path.join(FAISS_INDEX_PATH, 'model_name.txt');
  const newModelsDir = path.join(FAISS_INDEX_PATH, 'models');

  if (!(await pathExists(oldIndexDir)) || (await pathExists(newModelsDir))) return;

  // Pre-RFC-012 indexes (no model_name.txt) — round-1 failure F5: refuse migration.
  const oldModelName = await readStoredModelNameAt(oldModelFile);
  if (oldModelName === null) {
    throw new MigrationRefusedError(
      `Cannot determine which model built ${oldIndexDir} — model_name.txt is missing. ` +
      `Set EMBEDDING_PROVIDER + the model env vars to the values used when the index was built, ` +
      `OR delete ${oldIndexDir} and let 0.3.0 re-embed under the current env.`
    );
  }

  // OQ3 promoted to design (round-2 boundary F7): if env unset, trust model_name.txt + config.ts default.
  const provider = process.env.EMBEDDING_PROVIDER ?? 'huggingface';
  const modelId = deriveModelId(provider as EmbeddingProvider, oldModelName);
  const targetDir = path.join(newModelsDir, modelId);
  await fsp.mkdir(targetDir, { recursive: true });

  // Two atomic renames. ENOENT-tolerant: peer process may have already moved.
  await renameIfPresent(oldIndexDir, path.join(targetDir, 'faiss.index'));
  await renameIfPresent(oldModelFile, path.join(targetDir, 'model_name.txt'));

  // Single-writer for active.txt.
  await writeActiveModelAtomic(modelId);

  // Cleanup: stray model_name.txt at the root (crash-recovery from F1 race).
  await fsp.unlink(oldModelFile).catch(() => {});

  logger.info(`Migrated single-model layout to models/${modelId}/`);
}
```

Properties:

- **Idempotent.** `pathExists(newModelsDir)` early-return.
- **Atomic at the FS level.** `fsp.rename` is atomic on POSIX; ENOENT-tolerant for peer-races (round-1 failure F4).
- **Crash-safe between renames.** Partial state = `models/<id>/faiss.index/` exists, `oldModelFile` may still be at root. Next start: `hasNewModels` → early-return; the next `initialize()` cleanup pass deletes any straggler. The §4.7-step-3 fallback also protects against orphaned root `model_name.txt`.
- **Pre-`MODEL_NAME_FILE`-becoming-per-instance guard** (round-1 failure F1): a Jest test asserts that no module imports the old module-level `MODEL_NAME_FILE` constant after M1 lands. If migration ran but `writeModelNameAtomic` is still pointed at the old root path, the test fails the build.
- **No data loss.** Only `rename` calls + best-effort cleanup; no `unlink` of vector data.
- **Pre-publish smoke runs 6 sub-cases** (round-1 delivery F9): canonical 0.2.x, empty `model_name.txt`, missing `model_name.txt` (refused), single-file pre-#57 `faiss.index`, empty `${PATH}/`, partial-migrated state.

### 4.9 New / changed files

#### M1+M2 (combined PR — round-1 minimalist F9 + delivery F5)

| File | Change |
|---|---|
| `src/model-id.ts` | NEW — `deriveModelId`, `parseModelId`, `ModelIdTooLongError`, `InvalidModelIdError`. |
| `src/active-model.ts` | NEW — **sole owner of the `models/<id>/` directory schema and active-model resolution** (round-2 boundary F1 — merged `index-paths.ts` into here). Exports: `resolveActiveModel(opts?)`, `writeActiveModelAtomic`, `readActiveModelRaw`, `modelDir(modelId)`, `readStoredModelName(modelId)`, `faissIndexBinaryPath(modelId)`, `isRegisteredModel(modelId)`, `listRegisteredModels()` (round-2 boundary F5 — single-source for the registration predicate). Robust reader hard-fails on regex-fail (round-2 failure N3). Reads `KB_ACTIVE_MODEL` from `config.ts` exported constant. |
| `src/instance-lock.ts` | NEW (M0 — lands in 0.2.2 patch ahead of M1+M2). Moved from `src/lock.ts`. `acquireInstanceAdvisory`, `releaseInstanceAdvisory`, `tryAcquireInstanceAdvisory` (returns false if already held — needed by bootstrap), `InstanceAlreadyRunningError`, `PID_FILE_PATH`. |
| `src/write-lock.ts` | NEW (M0). Moved from `src/lock.ts`. `withWriteLock(resource: string, fn): Promise<T>`. Resource is an absolute directory path; the lock primitive doesn't know about models. |
| `src/lock.ts` | DELETED in M0. M0 ships a one-line re-export shim if any external importer is found (none expected; internal-only API). |
| `src/FaissIndexManager.ts` | Constructor: `{ provider: 'ollama' \| 'openai' \| 'huggingface', modelName: string }` (round-1 boundary F2). `MODEL_NAME_FILE` becomes a per-instance property: `path.join(this.modelDir, 'model_name.txt')`. **Static `bootstrapLayout()` method** (round-2 boundary F2) with module-level `Promise<void>` cache (round-2 failure N1 — same-process double-init protection). `initialize()` is load-only. `maybeMigrateLayout` (module-private function, called only from `bootstrapLayout`). **Module-level `MODEL_NAME_FILE` removed** — grep-based Jest test asserts no `src/**/*.ts` imports the old constant (round-2 boundary F6). |
| `src/cli.ts` | **~150 LoC** (round-2 boundary F4). Argv top-level dispatch only: `--help`, `--version`, lazy-import per subcommand. Calls `FaissIndexManager.bootstrapLayout()` once before any subcommand handler. |
| `src/cli-search.ts` | NEW — `runSearch`, `parseSearchArgs`, `checkModelMismatch`, `computeStaleness`, `formatFreshnessFooter`. Hard-validates `--model=<id>` argv via slug regex before path-joining (round-1 failure F12). |
| `src/cli-read.ts` | NEW — `loadModelForRead(modelId): Promise<FaissIndexManager>` shared by `cli-search.ts` and `cli-compare.ts` (round-2 boundary F3 — prevents read-path drift). Owns `loadWithJsonRetry`. |
| `src/cli-models.ts` | NEW — `kb models {list, add, set-active, remove}`. TTY-checking, cost-estimate flow, `.adding` sentinel write+delete, `.adding-progress.txt` chunk-counter, third-permitted-writer of `active.txt` (only when absent — round-2 failure N2). |
| `src/cli-compare.ts` | NEW — `kb compare`. Two-model query + unified table. ~80 LoC. Imports from `cli-read.ts`. Hard-fails if either model is unresolvable (round-2 failure N5). |
| `src/cli-list.ts` | NEW — `kb list` (KB list, not model list). Lazy-imported. |
| `src/cost-estimates.ts` | NEW — provider per-1k-token costs + per-chunk wall time. `LAST_VERIFIED` comment + provider URLs. NO CI auto-fetch. |
| `src/KnowledgeBaseServer.ts` | `run()` calls `acquireInstanceAdvisory()` then `FaissIndexManager.bootstrapLayout()` then constructs the manager. `handleRetrieveKnowledge`: `await resolveActiveModel({explicitOverride: args.model_name})` → `withWriteLock(modelDir, () => updateIndex())`. Constructor takes `{ provider, modelName }` resolved from active. Adds response-envelope `model_id` field when `model_name` was passed (round-1 minimalist F5). |
| `src/triggerWatcher.ts` | `updateIndex` callback resolves active model per fire (long-lived watcher; picks up `set-active` changes on next tick). Wraps in `withWriteLock(modelDir, ...)`. |
| `src/config.ts` | Adds `KB_ACTIVE_MODEL` exported constant (round-1 boundary F8). |
| `src/migration.test.ts` | NEW — 6 seed-layout sub-cases (round-1 delivery F9). |
| `src/active-model.test.ts` | NEW — empty file, BOM, CRLF, regex-fail, valid, env override, `set-active` race. |
| `src/cli-models.test.ts` | NEW — TTY check, dry-run, `.adding` sentinel lifecycle, partial-add interrupt recovery. |
| `src/cli-compare.test.ts` | NEW. |
| `src/FaissIndexManager.test.ts` | Updated for new constructor; covers per-instance `modelNameFile`. |
| `smithery.yaml` | Adds `kbActiveModel` config prop (round-1 delivery F8 — Smithery deployments still single-model-only but at least surface the active-model env). |

#### M3 (separate PR)

| File | Change |
|---|---|
| `src/KnowledgeBaseServer.ts` | Registers `list_models` MCP tool. `retrieve_knowledge` schema gains `model_name?: string`. |
| `LIST_MODELS_DESCRIPTION` constant added to `config.ts`. | |
| `src/KnowledgeBaseServer.test.ts` | Updated — `list_models` returns expected shape; `model_name` arg routes to right model; `isError: true` on unknown model. |

#### M4 (docs — separate PR)

`README.md`, `docs/clients.md`, `docs/architecture/threat-model.md`, CHANGELOG entry.

#### M5 (benchmarking skill — separate PR)

See §4.13.7 for the full file table. Headline: `benchmarks/compare/{run.ts, render.ts, chart.ts, report-template.html, queries-default.txt}`, `benchmarks/scenarios/{batch-query.ts, index-storage.ts}`, extension to `benchmarks/{types.ts, run.ts, fixtures/generator.ts}`, `package.json` script `bench:compare`, `.github/workflows/bench-compare-dispatch.yml`, and (gated on RFC 002 landing) `.claude/skills/compare-embedding-models/SKILL.md`.

### 4.10 Cost-estimate flow (M2)

```
bytes = sum_files(stat(filePath).size)
chunks ≈ bytes / 800              // ~chunkSize=1000 with ~200 overlap
tokens ≈ bytes / 4                // English-text rule of thumb
cost   = (provider-pricing) * tokens / 1_000_000
wall   = chunks * provider_p50_per_chunk_ms / 1000
```

`src/cost-estimates.ts` constants (initial values; quarterly review):

```ts
// LAST_VERIFIED: 2026-04-25
// Pricing pages:
//   - https://openai.com/api/pricing
//   - https://huggingface.co/docs/inference-providers/pricing
//   - Ollama: free (local)
export const COSTS = {
  openai__text_embedding_3_small:  { usdPer1MTokens: 0.020, p50PerChunkMs: 200 },
  openai__text_embedding_3_large:  { usdPer1MTokens: 0.130, p50PerChunkMs: 200 },
  // HF inference providers free tier — rate-limited
  huggingface_default:             { usdPer1MTokens: 0,     p50PerChunkMs: 300 },
  ollama_default:                  { usdPer1MTokens: 0,     p50PerChunkMs: 50  },
};
```

Round-1 minimalist F4 argued for cutting the cost flow entirely. Rejected because `text-embedding-3-large` at scale is no longer "cents" (a 100k-vector KB at large model = ~$2 per re-embed, repeated mistakes add up). Round-1 delivery F4 was incorporated by dropping the CI auto-fetch — manual quarterly review only. Round-1 ambition F4 (cumulative tracking) deferred to §8.9 future-RFC seed.

### 4.11 Concurrency edge cases

- **`kb models add B` runs concurrently with MCP `retrieve_knowledge` (active=A).** Per-model locks disjoint. Both proceed.
- **`kb models add B` runs concurrently with `kb search --model=A --refresh`.** Per-model locks disjoint. Both proceed.
- **`kb models add B` runs concurrently with `kb models add B` (same id).** Per-model lock blocks the second. `proper-lockfile` retry budget exhausts; CLI exits "another writer is updating model B." Both `.adding` sentinels coexist transiently — that's fine (the sentinel is a coarse "in-progress" marker; the lock is the fine-grained serializer).
- **`kb models set-active B` runs concurrently with MCP startup reading `active.txt`.** Atomic write — readers see old or new, never partial. MCP server resolves `active.txt` once at startup and per-`updateIndex` fire (the trigger watcher resolves active each fire — round-1 boundary F9). New `kb` invocations also re-resolve. Documented behavior.
- **`kb models remove <id>` runs concurrently with `kb search --model=<id>`.** Reader has FAISS store loaded into memory (verified by E6 — `faiss-node` is in-memory after `.load()`, no mmap, no SIGBUS). The `--refresh` race window is the existing RFC 012 §7 N4 mitigation (JSON-parse-retry).
- **`active.txt` references a removed model.** `resolveActiveModel` step-2/step-3 validates "exists with no `.adding`"; missing → error 2 with "active model not on disk; run `kb models set-active <other>`."
- **Two MCP servers race to start, both want migration.** Instance advisory acquires first (round-1 failure F4 + delivery F6); second hits `EEXIST`, sees the first PID is alive, exits with `InstanceAlreadyRunningError`. First runs migration unmolested.
- **`kb` CLI runs concurrent with MCP migration.** CLI uses `${FAISS_INDEX_PATH}/.kb-migration.lock` (proper-lockfile, brief retry budget). Yields to in-flight migration; succeeds against the migrated layout. CI smoke step asserts.
- **`--model=<id>` argv with embedded `:` or `/`** (round-1 failure F12 — path-traversal risk). Hard-validate against `^[a-z]+__[A-Za-z0-9._-]+$` before joining into a path. Reject `..`, NUL, `/`, `\`. Suggest the normalized form on argv typo: `Did you mean --model=ollama__nomic-embed-text-latest?`
- **MCP `model_name` arg containing path-traversal characters** — same regex validation. `isError: true` with "invalid model_id format" message.
- **Empty `KNOWLEDGE_BASES_ROOT_DIR` during `kb models add`.** Cost estimate is `0 chunks, $0`; CLI prints "no ingestable files" and exits 0 without creating `models/<id>/` or `.adding`.
- **`kb search --refresh` while RFC 007 manifest gap** (round-1 failure F11 — duplicate vectors after a kill-and-rerun mid-write). Per-model isolation narrows the blast radius (only that model's vectors duplicate). Documented in M4 + threat-model.

### 4.12 Threat-model delta

`docs/architecture/threat-model.md` §1 ("`$FAISS_INDEX_PATH` is a code-execution boundary") and §4 ("Concurrency — single process per `$FAISS_INDEX_PATH`") need updates:

- §1: requirement extends to every `models/<id>/` subdirectory. Pickle-deserialization risk per-model.
- §4: single MCP server per `$FAISS_INDEX_PATH` constraint is unchanged. Per-model write locks add intra-process serialization but don't change the cross-process advisory.
- New §6 entry: `active.txt` is operator-trusted state; tampering with it can redirect agent retrievals to a wrong model. Mode 0o600 like the PID file.
- M5 addition: `benchmarks/.cache/` (per §4.13.4) holds the bundled fixture downloaded from public APIs. Treated like any other build artefact — operator-owned; outside the trust boundary. Not under `${FAISS_INDEX_PATH}`. Skill orchestrator uses `$TMPDIR/kb-bench-<hash>/` for `--fixture=external` runs (per §4.13.9), keeping the user's real `${FAISS_INDEX_PATH}` untouched.

Threat-model update is M4. No new threats; same threats with a slightly larger surface.

### 4.13 Embedding-comparison benchmarking skill (M5)

**Operator-requested addition (2026-04-26)** — M5 dogfoods M0-M4 by giving an operator (or paired agent) a one-command workflow to compare two embedding models on the same KB and read an HTML report. Selection inputs that today require ad-hoc shell work — *which model is faster on my hardware, which is cheaper at my scale, do they actually return different documents on my queries* — become artefacts a reviewer can open in a browser.

#### 4.13.1 Why extend the existing harness, not invent a new one

`benchmarks/{run.ts, scenarios/, fixtures/}` already exists (RFC 007 PR 0.1 baseline). Its `BenchmarkReport` (`benchmarks/types.ts:55-66`) already carries `cold_start.{ms, rss_bytes}`, `cold_index.{files, chunks, ms}`, `warm_query.{p50_ms, p95_ms, p99_ms}`, `memory_peak.{rss_bytes, heap_used_bytes}`, and `retrieval_quality.{recall_at_10, sweep[]}`. CI runs `BENCH_PROVIDER=stub npm run bench` (`.github/workflows/benchmarks.yml`) and uploads the JSON. **What's missing for §G12**:

1. The `BenchProvider` axis (`'stub' | 'ollama' | 'openai' | 'huggingface'`) does not distinguish two models from the same provider (e.g. two HF models). M5 adds `BENCH_MODEL_NAME` env so the same `BENCH_PROVIDER=huggingface` run can be parameterised.
2. No batch/concurrency scenario — only serial `warm-query`. M5 adds `batch-query.ts`.
3. No on-disk-storage scenario (vector binary + docstore). M5 adds `index-storage.ts` (~30 LoC; reads `models/<id>/faiss.index/{faiss.index,docstore.json}` after cold-index).
4. JSON output only — no comparative renderer. M5 adds `benchmarks/compare/render.ts` + `report-template.html`.
5. No two-run orchestrator. M5 adds `benchmarks/compare/run.ts` that invokes the harness twice (one model per run, real provider — stub is meaningless for comparative selection) and merges the JSON pair into one HTML report.

The existing `benchmarks/results/run-{provider}-node{N}-{os}-{arch}.json` naming convention extends naturally: M5 writes `compare-{model_a_id}-vs-{model_b_id}-node{N}-{os}-{arch}.{json,html}`. Existing CI stub job is unchanged; M5's compare job is `workflow_dispatch`-only (real-provider runs are maintainer-local, never on CI — same posture as today's real-provider local runs).

#### 4.13.2 Surface

```
npm run bench:compare -- \
  --models=<id_a>,<id_b> \           # required; resolved via deriveModelId
  --fixture=<size> \                 # small (CI fixture, ~150 chunks) | medium (~800) | large (~3000); default: medium
  --queries=<path>                   # optional; one query per line; default: bundled benchmarks/compare/queries-default.txt (50 queries)
  --concurrency=<list>               # CSV; default: 1,4,16
  --golden=<path>                    # optional; JSON {query: [doc_paths]}; enables recall@k + MRR
  --output-dir=<path>                # default: benchmarks/results/
  --skip-add                         # reuse already-registered models (assume `kb models add` ran earlier)
  --yes                              # non-interactive (skips paid-provider cost prompt)
```

Operator output: a single `compare-…-{datetime}.html` plus the two source `.json` runs. The HTML is fully self-contained (inline CSS, inline `<svg>` charts via `benchmarks/compare/chart.ts` — no external CDN, no JS frameworks; reviewer-air-gapped friendly).

#### 4.13.3 Phases (each emitted to JSON; rendered side-by-side in HTML)

| Phase | Existing scenario | M5 addition | Output keys |
|---|---|---|---|
| Cold start (process + first index) | `cold-start.ts` + `cold-index.ts` | none — extend `BENCH_MODEL_NAME` only | `cold_start.{ms, rss_bytes, fixture_documents}`, `cold_index.{ms, chunks, files}` |
| Warm single-query | `warm-query.ts` | none | `warm_query.{p50_ms, p95_ms, p99_ms, repetitions}` |
| Warm batch-query (NEW) | — | `batch-query.ts`, ~80 LoC. For each `--concurrency=N`, runs `Promise.all(query × N)` `repetitions` times; reports throughput + tail. | `batch_query.runs[].{concurrency, qps_p50, qps_p95, latency_p50_ms, latency_p99_ms}` |
| On-disk storage (NEW) | — | `index-storage.ts`, ~50 LoC. After cold-index, reads `${PATH}/models/<id>/faiss.index/{faiss.index,docstore.json}` byte size; computes bytes/vector. | `index_storage.{vector_binary_bytes, docstore_bytes, total_bytes, bytes_per_vector}` |
| Retrieval quality | `retrieval-quality.ts` | none — already has fanout sweep + recall@10 | `retrieval_quality.{default_recall_at_10, sweep[]}` |
| Cross-model agreement (NEW, comparison-only) | — | Computed in `compare/run.ts`, not the per-model harness. For each query: top-10 from A, top-10 from B; Jaccard on doc-paths; Spearman ρ on overlap. Aggregated p50/p95. | (in `compare-….json`) `cross_model.{jaccard_p50, jaccard_p95, spearman_p50, overlap_doc_count}` |
| Cost (paid providers) | — | `compare/run.ts` reads tokens consumed (Ollama: stub `0`; OpenAI: from response usage if available, else fall back to chunks × 4-byte rule); multiplies by `src/cost-estimates.ts` constants. | (in `compare-….json`) `cost_estimate.{usd, source: 'api-usage' \| 'rule-of-thumb', last_verified: 'YYYY-MM-DD'}` |

**Cold start vs hot start clarification (operator's terminology):**
- *Cold start* = first run after `kb models remove <id>` (or fresh-install): full re-embed via `kb models add`. Measured by `cold-index.ts` (per-chunk wall time) + `cold-start.ts` (process boot + initial load).
- *Hot start* = subsequent search against a registered model with the index already loaded into memory. Measured by `warm-query.ts` (single) + new `batch-query.ts` (batch).

#### 4.13.4 Fixture corpus

The user asked for "a fixture database large enough to make the report insightful." Concretely:

- **Size target.** ~3000 chunks at the `--fixture=large` profile. Empirical-spike (M5 PR): on the operator's nomic-embed-text baseline (E1 reference), 1294 chunks already produces measurable p99 separation; 3000 chunks provides ~2× signal margin without pushing maintainer-local cold-start past ~5 min on Ollama (50 ms/chunk × 3000 = 150 s + I/O).
- **Source — arxiv abstracts (decision locked 2026-04-26 per operator delegation).** ~3000 abstracts from `cs.IR` + `cs.CL` 2020-2024, CC-BY licensed, ~6 MB markdown after extraction. Technical English aligns with the typical KB-MCP corpus shape (code/docs/research notes), embedding-discrimination signal is sharper than general-domain, and RFC 011's arxiv ingestion scaffolding doubles the dogfooding (M5 exercises both M2 multi-model and RFC 011 ingest). Wikipedia (`wiki40b/en` 3000-doc sample) and the repo's own `docs/`+RFCs were considered and rejected: Wikipedia is heavier (~30 MB) and topically diffuse enough to mask model differences; the repo's own docs are too small to be insightful (~15k lines) and self-referential.
- **Vendoring strategy.** Do **not** commit the corpus binary. Ship `benchmarks/fixtures/generator.ts` (already exists for the small CI fixture) extended with a `--profile=large` flag that fetches arxiv abstracts via the public arxiv API (rate-limited, ~3 req/s with delay; ~2 min first run over network). Cached under `benchmarks/.cache/` with sha256-keyed filenames (gitignored). Deterministic arxiv ID list across runs and machines (committed at `benchmarks/fixtures/arxiv-corpus-v1.ids.txt`, ~3000 lines).
- **arxiv API risk mitigations** (locking arxiv = accepting these):
  1. **Aggressive sha256 cache** — one fetch ever per machine; subsequent runs are network-free.
  2. **Maintainer-uploaded fallback tarball** as a GitHub release artefact (`benchmarks-fixture-arxiv-v1.tar.gz`, ~6 MB, deterministic checksum). Operator with no network drops the tarball into `benchmarks/.cache/` and the generator skips the fetch. README documents this path.
  3. **CI posture unchanged** — `bench:compare` is `workflow_dispatch`-only (maintainer-local), never on every PR push; arxiv rate limits don't compound across CI events.
  4. **Generator emits a clear error on rate-limit** — "arxiv returned 429 after retry; drop the fallback tarball into benchmarks/.cache/ or wait 60 min and retry"; no silent partial corpus.
- **Golden labels (optional).** If `--golden=<path>` is supplied, recall@k + MRR appear in the report. The bundled `queries-default.txt` does **not** ship golden labels (they're operator-corpus-specific); the report still emits cross-model Jaccard/Spearman, which doesn't need labels.

#### 4.13.5 HTML report layout

```
┌────────────────────────────────────────────────────────────────────────┐
│ Embedding model comparison: ollama__nomic-embed-text-latest            │
│   vs huggingface__BAAI-bge-small-en-v1.5                               │
│ Generated 2026-XX-XX • node v22 • linux-x64 • fixture=large (3010 ch.) │
├────────────────────────────────────────────────────────────────────────┤
│ SUMMARY TABLE                                                          │
│   metric              │  model A    │  model B    │  winner            │
│   cold_index_ms       │  152340     │  84210      │  B (1.81× faster)  │
│   warm_query_p50_ms   │   12.4      │   18.7      │  A                 │
│   warm_query_p99_ms   │   23.1      │   31.0      │  A                 │
│   batch_qps@16        │  124.8      │   88.3      │  A                 │
│   total_storage_MiB   │   5.62      │   3.74      │  B                 │
│   estimated_cost_usd  │   0.00      │   0.00      │  tie (both free)   │
│   default_recall@10   │   0.84      │   0.79      │  A                 │
│   jaccard_top10_p50   │   0.61      │   0.61      │  N/A               │
├────────────────────────────────────────────────────────────────────────┤
│ LATENCY DISTRIBUTION (single + batch, two SVG histograms side-by-side) │
├────────────────────────────────────────────────────────────────────────┤
│ THROUGHPUT vs CONCURRENCY (SVG line chart, 1/4/16/64)                  │
├────────────────────────────────────────────────────────────────────────┤
│ STORAGE (stacked bar — vector binary vs docstore — per model)          │
├────────────────────────────────────────────────────────────────────────┤
│ QUERY-LEVEL DETAIL (collapsible <details>, top-5 per model side-by-    │
│   side; overlap rows highlighted; per-query Jaccard score)             │
├────────────────────────────────────────────────────────────────────────┤
│ RECOMMENDATION (rule-based picker, see §4.13.6)                        │
├────────────────────────────────────────────────────────────────────────┤
│ DISCLAIMERS                                                            │
│ • This is your-KB selection guidance, NOT an MTEB leaderboard (N10).   │
│ • Latency depends on hardware; rerun on the deployment target.         │
│ • Recall@10 requires golden labels; absent them, only Jaccard shown.   │
│ • Cost numbers reflect cost-estimates.ts LAST_VERIFIED date; verify.   │
└────────────────────────────────────────────────────────────────────────┘
```

Charts are inline SVG generated by `benchmarks/compare/chart.ts` (~120 LoC, zero deps — d3-shaped axis math, no library import). Self-contained because the report is meant to be reviewed (and possibly attached to a PR or shared) without the original machine.

#### 4.13.6 Recommendation panel — rule-based, transparent

The panel picks a winner per axis using **fixed thresholds** documented in the panel itself (so a skeptical reader can disagree explicitly):

```
If you optimise for…          Pick    Reason
──────────────────────────────────────────────────────────────────────
single-query latency           A     A's p99 is 25%+ lower than B's
batch throughput (≥16 conc)    A     A's qps@16 is 40%+ higher
cost per re-embed              B     B's cost is 30%+ lower (A is free → tie)
storage at 10× growth          B     B's bytes/vector is 33% lower
recall@10 (if labelled)        A     A's recall is 5%+ higher
result diversity (no winner)   —     Jaccard 0.61 ⇒ ~40% non-overlap; consider RRF (N1)
```

If multiple axes disagree, no single-line recommendation; the panel emits "no clear winner — operator picks based on which axis matters." **No machine-learned scorer**; the picker is `if-else` so the report can be read decades from now.

#### 4.13.7 New / changed files (M5)

| File | Change | LoC |
|---|---|---|
| `benchmarks/compare/run.ts` | NEW. Orchestrator. Spawns the existing harness twice via `child_process.spawn('npm', ['run', 'bench'], { env: {...} })` (one per model), merges JSONs, computes cross-model agreement + cost, invokes renderer. | ~250 |
| `benchmarks/compare/render.ts` | NEW. Reads merged JSON, hydrates `report-template.html` via tagged-template substitution (no Handlebars / no React). | ~150 |
| `benchmarks/compare/chart.ts` | NEW. Inline-SVG histogram + line chart + stacked-bar. Zero deps. | ~120 |
| `benchmarks/compare/report-template.html` | NEW. Static HTML skeleton with `{{slot}}` markers. ~200 lines including inline CSS. | ~200 |
| `benchmarks/compare/queries-default.txt` | NEW. 50 queries against the bundled fixture; mix of factual / paraphrase / multi-hop. | (data) |
| `benchmarks/scenarios/batch-query.ts` | NEW. Concurrency-sweep scenario. Reuses `ScenarioContext` + `StubController`. | ~80 |
| `benchmarks/scenarios/index-storage.ts` | NEW. Reads on-disk byte sizes after cold-index. | ~50 |
| `benchmarks/types.ts` | Adds `BatchQueryScenarioResult`, `IndexStorageScenarioResult`; extends `BenchmarkReport.scenarios`. | +30 |
| `benchmarks/run.ts` | Reads `BENCH_MODEL_NAME` env; passes through to provider construction; new scenarios called. | +40 |
| `benchmarks/fixtures/generator.ts` | Adds `--profile=large` (~3000 chunks, arxiv-CC-BY abstract corpus, sha256-cached under `benchmarks/.cache/`). Existing small CI fixture unchanged. | +120 |
| `benchmarks/.cache/.gitignore` | NEW. Single line `*` to exclude the cached corpus. | 1 |
| `benchmarks/README.md` | Section: "Comparing two models" — invocation, output paths, fixture-cache behaviour, offline fallback. | +60 |
| `package.json` | Add `"bench:compare": "tsx benchmarks/compare/run.ts"` script. | +1 |
| `.github/workflows/benchmarks.yml` | NO CHANGE (CI stays stub-only). New `bench-compare-dispatch.yml` (workflow_dispatch only) for maintainer manual runs against real providers; uploads HTML as artifact. | (new file ~40 LoC) |
| `.claude/skills/compare-embedding-models/SKILL.md` | NEW. Per RFC 002 §6.2 frontmatter + body. Body inlined verbatim in §4.13.8 below for reviewer convenience. **Lands only after RFC 002 is approved and `.claude/skills/` directory is established** (round-2.5 boundary note — see §11 v4 amendment). | (see §4.13.8) |

**Ordering constraint.** §4.13's skill file (`.claude/skills/compare-embedding-models/SKILL.md`) cannot land until RFC 002 (the `.claude/skills/` convention itself) has merged its scaffolding PR. Until then, M5 ships everything **except** the skill file; the skill body lives in §4.13.8 as a reviewable artefact and is copied verbatim into `.claude/skills/` by the M5 implementation PR (or a follow-up if RFC 002 hasn't landed by then). The orchestrator + harness extensions are independently usable via `npm run bench:compare` even without the skill.

#### 4.13.8 Inlined SKILL.md body (target file: `.claude/skills/compare-embedding-models/SKILL.md`)

Frontmatter and body match RFC 002 §6.2 schema exactly. Anchors target M5 files (which exist post-M5-implementation); placeholder anchors marked `(M5)` are bumped to actual line locations in the M5 implementation PR.

```markdown
---
name: compare-embedding-models
description: Run an apples-to-apples benchmark of two embedding models on a fixture or your KB and produce an HTML report covering cold-start indexing, warm-query latency, batch throughput, storage, and quality.
keywords: [embeddings, benchmark, comparison, latency, throughput, models, html-report, selection]
anchors:
  - benchmarks/compare/run.ts::main                        # M5
  - benchmarks/compare/render.ts::renderReport             # M5
  - benchmarks/scenarios/batch-query.ts::runBatchQueryScenario  # M5
  - benchmarks/scenarios/index-storage.ts::runIndexStorageScenario  # M5
  - benchmarks/fixtures/generator.ts::generateLargeProfile # M5
  - src/cli-models.ts::runAdd                              # RFC 013 M2
  - src/cli-compare.ts::runCompare                         # RFC 013 M2
  - src/cost-estimates.ts::COSTS                           # RFC 013 M2
applies_to:
  - claude-code
  - claude-desktop
  - codex-cli
  - cursor
  - continue
  - cline
last_verified: 2026-04-25  # bumped at M5 PR merge
---

## When to use

- The user is choosing between two embedding models for a new knowledge base and wants concrete numbers (latency, cost, storage, quality) on **their hardware**, not a generic leaderboard.
- The user has switched models in the past and wants to verify the trade-off was worth it.
- The user is documenting a model choice for a team and needs an HTML artefact to attach to a decision record / RFC / PR.

## Prerequisites

- knowledge-base-mcp-server `0.3.x` installed (M0-M4 shipped; this skill needs `kb models {add, list}` from §4.4 of RFC 013).
- Both models reachable: Ollama running locally (`OLLAMA_BASE_URL`) for ollama models; `HUGGINGFACE_API_KEY` set for HF models; `OPENAI_API_KEY` set for OpenAI models. The skill reads provider tokens from env per `src/config.ts`.
- Disk space: ~50 MiB for the bundled large fixture (cached under `benchmarks/.cache/`) + ~10 MiB per model index (per §2.4 measurements).
- For paid providers: estimated cost surfaced in the orchestrator preamble; non-zero requires `--yes` or interactive confirmation (`src/cli-models.ts:runAdd` flow, §4.4).

## Steps

1. **Identify model ids.** `kb models list` shows registered models with their `<provider>__<slug>` ids. If a target model is not yet registered, run `kb models add <provider> <model_name>` first (the skill's orchestrator can auto-register with `--yes`, but registering explicitly lets the user audit cost upfront).
2. **Pick a fixture profile.**
   - `--fixture=small` (~150 chunks) — sanity check, ~10 s; identical to CI baseline corpus.
   - `--fixture=medium` (~800 chunks) — default; ~1 min on Ollama, ~30 s on HF/OpenAI.
   - `--fixture=large` (~3000 chunks) — selection-grade; ~3-5 min cold-index per model.
   - To benchmark on your **own** KB instead of a fixture, set `KNOWLEDGE_BASES_ROOT_DIR` to your KB and pass `--fixture=external` (the orchestrator reads from your real corpus; no copy is made).
3. **Run the comparison:**
   ```bash
   npm run bench:compare -- \
     --models=ollama__nomic-embed-text-latest,huggingface__BAAI-bge-small-en-v1.5 \
     --fixture=large \
     --concurrency=1,4,16
   ```
   First run with `--fixture=large` fetches the arxiv corpus (~2 min, network); subsequent runs read from `benchmarks/.cache/`.
4. **Read the report.** Output path is printed at the end:
   ```
   Report: benchmarks/results/compare-ollama__nomic-…-vs-huggingface__BAAI-…-2026XXXX-HHMMSS.html
   Open it: xdg-open <path>   # Linux
            open <path>       # macOS
   ```
   The report is fully self-contained (inline CSS + SVG, no external assets). Attach it to a PR / Slack / decision record as-is.
5. **Compare the recommendation panel against your priorities.** The panel picks a winner per axis (latency, throughput, cost, storage, recall). If your priorities are mixed, the panel says so explicitly — pick the model that wins your highest-weighted axis.
6. **Optional: golden labels.** If you have a labelled query set (`{query: [doc_paths]}` JSON), pass `--golden=<path>` to enable recall@k + MRR in the report.

## Verification

After the run, the report file exists, opens in a browser, and the summary table has a non-empty row for both models:

```bash
test -s benchmarks/results/compare-*.html && \
  grep -q 'cold_index_ms' benchmarks/results/compare-*.html && \
  echo OK
# expected: OK
```

For paranoid verification, the merged JSON next to the HTML has `scenarios.cold_index.chunks > 0` for both models.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `Model <id> not registered` | Either model not yet added | Run `kb models add <provider> <model>` first; rerun with `--skip-add`. Or pass `--yes` to auto-register inline (paid providers will spend money — read the cost preamble first). |
| `OLLAMA_BASE_URL unreachable` | Ollama daemon not running | `ollama serve` in another terminal; verify with `curl $OLLAMA_BASE_URL/api/tags`. See `setup-ollama` skill. |
| `HUGGINGFACE 429 — rate limited` (HF free tier) | Too many concurrent calls | Lower `--concurrency=1`; rerun. HF inference free tier throttles silently and surfaces as 429. |
| `OPENAI 401` | API key missing or expired | Check `OPENAI_API_KEY`. See `setup-openai` skill. |
| Cold index never finishes (large fixture, slow CPU) | `--fixture=large` exceeds maintainer time budget | Drop to `--fixture=medium`; ~3× faster. |
| Report opens but charts are blank | Browser blocks inline SVG (rare — corporate browsers) | Pass `--no-charts` for a tables-only report. |
| Cross-model Jaccard is `0.0` everywhere | Models return disjoint top-k (genuinely different embeddings) — or one model returned zero results | Check both models' `default_recall_at_10` in the summary; if one is `0`, that model failed retrieval (likely an empty index). Re-run `kb models add --refresh` for the empty model. |

## See also

- `setup-ollama` (sibling skill — install Ollama for the local model leg).
- `setup-huggingface` (sibling — HF token + endpoint).
- `setup-openai` (sibling — OpenAI key + cost-aware add).
- `troubleshoot-mcp-unreachable` (sibling — if `kb models list` itself fails).
- `add-knowledge-base` (sibling — set up your own KB to benchmark against).
- RFC 013 §4.13 (this RFC) — full design rationale and orchestrator architecture.
- RFC 011 — arxiv ingestion that supplies the bundled large fixture.
```

#### 4.13.9 Concurrency / safety in the orchestrator

- **Per-model lock isolation (§4.6) is the load-bearing invariant.** The orchestrator runs cold-index for model A, then for model B, **never concurrently** — back-to-back avoids two large `kb models add` writers competing for CPU/network and confounding latency measurement. Warm-query and batch-query phases also run serially per model (one model at a time; concurrency parameter is *within* a model's batch, not *across* models).
- **`--skip-add` reuses pre-registered models.** Cost-conscious operators run `kb models add` once, then iterate `bench:compare --skip-add` to tweak the report without re-spending tokens. The orchestrator validates both models exist via `isRegisteredModel` (§4.9) and refuses if one has `.adding` sentinel.
- **`KNOWLEDGE_BASES_ROOT_DIR=external` mode does not write to the user's KB.** The orchestrator hashes the KB path + the two model ids to derive a temp `FAISS_INDEX_PATH=$TMPDIR/kb-bench-<hash>/`; both models register there; the user's real `${FAISS_INDEX_PATH}` is not touched. Cleanup hook removes the temp dir on success (preserves on failure for debugging).
- **No MCP server interaction.** The orchestrator runs the CLI surface (`kb models add`, `kb search`) and the existing benchmark harness directly; it does not start `KnowledgeBaseServer`. This avoids the single-instance advisory contention with a user's running MCP.
- **TTY / cost-prompt discipline matches §4.4.** Non-TTY without `--yes` errors fast for paid-provider models (round-1 failure F9 invariant unchanged).

#### 4.13.10 Limits and what M5 deliberately does not include

- **No statistical significance test.** The report shows raw p50/p95/p99 with run counts; the reader interprets. Adding a t-test / Mann-Whitney would require a full repetition design and is out of scope; the recommendation thresholds (25% / 30% / 40%) intentionally exceed normal jitter so single-run reports are usable.
- **No multi-machine reporting.** The HTML is one machine, one moment. Comparing across hardware = run the orchestrator on each machine and diff the HTML manually.
- **No 3+ model comparison.** Two-model is the canonical operator workflow ("am I switching from X to Y"); 3+ model is a `for` loop on top of `bench:compare` and a future enhancement.
- **No live MCP tool to trigger this.** A `bench_compare` MCP tool was considered and rejected — embedding-model selection is a deliberate operator decision, not an in-session agent action; the cost of accidentally embedding 3000 chunks via OpenAI from an MCP call is too high.
- **No CI integration for the comparison run.** CI runs the existing stub harness only; the comparison orchestrator is `workflow_dispatch` (maintainer-triggered, real providers). Same reason as today's split.

## 5. Cost & risk analysis

### 5.1 Per-PR scope

- **M1+M2 (combined, 0.3.0 minor).** ~1300 LoC across 8 new modules + edits to FaissIndexManager + cli + KnowledgeBaseServer + tests. Existing tests still pass (with the same env vars producing the same `<model_id>` deterministically). New tests cover migration (6 seed layouts), `active.txt` robustness, `cli-models` + `cli-compare`, lock split, partial-add sentinel.
- **M3 (0.3.x minor).** ~150 LoC for `list_models` MCP tool + `model_name` arg on `retrieve_knowledge`. MCP wire output adds an envelope `model_id` field when `model_name` is passed (no per-chunk change — round-1 minimalist F5).
- **M4 (0.3.x patch).** Docs only.

### 5.2 What stays unchanged

- `EMBEDDING_PROVIDER`, `OLLAMA_MODEL`, `HUGGINGFACE_MODEL_NAME`, `OPENAI_MODEL_NAME`, `OLLAMA_BASE_URL`, `HUGGINGFACE_API_KEY`, `OPENAI_API_KEY` keep their meaning.
- `FAISS_INDEX_PATH`, `KNOWLEDGE_BASES_ROOT_DIR`, `INGEST_*`, `REINDEX_TRIGGER_*` untouched.
- MCP `retrieve_knowledge` byte-for-byte unchanged for callers not passing `model_name`.
- Single-instance MCP advisory still root-level. Two MCP servers against the same `$FAISS_INDEX_PATH` still refused.

### 5.3 What technically changes (CHANGELOG-noted)

**The CHANGELOG MUST use the wording "Behavior change (technically breaking)"** matching RFC 012 §5.4 precedent (round-1 delivery F2). Specifically:

- **On-disk layout migrated to per-model subtree (technically breaking).** First 0.3.0 start auto-migrates. Tooling outside this repo that reads `${PATH}/faiss.index/` directly must update for `models/<id>/`.
- **`MODEL_NAME_FILE` no longer at root (technically breaking).** Per-instance per-model. External tooling reading `${PATH}/model_name.txt` directly must update.
- **`withWriteLock` signature changed (internal).** Now takes `(resource, fn)`. Only callers in this repo. Tests updated.
- **`src/lock.ts` deleted.** Split into `instance-lock.ts` + `write-lock.ts`. Internal API.
- **MCP `retrieve_knowledge` results gain envelope-level `model_id` when `model_name` is passed** (additive — no breakage).
- **Single-MCP-instance enforcement is unchanged from 0.2.x.**

### 5.4 Risk: migration corruption

Mitigations from §4.8 + the empirical-checkpoint `~12 ms` measurement (E2):

- **Crash mid-rename** → next start sees `models/<id>/`, takes early-return; cleanup pass removes stragglers.
- **Concurrent migrations** → instance advisory blocks two MCP servers; CLI uses `${PATH}/.kb-migration.lock` (round-1 failure F4 + delivery F6).
- **Pre-RFC-012 indexes (no `model_name.txt`)** → migration refuses, fails fast with explicit recovery instructions (round-1 failure F5).
- **Disk full / EROFS** → `fsp.rename` throws; migration propagates; old layout intact.

### 5.5 Risk: cost-estimate inaccuracy

Quoted-rule constants are rough (CJK 2-3× more expensive than `bytes/4` suggests). Mitigations: stderr says "estimate" + provider URL; operator can `--dry-run`; for paid providers, the operator's API console is post-hoc truth.

## 6. Migration / rollout

### 6.1 Phasing

- **M0 (0.2.2 patch — precursor PR).** Lock-module split (`src/lock.ts` → `instance-lock.ts` + `write-lock.ts`); `withWriteLock(fn)` → `withWriteLock(resource, fn)` with resource = `FAISS_INDEX_PATH` (multi-model lands in M1). Mechanical, ~150 LoC. RFC 012 round-3-deferred. **Lands a week ahead of M1+M2** (round-2 delivery F1) so the bigger PR doesn't bundle the lock-module risk.
- **M1+M2 (0.3.0 minor — combined PR).** Layout, migration, `bootstrapLayout` split, `active-model.ts`, `kb models *`, `kb search --model=<id>`, `kb compare`. ~1100 LoC across 3 internal commits. CHANGELOG: "Changed (technically breaking): on-disk layout migrated."
- **M3 (0.3.x minor).** MCP `list_models` + `model_name` arg.
- **M4 (0.3.x patch).** Docs.
- **M5 (0.3.x patch — benchmarking skill).** Operator-requested addition (2026-04-25). Extends `benchmarks/` with batch-query + index-storage scenarios, a multi-model orchestrator (`benchmarks/compare/run.ts`) that runs the harness twice and renders an HTML side-by-side report, and the bundled `--fixture=large` arxiv-abstract corpus (cached, not committed). Per RFC 002, the `.claude/skills/compare-embedding-models/SKILL.md` file lands in the same PR if RFC 002's `.claude/skills/` scaffolding has merged by then; otherwise the skill body (§4.13.8) waits and the orchestrator + harness ship standalone via `npm run bench:compare`. ~600 LoC + ~200-line HTML template + bundled `queries-default.txt`. Lands after M3. Independent of M0-M4 internals — only depends on the user-facing CLI surface (`kb models add`, `kb search --model=<id>`, `kb compare`, `kb models list`).

Round-1 minimalist F9 + delivery F5: M1 alone is migration cost with no operator-visible benefit; combined with M2 the 0.3.0 release ships a usable feature, not just a layout shuffle.

### 6.2 Pre-publish gate (extends RFC 012 §6.2 — split into fast vs full)

**Critical precondition (round-1 delivery F11):** `prepublish-smoke.yml` must be **wired into CI** before 0.3.0 ships. The 0.2.1 CHANGELOG documents that RFC 012 §6.2 was specified but not wired before 0.2.0; the symlink-path bug shipped to users as a result. **0.3.0 cannot repeat that.** Confirm wiring in the M1+M2 PR.

**Job split (round-1 delivery F12 + round-2 delivery F2 — budget realism + flake exit lane):**

- **`smoke-fast.yml`** runs on every PR push. ~2 min budget. Covers:
  - Install, `--version`, single-model search, model-mismatch check.
- **`prepublish-full.yml`** runs only on `v*.*.*` tag push. **~15 min budget, target 10** (round-2 delivery F2 — each spawned-Node step pays ~390 ms ESM resolution per RFC 012 §4.6; ten steps × multiple sub-cases × ~1 s startup easily blows the 10-min target on a cold runner). Hard gate for `npm publish`. **Empirical-spike measurement** required in the M1+M2 PR: run the full job once on a fresh `ubuntu-latest` runner, record actual wall time, lock the budget. **Flake-exit lane (round-2 delivery F6):** if a step proves flaky in production, the maintainer may set `KB_PREPUBLISH_KNOWN_FLAKY=stepN` in the workflow YAML to mark it informational (logs but doesn't block). Each use requires a follow-up issue tagged `flaky-prepublish-step` and must resolve within one minor release. Covers:
  1. **Migration matrix (6 sub-cases — round-1 delivery F9):**
     - Canonical 0.2.x layout → migrates correctly, `active.txt` written, cleanup passes.
     - Empty `model_name.txt` (truncate window) → falls back, doesn't create empty-slug model_id.
     - Missing `model_name.txt` (pre-RFC-012) → migration refused with explicit error.
     - Single-file pre-#57 `faiss.index` → fail with clear error pointing at #57 fix.
     - Empty `${FAISS_INDEX_PATH}/` → no migration, no crash, fresh-install path.
     - Partial-migrated state (`models/<id>/faiss.index/` exists, `model_name.txt` still at root) → idempotent, cleans up.
  2. **Concurrent migration startup:** spawn two MCP servers simultaneously against a 0.2.x layout; assert exactly one migrates and the other fails-fast.
  3. **Per-model lock isolation:** seed two model directories; spawn `kb search --model=A --refresh` (long mock); concurrently spawn `kb search --model=B`; assert B succeeds without waiting.
  4. **Partial-add interrupt (round-1 delivery F3):** spawn `kb models add ollama nomic-embed-text` against a seeded KB; after stderr emits "Embedding chunk 1/N", send SIGINT; assert process exits non-zero, lock file is gone, `.adding` sentinel persists, `kb models list` does NOT list the partial model. Run `kb models remove <id>`; assert it succeeds.
  5. **Non-TTY `kb models add` no-yes** (round-1 failure F9): `kb models add ollama nomic </dev/null` returns exit 2 within 1 s, no prompt block.
  6. **Cost-estimate-then-cancel:** pipe `n\n` to stdin; assert exit 0, no `models/<id>/`, no HTTP traffic.
  7. **`active.txt` race:** seed two models; spawn `kb models set-active B` concurrent with `kb search`; assert no partial read.
  8. **`KB_ACTIVE_MODEL` env precedence:** seed active.txt = A, set env to B, run `kb search`; assert B is queried.
  9. **`updateIndex` does NOT write `active.txt`** (round-1 failure F7): start MCP, run `set-active B`, fire trigger watcher, assert `active.txt` still says B post-fire.
  10. **`kb models remove --while-mcp-running`:** start MCP loaded against model A, run `remove B`, assert success and MCP keeps serving A. (Empirical-validated by E6 — `faiss-node` is in-memory.)

### 6.3 Cost-constants drift policy

`src/cost-estimates.ts` documents `LAST_VERIFIED: YYYY-MM-DD` and provider pricing URLs. **Quarterly manual review** by maintainer. **No CI auto-fetch** (round-1 delivery F4 — pricing pages JS-rendered).

### 6.4 Rollback

NPM versions are immutable. Per-bug rollback paths:

- **Migration corrupts my 0.2.x index.** Stop the MCP server. Manually un-migrate:
  ```
  mv ${FAISS_INDEX_PATH}/models/<id>/faiss.index ${FAISS_INDEX_PATH}/
  mv ${FAISS_INDEX_PATH}/models/<id>/model_name.txt ${FAISS_INDEX_PATH}/
  rm -rf ${FAISS_INDEX_PATH}/models ${FAISS_INDEX_PATH}/active.txt
  npm i -g @jeanibarz/knowledge-base-mcp-server@0.2.1
  ```
- **`kb models add` produced a corrupt directory.** `kb models remove <id>` deletes it (refuses if `.adding` sentinel — use `--force-incomplete`); re-run `add`.
- **`active.txt` got out of sync.** `kb models set-active <id>` rewrites it.
- **Per-model lock implementation has a race.** Patch publishes 0.3.1 with single-lock fallback. CHANGELOG calls out the regression.
- **Lock module split breaks an importer.** `src/lock.ts` is gone in M1; tooling that imported from it gets a clear `MODULE_NOT_FOUND` error pointing at the new modules. Patch ships a re-export shim if needed (`src/lock.ts` re-exports from `instance-lock.ts` + `write-lock.ts`).
- **`list_models` MCP tool returns wrong shape.** Patch publishes that no-ops the tool (returns empty array). CLI surface unaffected.
- **Worst case (M1+M2 startup breaks MCP).** Publish 0.3.1 reverting the combined PR. Users with `npx -y @latest`: after the publish, next session start re-resolves and gets 0.3.1; users with the unversioned cached spec must clear `~/.npm/_npx/`.

### 6.5 CHANGELOG sections (round-1 delivery F10 + round-2 delivery F4 — write-as-you-go discipline)

**Discipline rule (round-2 delivery F4):** the Migration and Rollback subsections must be drafted in the same commit that introduces the migration code (`maybeMigrateLayout`), not at PR finalization. The PR review checklist asserts both subsections are populated before merge — operator-facing prose written under the implementer's pressure (the day before publish) is sloppy; written-in-the-same-commit prose carries the lessons from M1 implementation discoveries.

Planned `[0.3.0]` CHANGELOG entry MUST include dedicated sections:

```markdown
## [0.3.0] — YYYY-MM-DD

### Migration

On first 0.3.0 start, `${FAISS_INDEX_PATH}/{faiss.index,model_name.txt}` is migrated to `${FAISS_INDEX_PATH}/models/<derived_id>/{faiss.index,model_name.txt}`. The migration is atomic and crash-safe (RFC 013 §4.8). **Before upgrading**, fully exit any AI client (Claude Code, Cursor, Continue) with the MCP server loaded. The migration acquires the single-instance PID advisory before doing any rename, so a stale 0.2.x MCP child cannot race the new 0.3.0 binary — but the 0.2.x child must exit before the new one starts.

### Rollback to 0.2.x

If 0.3.0 breaks for you, see [§6.4 of RFC 013](./docs/rfcs/013-multimodel-support.md#64-rollback). If you've added additional models post-migration (`kb models add`), rollback is **lossy** — pick the model directory you want as the 0.2.x baseline; the others are recoverable only by re-`add`ing on 0.3.0.

### Added
- `kb models {list, add, set-active, remove}` ...
- `kb compare <query> <model_a> <model_b>` ...
- ...

### Added in 0.3.x (M5)
- `npm run bench:compare -- --models=<id_a>,<id_b>` — runs the existing benchmark harness against two registered models back-to-back and emits a self-contained HTML report covering cold-start indexing, warm-query latency p50/p95/p99, batch throughput at multiple concurrencies, on-disk storage, and cross-model top-k agreement (Jaccard + Spearman). Bundled `--fixture=large` arxiv corpus fetched on first use (cached under `benchmarks/.cache/`, gitignored). Orchestrator + report are operator-runnable; the matching `.claude/skills/compare-embedding-models/SKILL.md` lands when the RFC 002 `.claude/skills/` scaffolding has merged. See RFC 013 §4.13.

### Changed (technically breaking)
- On-disk layout migrated to per-model subtree.
- `MODEL_NAME_FILE` no longer at the root (`${PATH}/model_name.txt` → `${PATH}/models/<id>/model_name.txt`).

### Internal (no surface change)
- `src/lock.ts` deleted; split into `src/instance-lock.ts` + `src/write-lock.ts`. `withWriteLock` signature now `(resource, fn)`.
```

### 6.6 Empirical-gate / regression downgrade table

| Regression | Detected by | Ships as |
|---|---|---|
| Migration loses vectors | §6.2 step 1 | Patch reverts the combined PR; users follow §6.4 manual un-migrate. |
| Per-model lock contention >5× longer than single-lock | §6.2 step 3 | Patch ships single-lock fallback (collapses to RFC 012 single-lock). |
| `kb models add` cost estimate off by >2× | §10 E4 (post-publish) | Patch flags estimates "(rough)" more loudly; revisits constants. |
| `list_models` MCP tool slow (>500 ms) on 10-model deployment | §10 E2 (post-publish) | M3 caches per-connection; invalidates on `set-active` events. |
| Removing the active model corrupts state | §6.2 step 7 | Hard-rejects `remove ACTIVE` even with `--yes` until set-active runs first. |
| Per-model FAISS save latency regressed >10% | bench harness | Investigate (path-length unlikely cause; E3 measured <0.1 ms). Patch only if real. |
| `.adding` sentinel logic broken — partial dir adopted as real model | §6.2 step 4 | Patch removes `kb models add` (CLI errors temporarily disabled); revert to single-model only. |
| Migration's instance-advisory ordering broken — concurrent migrations corrupt | §6.2 step 2 | Hot-fix patch; instance advisory acquired BEFORE any rename. |
| `updateIndex` writes `active.txt` (single-writer invariant violated) | §6.2 step 9 | Patch removes the offending write; restore Jest-asserted invariant. |
| Robust `active.txt` reader regex misclassifies a valid id as invalid (round-2 delivery F7) | `active-model.test.ts` snapshot tests | Patch loosens regex; verify against the round-2-failure-N3 hard-fail rule. |
| Lock-module split breaks an external importer (round-2 delivery F7) | post-publish issue report | 0.3.1 ships `src/lock.ts` re-export shim re-exporting from `instance-lock.ts` + `write-lock.ts` for one minor cycle; deprecation note in CHANGELOG. |

### 6.7 Post-publish canary (round-1 delivery F11 + round-2 delivery F3 — script not checklist)

The 0.2.1 CHANGELOG documents that RFC 012's prepublish-smoke gate was specified but not wired before 0.2.0 publish; the symlink-path bug shipped to users as a result. The same anti-pattern (manual checklist post-publish) must not repeat for 0.3.0.

Ship `bin/post-publish-smoke` (~80 LoC bash) **as part of the M1+M2 PR**. Mechanically runs:

1. `mktemp -d` → seed a 0.2.x layout from `tests/fixtures/0.2.x-canonical/` (the same fixture used by §6.2 step 1).
2. `npm i -g @jeanibarz/knowledge-base-mcp-server@$VERSION` (latest published).
3. Start MCP server, wait for "migration complete" log line, kill.
4. Assert `${tmp}/models/<expected_id>/faiss.index/` exists; `active.txt` contains expected id.
5. `kb search "test query"`; assert exit 0.
6. `kb models list`; assert one model marked active.
7. Exit 0 if all assertions pass; otherwise exit non-zero with the failed step.

Operator runs `./bin/post-publish-smoke 0.3.0` within 1 hour of publish (single command, no checklist). **Stretch goal:** invoke from `release.yml` post-publish job that pulls the just-published version from the public registry, closing the loop entirely. If the script exits non-zero: `npm deprecate @jeanibarz/knowledge-base-mcp-server@0.3.0 "use 0.2.1 — see #N"` immediately, ship 0.3.1 with the fix.

### 6.8 Pre-1.0 versioning

Per RFC 012 §5.4 convention, on-disk layout migration is a **minor** even though technically breaking. CHANGELOG must use the exact phrase "(technically breaking)" so a `grep "technically breaking" CHANGELOG.md` surfaces it.

### 6.9 Smithery deployments (round-1 delivery F8 + round-2 delivery F5 — disclosure in title, not footnote)

Smithery deployments cannot run `kb models add` (no CLI access on the hosted runner). Smithery operators register exactly one model via `smithery.yaml` env config; multi-model side-by-side is **not available** there.

**Disclosure discipline (round-2 delivery F5):** the 0.3.0 CHANGELOG headline reads "Multi-model embedding support (local install only — Smithery follow-up tracked in #N)" — disclosure in the title, not a footnote. The follow-up issue is opened **at PR time**, not "to be filed later" (per CLAUDE.md "Obvious-but-out-of-scope findings become GitHub issues"). The `smithery.yaml` for 0.3.0 exposes `kbActiveModel` plumbed to `KB_ACTIVE_MODEL` AND its config description explicitly says "Single-model mode. For multi-model side-by-side, install via `npm` locally."

## 7. Edge cases

- **Empty `KNOWLEDGE_BASES_ROOT_DIR`** during `kb models add`. Cost estimate `0`; CLI prints "no ingestable files" and exits 0 without writing anything.
- **Operator changes `EMBEDDING_PROVIDER` env after migration.** Migration ran with the env at that time. Step 3 fallback re-derives a new id and finds no matching directory; fail-fast with `kb models add <new>` hint. Documented.
- **Two operators on the same machine sharing `FAISS_INDEX_PATH`.** Single-instance advisory blocks two MCP servers; CLI calls each respect their own env. Both can co-exist as long as only one runs MCP. The `models/` subtree is shared.
- **Disk where `models/<id>/` would have a path-component longer than 240 chars.** `deriveModelId` throws `ModelIdTooLongError`. Documented in §4.3.
- **`active.txt` references a removed model.** Step-3 validation fails; "set-active <other>" hint; logged for grep-ability.
- **Provider rename / model deprecation.** Existing on-disk `openai__text-embedding-3-small` keeps working — no live API at search time. CLI emits a deprecation warning if the provider returns 410/404 on `--refresh` / `add`.
- **Symlink shenanigans inside `models/<id>/`.** Same threat-model posture as 0.2.x: `${FAISS_INDEX_PATH}` and everything under it must be operator-owned.
- **Filesystem case-sensitivity** (HFS+, APFS case-insensitive). HF model names with case variants would collide; documented; operator picks one. Linux/Windows-NTFS-default not affected.
- **Determinism caveat (round-1 failure F13).** `OLLAMA_MODEL=nomic-embed-text` vs `OLLAMA_MODEL=nomic-embed-text:latest` produce different ids but pull the same model from Ollama. Operators sharing `models/` across machines must pin env values exactly.
- **Orphaned model directories (round-2 failure N8).** Switching `OLLAMA_MODEL=foo` ↔ `foo:latest` accumulates `models/ollama__foo/` and `models/ollama__foo-latest/` (each ~5-10 MiB on operator's KB). No auto-cleanup; operator manages with `kb models remove <id>`. Documented as expected behavior, not a bug. A `kb models list --orphans` flag (heuristic detection of slug-prefix-overlap) is a future-RFC seed (§8.9).
- **CRLF / BOM in `active.txt`.** Robust reader handles both (round-1 failure F2, F3); if all parsing fails, log raw hex and fall through to step 4.
- **`kb search --refresh` while RFC 007 manifest gap is unfixed** (round-1 failure F11). Per-model isolation narrows the blast radius. Documented in §4.11.
- **`kb` invoked from a non-interactive shell with `kb models add` no-yes.** Exits 2 with "interactive without --yes" message (round-1 failure F9). No stdin block.
- **MCP / CLI version skew during upgrade window** (RFC 012 §7 — same hazard). Per RFC 012, on-disk format changes must be additive within a minor; major-bump (1.x → 2.x) for breaking. RFC 013's migration is one-way (0.2 → 0.3); `npm i -g @latest` flow + the `npx -y @latest` cache spec apply unchanged.

## 8. Alternatives considered

### 8.1 User-supplied alias instead of deterministic id

Rejected — drifts between machines; hides provider+model from MCP wire output; CI fixtures noisier. Deterministic ids are uglier but never wrong.

### 8.2 Per-model `FAISS_INDEX_PATH`

Operator runs N MCP servers with N paths. Rejected — defeats the within-one-session comparison goal; doubles process supervision.

### 8.3 No `active.txt` (Option C)

Round-1 minimalist F2 argued for `KB_ACTIVE_MODEL` env-only. Rejected — operators on shells without env-var alignment would hit RFC 012 mismatch errors on every invocation, and `mcp.json` is a static file rare to edit. The single-writer + atomic-write + robust-reader invariants make `active.txt` safe enough; cutting it adds env-divergence pain that the existing model-mismatch check exists precisely because of.

### 8.4 MCP `add_model` / `set_active_model` tools

Round-1 ambition F6 reframing: **deferred, not vetoed.** A future RFC may introduce them with MCP elicitation semantics so the agent surfaces the cost estimate and the operator confirms in-session. Tracked as **OQ8**.

### 8.5 SQLite-backed model registry

Rejected — adds a runtime dep (`better-sqlite3` native module), needs schema migration of its own, and the `active.txt` + `models/<id>/` layout is one short string + one directory per model.

### 8.6 Auto-eviction of old models on `add`

Rejected — operator-surprise on a comparison workflow.

### 8.7 First-class A/B harness (`kb models eval <model> <golden>`)

Round-1 ambition F5: out of scope here, but this is a natural follow-up. Documented as a future-RFC seed in §8.9.

### 8.9 Future-RFC seeds

Round-1 ambition F1, F3, F5, F7 + delivery F8 + minimalist F4 collectively suggest a coherent post-013 roadmap:

- **`kb models eval <model> --golden=queries.json`** — recall@k / MRR / nDCG against an operator-labelled hold-out set. Outputs to `models/<id>/.eval/<timestamp>.json`. The `list_models` schema reserves a `quality?: object` slot for it (round-1 ambition F3 + F5).
- **Per-KB model pinning** — `${KB_DIR}/.embedding-model` overrides active for queries scoped to that KB (round-1 ambition F2 was demoted to non-goal here, but the idea is well-defined).
- **Cumulative cost tracking** — `models/<id>/.cost.json` appended on every `add`/`refresh` for paid providers (round-1 ambition F4).
- **MCP elicitation-gated `add_model` / `set_active_model`** — once MCP elicitation is widely supported (round-1 ambition F6).
- **Hosted-multi-model for Smithery** — RFC needed (round-1 delivery F8).
- **Canonicalize-then-hardlink docstore dedup** — saves ~1.81 MiB × (M-1); needs a canonical-form pass over `docstore.json` to strip per-document UUIDs (round-1 ambition F7 + empirical E5).
- **Auto-detect new env-configured model + register prompt** — TTY-only (round-1 ambition F8).

These do NOT block 013. They form the M5+ roadmap.

## 9. Open questions

- **OQ1.** `kb models add` with HF model names containing `/` (e.g. `BAAI/bge-small-en-v1.5`) — accept on the CLI, or require quoting? Defer to M2 PR review.
- **OQ2.** `list_models` MCP tool surface storage size and last-refreshed timestamp? Probably yes; format (machine-readable in the JSON, human-readable in tool description) defer to M3 review.
- **OQ7.** What concrete fields does `list_models`'s reserved `quality?: object` slot contain when the future eval RFC lands? Defer.
- **OQ8.** Once MCP elicitation API is broadly supported across clients, ship `add_model` / `set_active_model` as elicitation-gated tools? Defer to a separate RFC.
- **OQ9 (M5) — RESOLVED 2026-04-26.** Operator delegated the call; chose **arxiv `cs.IR + cs.CL` 2020-2024 abstracts** (~3000 docs, ~6 MB, CC-BY). Rationale + risk mitigations live in §4.13.4. The fallback tarball is the escape hatch if the arxiv API path proves painful in CI dispatch or maintainer iteration; the generator hard-fails on rate-limit rather than producing a silent partial corpus.

## 10. Empirical work — measured between rounds 1 and 2

Round-1 design-experimenter ran 5 probes against the operator's actual KB at `/home/jean/knowledge_bases/`. Verdicts:

- **E1 (storage formula).** Verified for D ∈ {384, 768, 1024, 1536} at N=1294. Formula is `N × D × 4 + 45 B FAISS header`, exact (header is flat, model-independent). §2.4 table is correct byte-for-byte (the "computed" rows are not estimates).
- **E2 (migration latency).** Measured ~12 ms (WSL2 ext4) for the full `mkdir + 2 renames` sequence on the operator's actual `${FAISS_INDEX_PATH}`. v1's "<10 ms" was understated; corrected.
- **E3 (per-model lock latency).** Per-model lock-path nesting adds <0.1 ms p95 vs RFC 012's flat path baseline. No regression. Confirmed in §4.6.
- **E5 (cross-model docstore equality).** Chunk content is byte-identical across models, but FAISS assigns fresh per-document UUIDs on every save, so naïve hardlink fails. Canonicalize-then-hardlink is tractable; deferred to §8.9.
- **E6 (`unlink` while FAISS loaded).** **Falsified** F10 (failure-mode round-1). `faiss-node` is in-memory after `.load()`, no mmap, no SIGBUS. `kb models remove` while MCP is running is safe; documented in §4.4 + §4.11.

Items remaining for the M1+M2 PR (not RFC gates):

- **E7.** Steady-state cost as KB size grows. The current `bytes/4` token estimate accuracy needs validation against a real `text-embedding-3-small` add (operator's billing post-fact). Tracking metric, not gate.
- **E8.** Concurrent `kb models add A` × `kb search --model=B` stress test under per-model locks. Spin up 50 `kb search --model=B` while one `kb models add A` runs; assert no contention.

## 11. Critic feedback incorporated

### Round 1 — 2026-04-25

Five critic agents in parallel (`boundary-critic`, `failure-mode-analyst`, `design-minimalist`, `ambition-amplifier`, `delivery-pragmatist`) plus a `design-experimenter` empirical checkpoint.

**Adversarial pair (`ambition-amplifier` vs `design-minimalist`):** both pulled hard; the synthesis is "ship `kb compare` (G11, ambition F1) but cut `KB_SKIP_MIGRATION`, the truncate-and-hash fallback, the M2/M3 split, OQ5, redundant §8 entries, and per-chunk model_id (minimalist F1, F7, F8, F9, F10, F11, F5)." The minimalist position lost on **active.txt** (kept — the env-only design re-introduces RFC 012's mismatch pain that was the proximate motivator for §4.7) and on **per-model locks** (kept — concurrent operations on different models is the design intent; the watcher-vs-add interaction is the proof). The ambition position lost on **N3 per-KB pinning** (deferred to §8.9 future-RFC seed; cheap-but-not-now), **N8 docstore dedup** (E5 verified content is byte-identical but UUID assignment defeats naïve hardlink; canonicalize-pass is tractable but deferred), and **MCP `add_model`/`set_active_model`** (reframed from "vetoed" to "deferred under future MCP elicitation semantics" — wording change, not behavior).

**Critical findings incorporated into v2:**

- Round-1 boundary F1+F7: **`lock.ts` split into `instance-lock.ts` + `write-lock.ts`.** RFC 012 round-3 deferred this; multi-model is the right moment. `withWriteLock(resource, fn)` not `withWriteLock(modelId, fn)` — lock primitive doesn't know about models.
- Round-1 boundary F2: `FaissIndexManager` constructor takes `{provider, modelName}` — `modelId` was insufficient (the constructor must instantiate the right embeddings client; modelId is a derived artifact).
- Round-1 boundary F3: **Migration runs inside `FaissIndexManager.initialize()`**, not at call sites. Matches the existing detect-and-recover pattern.
- Round-1 boundary F4: **Single `resolveActiveModel()` helper** in `active-model.ts`; CLI and MCP both call it. Two implementations are forbidden (the round-2 N5 of RFC 012 was this exact drift bug).
- Round-1 boundary F5: RFC v1's claim that "`sanitizeMetadataForWire` whitelist extended" was wrong — `sanitizeMetadataForWire` is strip-by-default-on-extras, not a positive whitelist. v2 corrects the wording and moves `model_id` to the response envelope (round-1 minimalist F5 also).
- Round-1 boundary F6: `cli-models.ts` and `cli-compare.ts` lazy-imported via `await import()` after argv dispatch; CI smoke step asserts `kb search` doesn't open them.
- Round-1 boundary F8: `KB_ACTIVE_MODEL` exported from `config.ts` like every other env-derived constant.
- Round-1 boundary F9 + failure F14: **All `MODEL_NAME_FILE` and `readStoredModelName` callsites enumerated in §4.9 file table.** New `src/index-paths.ts` owns the per-modelId path computations; `cli.ts:checkModelMismatch` and the freshness-footer code path get updated explicitly.
- Round-1 boundary F10: **`active.txt` writes centralized in `active-model.ts`.** Only migration + `set-active` call. `updateIndex` and `kb models add` MUST NOT write it.
- Round-1 failure F1: **Module-level `MODEL_NAME_FILE` removed**; per-instance only. Jest test asserts no module imports the constant.
- Round-1 failure F2 + F3: **Robust `active.txt` reader** — BOM strip, CRLF strip, regex validate, hex-dump on failure, fall through to step 4.
- Round-1 failure F4 + delivery F6: **Migration acquires instance advisory FIRST**; CLI uses `${PATH}/.kb-migration.lock` to coordinate with MCP startup.
- Round-1 failure F5: **Pre-RFC-012 indexes** (no `model_name.txt`) — migration refuses with explicit recovery instructions; doesn't silently produce empty-slug ids.
- Round-1 failure F6: **`.adding` sentinel** (round-1 delivery F3 also) — written before any embedding work, removed on success. `list_models` / `kb models list` skip directories with `.adding`. `kb models remove` refuses (without `--force-incomplete`).
- Round-1 failure F7: **`updateIndex` MUST NOT write `active.txt`** — Jest test enforces; CI step 9 verifies in production.
- Round-1 failure F8: `kb models set-active` warns when `KB_ACTIVE_MODEL` is also set ("env will continue to override active.txt for inheriting processes").
- Round-1 failure F9: **TTY check for `kb models add`** — `!process.stdin.isTTY && !args.yes` exits 2 instantly. CI step 5 asserts.
- Round-1 failure F10: **FALSIFIED** by E6. `faiss-node` in-memory after `.load()`; `kb models remove` while MCP runs is safe. Drop the pessimism.
- Round-1 failure F11: documented in §4.11 — RFC 007 manifest gap still applies per-model.
- Round-1 failure F12: **Hard-validate `--model=<id>` argv against the slug regex** before path-joining. Reject `..`, NUL, `/`, `\`. Suggest normalized form on typo.
- Round-1 failure F13: **Determinism caveat documented** in §4.3 + §7 — `(provider, model_name)` as typed; `OLLAMA_MODEL=foo` ≠ `OLLAMA_MODEL=foo:latest` on disk.
- Round-1 failure F14: handled with F9 boundary above.
- Round-1 failure F15: **`KB_SKIP_MIGRATION` dropped entirely.**
- Round-1 minimalist F1: **Rejected.** Auto-register-on-`--refresh` is less discoverable than a dedicated `kb models add`; the "you're about to spend money" prompt has nowhere natural to live without a dedicated subcommand.
- Round-1 minimalist F2: **Rejected on active.txt** (see adversarial pair above); accepted on the surrounding noise — single-writer invariant + drop `set-active` ambient writes.
- Round-1 minimalist F3: **Rejected** on cutting `list_models` — the model set changes mid-session (operator runs `kb models add` while MCP is up), so a static-at-startup tool description goes stale.
- Round-1 minimalist F4: **Partially adopted.** Cut the CI auto-fetch (delivery F4 also). Kept the upfront estimate prose. Quarterly manual review of constants.
- Round-1 minimalist F5: **Adopted.** `model_id` moves to response envelope, not per-chunk.
- Round-1 minimalist F6: **Rejected.** Per-model locks are the design intent (concurrent ops on different models). E3 measured <0.1 ms overhead.
- Round-1 minimalist F7: **Adopted.** Migration folds into `FaissIndexManager.initialize()`; no `migration.ts` module; no `KB_SKIP_MIGRATION`.
- Round-1 minimalist F8: **Adopted.** Truncate-and-hash fallback dropped; throw on overlong.
- Round-1 minimalist F9: **Adopted.** M2+M3 was already split — v2 makes M1+M2 the combined PR (delivery F5 also).
- Round-1 minimalist F10 + F11: **Adopted.** §8.3 (Option F) collapsed; §8.7 dropped; OQ5 deleted.
- Round-1 ambition F1: **Adopted as G11.** `kb compare` lands in M2.
- Round-1 ambition F2: **Reframed.** N3 stays a non-goal but is documented as a coherent §8.9 future-RFC seed instead of a one-line dismissal.
- Round-1 ambition F3: **Partially adopted.** `list_models` reserves a `quality?: object` slot; `notes` field reads from `models/<id>/.notes.txt`.
- Round-1 ambition F4: **Deferred to §8.9.** Cumulative cost tracking is bookkeeping that minimalist F4 cut from upstream design.
- Round-1 ambition F5: **Adopted in §8.9.** `kb models eval` documented as future-RFC seed.
- Round-1 ambition F6: **Adopted (wording).** §4.5 + §8.4 reframe MCP `add_model` from "vetoed" to "deferred."
- Round-1 ambition F7: **Verified by E5; deferred to §8.9.** Content byte-identical, UUIDs differ — canonicalize-then-hardlink is tractable but ~1.81 MiB savings not worth v1 complexity.
- Round-1 ambition F8: **Deferred to OQ.** Auto-detect prompt is TTY-only (CLI safe); MCP keeps fail-fast (stdio safe).
- Round-1 ambition F9: **Adopted in G7.** Comparative freshness footer shows gap when `kb compare` runs.
- Round-1 delivery F1: **Adopted.** `KB_SKIP_MIGRATION` dropped (also minimalist F7).
- Round-1 delivery F2: **Adopted.** "(technically breaking)" CHANGELOG label, RFC 012 §5.4 precedent.
- Round-1 delivery F3: **Adopted.** `.adding` sentinel + CI smoke step 4.
- Round-1 delivery F4: **Adopted.** Quarterly manual review; no CI auto-fetch.
- Round-1 delivery F5: **Adopted.** M1+M2 land together as 0.3.0.
- Round-1 delivery F6: **Adopted.** Migration acquires instance advisory FIRST.
- Round-1 delivery F7: **Adopted.** §6.6 added partial-add and `updateIndex`-writes-active rows.
- Round-1 delivery F8: **Adopted.** smithery.yaml exposes `kbActiveModel`; documented Smithery limit.
- Round-1 delivery F9: **Adopted.** §6.2 expanded to 6 migration sub-cases.
- Round-1 delivery F10: **Adopted.** §6.5 specifies CHANGELOG Migration + Rollback subsections.
- Round-1 delivery F11: **Adopted as §6.7.** Post-publish canary + verify `prepublish-smoke.yml` is wired before 0.3.0 ships (it wasn't before 0.2.0; CHANGELOG documents the bug).
- Round-1 delivery F12: **Adopted.** §6.2 split into `smoke-fast.yml` (~2 min) and `prepublish-full.yml` (~10 min).

**Rejected (with reason):**

- Round-1 minimalist F1 (cut `kb models add`): rejected — discoverability + cost-prompt UX.
- Round-1 minimalist F3 (cut `list_models`): rejected — model set changes mid-session.
- Round-1 minimalist F6 (cut per-model locks): rejected — concurrent ops on different models is the design intent.
- Round-1 ambition F2 (promote per-KB pinning to M2): rejected — scope creep; documented as §8.9 future-RFC seed instead.
- Round-1 ambition F4 (cumulative cost tracking): rejected for v1 — bookkeeping; documented as §8.9 future-RFC seed.
- Round-1 ambition F7 (docstore hardlink in M2): rejected for v1 — E5 showed UUIDs require canonicalize-pass; ~1.81 MiB × (M-1) savings not worth v1 complexity. Documented as §8.9.

**Hand-off log:**
- `assumption-archaeologist`: not invoked — no ADR-derived behavior changed.
- `design-experimenter` 2026-04-25: 5 novel findings — §2.4 storage formula validated exactly (E1), migration latency ~12 ms (E2), per-model lock overhead <0.1 ms (E3), docstore content byte-identical but UUIDs differ (E5), F10 falsified (E6).

### Round 2 — 2026-04-25

Three focused critics (`boundary-critic`, `failure-mode-analyst`, `delivery-pragmatist`) ran on the v2.

**Critical findings incorporated into v3:**

- **Round-2 boundary F1: `index-paths.ts` extraction was misplaced.** v3 folds `readStoredModelName(modelId)`, `faissIndexBinaryPath(modelId)`, `modelDir(modelId)`, `isRegisteredModel`, `listRegisteredModels` into `active-model.ts` — the sole owner of the `models/<id>/` directory schema. Two modules co-owning the path schema is exactly the v1-F4 sin (two implementations).
- **Round-2 boundary F2: `initialize()` was conflating three lifecycle phases** (process-global advisory, one-shot directory recovery, per-instance load). v3 splits into `FaissIndexManager.bootstrapLayout()` (static, idempotent, one-shot per process) + `initialize()` (load-only, per-instance). Module-level `Promise<void>` cache prevents same-process double-call.
- **Round-2 boundary F3: `cli-compare.ts` would have duplicated read-path code from `cli.ts`.** v3 names `src/cli-read.ts` exporting `loadModelForRead(modelId)`; both `cli-search.ts` and `cli-compare.ts` import it.
- **Round-2 boundary F4: `cli.ts` was approaching "god file" size.** v3 promotes the further split: `cli.ts` (~150 LoC, routing only) → `cli-search.ts`, `cli-read.ts`, `cli-models.ts`, `cli-compare.ts`, `cli-list.ts`. Same lazy-import discipline applied uniformly.
- **Round-2 boundary F5: `.adding` sentinel filtering was named in three places without a helper.** v3 names `isRegisteredModel(modelId)` and `listRegisteredModels()` in `active-model.ts`; both encode "registered iff `models/<id>/` exists, contains `model_name.txt`, no `.adding` sentinel."
- **Round-2 boundary F6: Jest invariant tests didn't specify their technique.** v3 specifies grep-based AST walks (`globby('src/**/*.ts')` + `ts.createSourceFile`) for the "no module imports X" / "writers of X are exactly {A, B, C}" assertions. ~30 LoC. Not runtime mocks — those can't distinguish `FaissIndexManager.maybeMigrateLayout` calling the writer (allowed) from `FaissIndexManager.updateIndex` calling it (forbidden) when both live in the same file.
- **Round-2 boundary F7: OQ3 was promoted from "deferred to PR review" to RFC-level decision.** Migration when env is unset + `model_name.txt` exists: **trust the file**, combine with `config.ts:12` `huggingface` default. The wrong choice would create permanent on-disk-shape bugs that 0.3.1 cannot rename without another technically-breaking note.
- **Round-2 failure N1: same-process `initialize()` double-call had no serializer.** v3's `bootstrapLayout()` is module-level cached; tests + `kb models add` calling `initialize()` after `KnowledgeBaseServer` already constructed a manager are now safe.
- **Round-2 failure N2: fresh-install had no writer for `active.txt`.** v3 makes `cli-models.ts:add` the third permitted writer (only when `active.txt` is absent — first-model-on-disk auto-promotes to active). Updated single-writer Jest assertion to enumerate three call sites.
- **Round-2 failure N3: silent fall-through on regex-fail in `active.txt` reader.** v3 hard-fails: malformed `active.txt` exits 2 with the rejected hex bytes AND the would-be env-derived fallback id, so the operator sees the comparison and knows their typo silently overrode their intent.
- **Round-2 failure N4: `.adding` sentinel UX cliff on retry.** v3 writes `models/<id>/.adding-progress.txt` (chunk count) every batch; retry error message names the cost-of-retry up front: "Previous attempt embedded N/M chunks before interrupt; running `--force-incomplete` will re-spend ~$X."
- **Round-2 failure N5: `kb compare` failure modes were unanalyzed.** v3 §4.4 specifies: hard-fails on either model unresolvable (no half-table); scores not normalized across models (column header notes); query embedding billed twice for paid providers; no cost prompt for `kb compare` (operator is in interactive comparison mode).
- **Round-2 failure N6: `kb search --refresh --model=<id>` no cost prompt.** v3 §4.4 documents explicitly: `--refresh` re-embeds only changed files (per-file SHA256 sidecar logic); incremental cost is operator's responsibility. No prompt.
- **Round-2 failure N7: single-writer Jest test scope was ambiguous.** v3 specifies grep-based call-site enumeration (per F6 above). The runtime-mock approach can't distinguish allowed vs forbidden calls inside the same module.
- **Round-2 failure N8: orphaned model directory accumulation was undocumented.** v3 §7 documents explicitly: switching env between equivalent forms accumulates stale dirs; operator manages via `kb models remove`. `--orphans` flag is a §8.9 future-RFC seed.
- **Round-2 delivery F1: M1+M2's ~1300 LoC PR was risky.** v3 carves out **M0 (0.2.2 patch)** for the lock-module split — surgical, ~150 LoC, RFC 012 round-3-deferred — landing a week ahead of M1+M2. M1+M2 shrinks to ~1100 LoC, internally staged across 3 reviewable commits.
- **Round-2 delivery F2: `prepublish-full.yml` 10-min budget was unrealistic.** v3 bumps to "~15 min, target 10" with empirical-spike measurement required in the M1+M2 PR (run on a fresh `ubuntu-latest` runner, record actual wall time, lock the budget).
- **Round-2 delivery F3: post-publish canary was operator-manual checklist** — same anti-pattern that lost the 0.2.0 symlink bug. v3 makes it a `bin/post-publish-smoke` shell script (~80 LoC) shipped IN the M1+M2 PR; operator runs `./bin/post-publish-smoke 0.3.0` (single command, no checklist). Stretch: invoke from `release.yml` as a post-publish job pulling from the public registry.
- **Round-2 delivery F4: CHANGELOG Migration/Rollback discipline.** v3 §6.5 adds a one-sentence rule: subsections must be drafted in the same commit as the migration code, not at PR finalization.
- **Round-2 delivery F5: Smithery was shipping a "documented broken feature".** v3 §6.9: 0.3.0 CHANGELOG headline reads "Multi-model embedding support (local install only — Smithery follow-up tracked in #N)" — disclosure in title, not footnote. Smithery follow-up issue opened **at PR time**, not "to be filed later."
- **Round-2 delivery F6: no flake-exit lane for the pre-publish gate.** v3 §6.2 adds `KB_PREPUBLISH_KNOWN_FLAKY=stepN` override for marking a step informational; each use requires a follow-up issue tagged `flaky-prepublish-step` and resolution within one minor release. Discipline pattern same as `xfail` in pytest.
- **Round-2 delivery F7: empirical-gate downgrade table missing two rows.** v3 §6.6 adds: regex-misclassifies-active.txt regression and lock-module-split-breaks-importer regression. Both have explicit ship-shape (recovery action documented before the bug).

**Rejected (with reason):**

- **None.** All round-2 findings were either incorporated or already-addressed-in-prose. No round-2 finding was rejected outright.

**Hand-off log:**

- `boundary-critic` round 2: 7 findings (F1-F7); all incorporated. Boundary-critic verdict: "After v3 incorporates these, convergence is reasonable. I do not recommend a round 3 boundary-critic pass after v3 unless v3 introduces a new module not listed here." V3 introduces no new modules vs v2's spec — only removes (`index-paths.ts` folded in) and refines (`cli-search.ts`, `cli-read.ts` already pre-figured in v2 §4.4 boundary refinement).
- `failure-mode-analyst` round 2: 8 findings (N1-N8); all incorporated. Analyst verdict: "Round 3 should be **non-mandatory** but the v2→v3 prose delta is small enough that it's cheap to do." V3 makes the explicit choice to skip per the skill's early-stop rule.
- `delivery-pragmatist` round 2: 7 findings (F1-F7); all incorporated. Pragmatist verdict: "**No round-3 review needed if these land** — the design is converged." V3 lands all seven.

### Convergence

V3 is the convergence point. **Round 3 is skipped per the skill's early-stop rule.** All three round-2 critics independently called for stopping after a v3 update; their findings were architecturally bounded (no new modules), uniformly incorporated, and the residual concerns are documentation-class (file table specificity, CI budget realism, CHANGELOG discipline) rather than design-architectural.

The §6.2 `prepublish-full.yml` gate is the next signal — if it catches a defect during M1+M2 PR development, the design is updated and the RFC patched (in-place, not a v4). Per RFC 012 §11's analogous convergence note: "further rounds without M1-implementation evidence would be diminishing returns."

**Operator decision points before implementation begins:**

1. Approve M0 (lock-module split as 0.2.2 patch precursor) or fold back into M1+M2.
2. OQ1, OQ2, OQ7, OQ8 — defer to M2/M3 PR review unless operator wants positions taken now.
3. The `KB_PREPUBLISH_KNOWN_FLAKY` flake-exit lane — confirm the discipline (every use opens an issue) is acceptable, or veto it for stricter "no-flake-zero-tolerance".
4. ~~**(v4 addition)** OQ9 — bundled large-fixture source (arxiv abstracts vs Wikipedia subset vs repo's own docs).~~ **RESOLVED 2026-04-26 — arxiv chosen by operator delegation.** See §9 OQ9 + §4.13.4.

### v4 amendment — 2026-04-26 (operator scope addition)

After v3 was opened as PR #101 and promoted ready-for-review, the operator requested an additional deliverable: a benchmarking skill that compares two embedding models on a fixture and emits an HTML report (G12, §4.13, M5). Captured here for the audit trail rather than back-revising prior rounds.

**Why this is incremental, not architectural:**
- The multi-model rails (M0-M4) are unchanged. M5 sits on top of the same `kb models add` / `kb search --model=<id>` / `kb compare` surface that M2 ships. No new lock semantics, no new on-disk layout, no new MCP tools.
- The orchestrator extends the existing RFC 007 PR 0.1 benchmark harness (`benchmarks/{run.ts, scenarios/, fixtures/, types.ts}` already exist) rather than introducing a parallel system.
- The skill file follows RFC 002's `.claude/skills/<slug>/SKILL.md` convention; if RFC 002's scaffolding hasn't merged when M5 lands, the orchestrator + harness ship standalone and the skill body (inlined verbatim in §4.13.8) drops in later as a one-file PR.

**What this v4 amendment adds (full diff):**
- §3.1: G12 (selection workflow goal).
- §3.2: N10 (no MTEB-grade claims), N11 (no new `kb-bench` binary).
- §4.9: M5 file table reference (full breakdown in §4.13.7).
- §4.12: threat-model entry for `benchmarks/.cache/` (operator-owned build artefact, outside trust boundary; `--fixture=external` uses `$TMPDIR`, not `${FAISS_INDEX_PATH}`).
- §4.13 (NEW, ~270 lines): full design — orchestrator surface (§4.13.2), phases (§4.13.3), fixture corpus (§4.13.4), HTML report layout (§4.13.5), recommendation rules (§4.13.6), file table (§4.13.7), inlined SKILL.md body (§4.13.8), concurrency invariants (§4.13.9), explicit non-goals for M5 (§4.13.10).
- §6.1: M5 milestone.
- §6.5: `### Added in 0.3.x (M5)` CHANGELOG block.
- §9: OQ9 (fixture corpus source choice).
- This amendment.

**Why no new critic round:**
- The addition is additive (new files only — no edits to M0-M4 modules; no on-disk format change; no MCP-tool change; no lock-semantic change).
- §4.13.10 explicitly enumerates what M5 does NOT do (no statistical significance test, no 3+ model, no MCP `bench_compare` tool, no CI integration for the comparison run); these are the cuts that an `ambition-amplifier` vs `design-minimalist` adversarial pair would have produced anyway.
- The two surfaces an external critic could meaningfully shape — the fixture corpus source and the recommendation thresholds — are already exposed as **OQ9** for operator decision and as documented constants in §4.13.6 for reviewer push-back.
- Running a full Round 4 (5 critics × ~15 min each) for a self-contained additive deliverable is disproportionate. **If the operator disagrees, a focused Round 4 on §4.13 alone — `boundary-critic` (does it leak into M0-M4 internals?) + `failure-mode-analyst` (orchestrator crash mid-comparison? cache corruption? OOM on `--fixture=large`?) + `delivery-pragmatist` (will arxiv API rate-limit a CI flake? is the HTML reviewer-portable?) — is cheap and can land as a v5 amendment without re-revisiting M0-M4.**

**No prior-round findings revisited.** All Round 1 / Round 2 / empirical-checkpoint conclusions stand unchanged.
