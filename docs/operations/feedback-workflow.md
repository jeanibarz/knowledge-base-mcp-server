# `kb feedback` — Relevance Ledger and Eval Promotion

`kb feedback` is a per-KB ledger for relevance judgments. It exists to close
the loop between *retrieving* and *measuring*: every judgment you record
becomes a potential regression case for `kb eval`, so an irrelevant result you
flag today turns into a CI gate tomorrow.

The ledger lives at `<kb>/.index/relevance-feedback.jsonl` — alongside the
hash sidecars, one JSON record per line, append-only.

## When to use it

- You just ran a `kb search` or `kb research collect` and noticed a result
  that should rank higher (or shouldn't appear at all).
- You want a query to become an `kb eval` regression case once you have a few
  judgments on it.
- You are iterating on retrieval (reranker, gate floor, contextual ingest)
  and want a growing labelled set without inventing fixtures from scratch.

## Three actions

```bash
kb feedback add     --kb=<name> --query=<text> --source=<rel-path> [judgement flags] --format=json
kb feedback list    --kb=<name> [--query=<text>] [--limit=<int>]                       --format=json
kb feedback promote --kb=<name> --query=<text> [--fixture=<path> --yes]               --format=json
```

### Record a judgment

```bash
kb feedback add \
  --kb=work \
  --query="rollback procedure" \
  --source=runbooks/deploy.md \
  --chunk-id="work/runbooks/deploy.md#L42-L78" \
  --verdict=relevant \
  --relevance=3 \
  --group=runbook \
  --note="matches step 3 in deploy.md"
```

Fields:

- `--verdict` — one of `relevant`, `irrelevant`, `stale`, `misleading`. Non-
  relevant verdicts default to `relevance=0`; `relevant` defaults to `3`.
- `--relevance=0..3` — graded relevance (NDCG-friendly). Override the default.
- `--chunk-id` — paste from `kb search --format=json` if you want to bind the
  judgment to the exact chunk rather than the file.
- `--group=<label>` — intent / topic label for diversity metrics. Repeatable.
- `--task-context=<text>` — captured as a SHA-256 hash only. The raw text is
  never persisted.
- `--note=<text>` — short reviewer note stored verbatim.

### List recent judgments

```bash
kb feedback list --kb=work --query="rollback procedure" --limit=20 --format=json
```

Entries are sorted newest-first. `--query` is an exact match; omit it to see
the entire ledger.

### Promote into an eval fixture

The default `promote` is read-only — it prints the YAML it *would* append:

```bash
kb feedback promote --kb=work --query="rollback procedure" --format=md
```

Pipe-review the YAML. When it looks right, write it:

```bash
kb feedback promote \
  --kb=work \
  --query="rollback procedure" \
  --name="deploy rollback runbook" \
  --gate \
  --fixture=docs/testing/feedback-fixture.yml \
  --yes
```

Repeated promotions for the same query append further cases (the fixture
keeps growing). Add `--mode=hybrid` and `--k=10` to lock retrieval settings
into the case.

## Loop into CI

The promoted fixture is a standard `kb eval` input:

```bash
kb eval docs/testing/feedback-fixture.yml --format=json
```

Gated cases (`gate: true` in the fixture, or `--gate` at promotion) fail the
command (`exit 1`) if `required_sources` are missing or `forbidden_sources`
appear. Wire that into CI so reverted retrieval regressions surface
immediately.

## What the ledger stores

```jsonc
{
  "id": "01HVT7C0DXFG2MJC9Y4N9YEH3R",   // ULID
  "kb": "work",
  "created_at": "2026-05-21T09:15:00.000Z",
  "query": "rollback procedure",
  "source": "runbooks/deploy.md",
  "chunk_id": "work/runbooks/deploy.md#L42-L78",
  "verdict": "relevant",
  "relevance": 3,
  "task_context_sha256": "0123…",
  "note": "matches step 3 in deploy.md",
  "groups": ["runbook"]
}
```

The file is append-only and human-readable. If you need to retract an entry,
edit the file in place and remove the offending line; there is no
`kb feedback remove` because promotion already reflects only the *current*
ledger snapshot.

## Backup

The ledger is git-friendly. Commit `<kb>/.index/relevance-feedback.jsonl`
alongside the KB content if you want history. For private notes, route it
through your usual secrets-aware backup.

## JSON contract

See [`docs/cli-json-contracts.md`](../cli-json-contracts.md#kb-feedback) for
the stable envelopes for `add`, `list`, and `promote` (preview and write).

## Related

- `kb research collect` to generate candidate evidence to judge — see
  [`research-workflow.md`](research-workflow.md).
- `kb eval` to run the promoted fixture as a regression check.
