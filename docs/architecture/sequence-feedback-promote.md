# Sequence — `kb feedback` (add + promote)

`kb feedback` has four actions; this diagram covers the two that mutate
state. `list` and `summary` are read-only passes over the JSONL ledger and
are not diagrammed separately.

The CLI entrypoint is `runFeedback` (`src/cli-feedback.ts::runFeedback`), which
dispatches to `appendFeedbackEntry` (add) or
`buildPromotedEvalFixture` + `appendPromotedCaseToFixtureFile` (promote).

The diagrams anchor each step to the function that performs it
(`file::Symbol`), not to line numbers, so edits to the source do not
silently stale them. The anchor checker (`npm run docs:check-anchors`) skips
fenced blocks, so every symbol named inside the diagrams is also listed —
and validated — under [Source anchors](#source-anchors).

## Add a judgment

```mermaid
sequenceDiagram
  autonumber
  participant Op as Operator/agent
  participant Cli as runFeedback<br/>src/cli-feedback.ts::runFeedback
  participant Ledger as appendFeedbackEntry<br/>src/feedback-ledger.ts::appendFeedbackEntry
  participant KbFs as resolveKnowledgeBaseDir<br/>src/kb-fs.ts
  participant FS as &lt;kb&gt;/.index/relevance-feedback.jsonl

  Op->>Cli: kb feedback add --kb=<name> --query=<text><br/>--source=<rel-path> [verdict flags]
  Cli->>KbFs: resolveKnowledgeBaseDir(KB_ROOT, kb)<br/>src/cli-feedback.ts::runFeedback
  KbFs-->>Cli: <kb> absolute path
  Note over Cli: parseFeedbackArgs validates required fields<br/>src/cli-feedback.ts::parseFeedbackArgs
  Cli->>Ledger: appendFeedbackEntry(kbDir, input)<br/>src/cli-feedback.ts::runFeedback
  Ledger->>Ledger: buildFeedbackEntry → ULID id,<br/>created_at, SHA-256 of task_context<br/>src/feedback-ledger.ts::buildFeedbackEntry
  Ledger->>FS: fsp.appendFile JSONL line
  FS-->>Ledger: ok
  Ledger-->>Cli: FeedbackLedgerEntry
  Cli-->>Op: { ledger_path, entry } (JSON)<br/>src/cli-feedback.ts::writeFeedbackAddResult<br/>exit 0
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
  participant Cli as runFeedback<br/>src/cli-feedback.ts::runFeedback
  participant Read as readFeedbackLedger<br/>src/feedback-ledger.ts::readFeedbackLedger
  participant Build as buildPromotedEvalFixture<br/>src/feedback-ledger.ts::buildPromotedEvalFixture
  participant Append as appendPromotedCaseToFixtureFile<br/>src/feedback-ledger.ts::appendPromotedCaseToFixtureFile
  participant FS as fixture.yml

  Op->>Cli: kb feedback promote --kb=<name><br/>--query=<text> [--fixture=<path> --yes]
  Cli->>Read: readFeedbackLedger(kbDir)<br/>src/cli-feedback.ts::runFeedback
  Read->>Read: parse JSONL<br/>src/feedback-ledger.ts::parseFeedbackJsonl
  Read-->>Cli: FeedbackLedgerEntry[]
  Cli->>Build: buildPromotedEvalFixture(entries, parsed)<br/>src/cli-feedback.ts::runFeedback
  Build->>Build: keep rows matching --kb and --query
  Build-->>Cli: { gate, cases: [one case for the query] }

  alt --fixture && --yes (write mode)
    Cli->>Append: appendPromotedCaseToFixtureFile(path, fixture)<br/>src/cli-feedback.ts::runFeedback
    Append->>Append: load existing YAML or create new
    Append->>FS: write merged YAML atomically
    Append-->>Cli: { caseCount, created }
    Cli-->>Op: { fixture_path, wrote:true, created, case_count }<br/>src/cli-feedback.ts::writeFeedbackPromoteWriteResult<br/>exit 0
  else preview (default)
    Cli->>Cli: dumpPromotedEvalFixture(fixture)<br/>src/cli-feedback.ts::writeFeedbackPromotePreview
    Cli-->>Op: { wrote:false, fixture_yaml }<br/>src/cli-feedback.ts::writeFeedbackPromotePreview<br/>exit 0
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

## Source anchors

Every symbol the diagrams reference, listed outside the fenced blocks so
`npm run docs:check-anchors` fails if one is renamed or removed:

- `src/cli-feedback.ts::runFeedback` — argument parsing, KB resolution and
  action dispatch.
- `src/cli-feedback.ts::parseFeedbackArgs` — required-field validation.
- `src/cli-feedback.ts::writeFeedbackAddResult` — `add` result envelope.
- `src/cli-feedback.ts::writeFeedbackPromotePreview` — `promote` preview
  envelope (renders YAML via `dumpPromotedEvalFixture`).
- `src/cli-feedback.ts::writeFeedbackPromoteWriteResult` — `promote` write
  result envelope.
- `src/feedback-ledger.ts::appendFeedbackEntry` — appends one JSONL row.
- `src/feedback-ledger.ts::buildFeedbackEntry` — ULID, timestamp, defaults
  and task-context hash.
- `src/feedback-ledger.ts::readFeedbackLedger` — reads the ledger file.
- `src/feedback-ledger.ts::parseFeedbackJsonl` — parses JSONL rows.
- `src/feedback-ledger.ts::buildPromotedEvalFixture` — filters rows for the
  query and builds the eval case.
- `src/feedback-ledger.ts::dumpPromotedEvalFixture` — renders the fixture YAML.
- `src/feedback-ledger.ts::appendPromotedCaseToFixtureFile` — merges the case
  into the fixture file.

## Related

- Operator walk-through: [`docs/operations/feedback-workflow.md`](../operations/feedback-workflow.md)
- JSON contract: [`docs/cli-json-contracts.md`](../cli-json-contracts.md#kb-feedback)
- Upstream: `kb research` (this diagram's sibling) produces the candidate
  evidence operators typically judge — see
  [`sequence-research-collect.md`](sequence-research-collect.md).
- Downstream: the promoted fixture is consumed by `kb eval`
  (`docs/cli-json-contracts.md#kb-eval`).
