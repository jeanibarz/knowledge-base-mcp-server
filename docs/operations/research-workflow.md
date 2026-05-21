# `kb research` — Evidence Planning and Collection

`kb research` is a read-only, deterministic workflow for collecting evidence
from your knowledge bases for a research question. It is not an autonomous
agent: it does not call an LLM, does not write KB notes, and does not trigger
local-research-agent. The output is a self-contained run directory that an
agent or operator can then hand to `kb ask` or any LLM as a coherent context
block.

## When to use it

- You have a focused research question and want a vetted, reproducible
  evidence set across multiple shelves.
- You want `kb ask` to answer from a *curated* packet rather than the raw
  top-k of a single query.
- You want a durable artifact (the run directory) you can re-run, version,
  attach to a PR, or feed to another tool.

If you only need one quick answer, prefer `kb ask` directly. `kb research` is
the right tool when the question deserves multi-query coverage.

## Two-phase contract

```bash
kb research plan    "<question>" [--format=md|json] [planner options]
kb research collect "<question>" --run-dir=<path>   [--format=md|json] [planner options]
```

`plan` is the *dry-run*: it reads KB descriptions and `kb stats`, picks the
likely shelves, generates a deterministic set of query candidates, and emits a
`kb-research-plan.v1` envelope. No retrieval runs. Inspect the plan before
committing to a collection.

`collect` re-runs the same planner, then executes every query through the
existing hybrid retrieval surface (`kb search --mode=hybrid`), deduplicates
hits across queries, and writes five artifacts under `--run-dir`:

| File | Contents |
| --- | --- |
| `run.json` | Run metadata (command, started/finished timestamps, status, artifact paths) |
| `plan.json` | The planner output — same shape as `plan --format=json` |
| `ledger.json` | `kb-research-ledger.v1` — every hit with shelf, path, line range, score, query id, source kind |
| `evidence_packet.md` | Human-readable packet: Question, Selected Shelves, Queries, Evidence Found (grouped by source file), Evidence Gaps, Sources |
| `events.jsonl` | Structured event stream from the collection (one record per shelf search) |

`evidence_packet.md` is what you typically hand to a downstream LLM or paste
into a follow-up `kb ask --task-context-file=…`. `ledger.json` is the
machine-readable contract for any tooling on top.

## Planner controls

The planner is deterministic. The flags below shape its decisions but never
add non-determinism:

- `--include-kb=<name>` (alias `--kb=<name>`, repeatable): pin a shelf into
  the plan even if its score is low.
- `--exclude-kb=<name>` (repeatable): drop a shelf from consideration.
- `--max-shelves=<n>` (default `5`): cap automatic shelf selection.
- `--k=<int>` (default `5`): hits per query/shelf during collection.

The planner intentionally treats broad tokens (`agent`, `system`) as
insufficient on their own — domain shelves with specific matches rank ahead
of operational shelves that only share generic wording (#452).

## Read the plan first

```bash
kb research plan "Compare RAG eval frameworks" --format=json | jq '.queries[].text'
```

If the planned queries look thin or off-target, refine the question or pin the
right shelves with `--include-kb`. Re-running `plan` is free.

## Collect into a run directory

```bash
kb research collect "Compare RAG eval frameworks" \
  --run-dir=runs/rag-eval \
  --format=json
```

`status: complete` means every planned hybrid search returned. `status:
failed` means at least one shelf-search failed (the ledger still includes the
successful entries and the failure record). Exit codes mirror the status: `0`
for complete, `1` for failed, `2` for argv errors.

## Hand the packet to `kb ask`

```bash
kb ask "$(cat runs/rag-eval/evidence_packet.md)" \
  --task-context-file=runs/rag-eval/evidence_packet.md \
  --save-transcript --kb=research --title="RAG eval comparison" --yes
```

The packet is markdown-safe (grouped by source so the same passage is not
repeated for every matching query). When the answer is good, save the
transcript so the cited synthesis becomes a durable KB note.

## Diagnose

- **Empty `selected_shelves`**: no shelf description matched. Add a `--include-kb`
  pin, or improve the shelf's `README.md` so the planner has something to
  weight on.
- **`dense_index_empty_coverage` risk**: a selected shelf has files but no
  dense chunks. Hybrid search still works (it falls back to lexical), but a
  `kb reindex` is overdue.
- **`status: failed`**: open the `events.jsonl` to see which shelf failed.
  Usually a `KB_NOT_FOUND` or `PROVIDER_TIMEOUT` — fix the underlying issue
  and re-collect into a fresh `--run-dir`.

## JSON contract

See [`docs/cli-json-contracts.md`](../cli-json-contracts.md#kb-research) for
the stable plan and collect envelopes, plus per-entry ledger fields.

## Related

- `kb feedback` to record judgments on collected evidence — see
  [`feedback-workflow.md`](feedback-workflow.md).
- `kb ask --save-transcript` to persist the synthesised answer.
- `kb eval` to turn promoted feedback rows back into regression cases.
