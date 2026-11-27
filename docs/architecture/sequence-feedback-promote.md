# Sequence — `kb feedback` (add + promote)

`kb feedback` has four actions; this diagram covers the two that mutate
state. `list` and `summary` are read-only passes over the JSONL ledger and
are not diagrammed separately.

The CLI entrypoint is `runFeedback` at `src/cli-feedback.ts:123-175`, which
dispatches to `appendFeedbackEntry` (add) or
`buildPromotedEvalFixture` + `appendPromotedCaseToFixtureFile` (promote).

## Add a judgment

```mermaid
sequenceDiagram
  autonumber
  participant Op as Operator/agent
  participant Cli as runFeedback<br/>src/cli-feedback.ts:123-175
  participant Ledger as appendFeedbackEntry<br/>src/feedback-ledger.ts:182-188
  participant KbFs as resolveKnowledgeBaseDir<br/>src/kb-fs.ts
  participant FS as &lt;kb&gt;/.index/relevance-feedback.jsonl

  Op->>Cli: kb feedback add --kb=<name> --query=<text><br/>--source=<rel-path> [verdict flags]
  Cli->>KbFs: resolveKnowledgeBaseDir(KB_ROOT, kb)<br/>src/cli-feedback.ts:134
  KbFs-->>Cli: <kb> absolute path
  Note over Cli: parseFeedbackArgs validates required fields<br/>src/cli-feedback.ts:177-204
  Cli->>Ledger: appendFeedbackEntry(kbDir, input)<br/>src/cli-feedback.ts:142
  Ledger->>Ledger: buildFeedbackEntry → ULID id,<br/>created_at, SHA-256 of task_context<br/>src/feedback-ledger.ts:228-249
  Ledger->>FS: fsp.appendFile JSONL line
  FS-->>Ledger: ok
  Ledger-->>Cli: FeedbackLedgerEntry
  Cli-->>Op: { ledger_path, entry } (JSON)<br/>src/cli-feedback.ts:298-315<br/>exit 0
```

Stable guarantees:

- The ledger file is append-only. If a prior process held it open with a
  pending write, the new line still appends cleanly thanks to POSIX
  `O_APPEND` semantics.
- `task_context_sha256` is computed at `buildFeedbackEntry` time; raw task
  context never reaches disk.
- `verdict` and `relevance` defaults are applied in `buildFeedbackEntry`,
  not in the CLI parser — direct programmatic callers get the same defaults
  as the CLI.

## Promote into an eval fixture

```mermaid
sequenceDiagram
  autonumber
  participant Op as Operator/agent
  participant Cli as runFeedback<br/>src/cli-feedback.ts:123-175
  participant Read as readFeedbackLedger<br/>src/feedback-ledger.ts:190-204
  participant Build as buildPromotedEvalFixture<br/>src/feedback-ledger.ts:251-302
  participant Append as appendPromotedCaseToFixtureFile<br/>src/feedback-ledger.ts:308-331
  participant FS as fixture.yml

  Op->>Cli: kb feedback promote --kb=<name><br/>--query=<text> [--fixture=<path> --yes]
  Cli->>Read: readFeedbackLedger(kbDir)<br/>src/cli-feedback.ts:162
  Read->>Read: parse JSONL,<br/>filter by --query<br/>src/feedback-ledger.ts:206-226
  Read-->>Cli: FeedbackLedgerEntry[]
  Cli->>Build: buildPromotedEvalFixture(entries, parsed)<br/>src/cli-feedback.ts:163
  Build-->>Cli: { gate, cases: [one case for the query] }

  alt --fixture && --yes (write mode)
    Cli->>Append: appendPromotedCaseToFixtureFile(path, fixture)<br/>src/cli-feedback.ts:165
    Append->>Append: load existing YAML or create new
    Append->>FS: write merged YAML atomically
    Append-->>Cli: { caseCount, created }
    Cli-->>Op: { fixture_path, wrote:true, created, case_count }<br/>src/cli-feedback.ts:402-421<br/>exit 0
  else preview (default)
    Cli->>Cli: dumpPromotedEvalFixture(fixture)<br/>src/cli-feedback.ts:389
    Cli-->>Op: { wrote:false, fixture_yaml }<br/>src/cli-feedback.ts:384-400<br/>exit 0
  end
```

## Key invariants

- **Preview by default.** Without both `--fixture` and `--yes`, no file is
  touched. The `wrote: false` envelope carries the rendered YAML so the
  operator can review.
- **One case per promotion.** Each `promote` call emits exactly one `kb eval`
  case for the target query (the case includes every ledger row that
  matches). Re-running promotion appends another case rather than mutating
  the previous one, so fixture history is monotonic.
- **Idempotency boundary.** Adding the same judgment twice via `kb feedback
  add` produces two ledger rows (different ULIDs). Operator-driven
  retraction is by hand-editing the JSONL file — there is no `remove`.

## Related

- Operator walk-through: [`docs/operations/feedback-workflow.md`](../operations/feedback-workflow.md)
- JSON contract: [`docs/cli-json-contracts.md`](../cli-json-contracts.md#kb-feedback)
- Upstream: `kb research` (this diagram's sibling) produces the candidate
  evidence operators typically judge — see
  [`sequence-research-collect.md`](sequence-research-collect.md).
- Downstream: the promoted fixture is consumed by `kb eval`
  (`docs/cli-json-contracts.md#kb-eval`).
