# Retrieval Eval Fixture Methodology

`kb eval` fixtures are regression tests for retrieval quality. They are not a
recording of whatever `kb search` returned today. A useful fixture starts from a
human-verified evidence set, names the failure mode it protects, and uses the
smallest schema knob that would catch that failure again.

Use this guide when creating or reviewing fixtures for `kb eval`. The schema is
deliberately small: top-level `gate`, and per-case `name`, `query`, `kb`, `k`,
`threshold`, `gate`, `required_sources`, `forbidden_sources`,
`expected_metadata`, `max_duplicate_groups`, and `stale_policy`.

## Why Fixtures Miss Regressions

**Tautology fixtures** copy the current top-k from `kb search` into
`required_sources`. They pass because the system already returned those files,
not because the files are the right answer. Start from the source document,
issue, or runbook first; only run search after the gold evidence set is written.

**Brittle precision fixtures** put every irrelevant hit into
`forbidden_sources`. That turns normal rank movement into noise. Forbid only
sources that represent a real bug: a deleted policy, another KB's file, an
obsolete runbook, or a source that previously caused a bad answer.

**Over-broad metadata fixtures** assert metadata that is not part of the author
contract. `expected_metadata` is strongest when it checks authored frontmatter
such as `frontmatter.status`, `frontmatter.owner`, or `frontmatter.tier`. Avoid
system-generated fields such as `chunkIndex`, `extension`, and provider-specific
details unless the bug is specifically about those fields.

## Vocabulary And Knobs

Local prior art uses `R` for retrieved documents and `G` for the verified gold
evidence set. Precision asks how much of `R` belongs in `G`; recall asks how
much of `G` was recovered. `kb eval` does not compute a full metric suite, but
its knobs let you encode floors that catch the same classes of regression.

| Concept | Fixture knob | Default use |
|---|---|---|
| Recall floor | `required_sources` | The canonical source must appear somewhere in top-k. |
| Precision floor | `forbidden_sources` | A known-bad source must not appear. |
| Output tidiness | `max_duplicate_groups` | One source should not crowd out the result set. |
| Freshness contract | `stale_policy` | Use `fresh` for release gates, `allow_stale` for local packs, `stale` only when testing stale detection. |
| Metadata pin | `expected_metadata` | At least one result must carry an authored metadata value. |
| CI behavior | top-level or per-case `gate` | Gated failures exit nonzero; ungated failures warn. |
| Scope | `kb` | The query should search only the named KB. |
| Search shape | `query`, `k`, `threshold` | The user wording and retrieval budget being protected. |

## Four Fixture Archetypes

Every serious fixture pack should contain at least one of these.

**Smoke.** One ungated case per important KB. It should pass after the first
index build and catch broken model/index plumbing.

```yaml
- name: smoke - docs can answer doctor checks
  query: what health checks run when I invoke the doctor command
  kb: docs
  required_sources: [README.md]
  stale_policy: allow_stale
```

**Recall floor.** A gated case whose `required_sources` points at a stable,
canonical document. This catches "search stopped finding the answer."

```yaml
- name: recall - per-file hash sidecars
  query: how does the index decide which files to re-embed
  kb: docs
  gate: true
  required_sources: [docs/architecture/adr/0002-per-file-hash-sidecars.md]
  stale_policy: fresh
```

**Precision floor.** A gated case whose `forbidden_sources` lists a previously
harmful false positive. This catches "the old wrong answer came back."

```yaml
- name: precision - deployment archive stays out
  query: current rollback procedure
  kb: ops
  required_sources: [runbooks/deploy.md]
  forbidden_sources: [archive/old-deploy.md]
  gate: true
```

**Near-miss / bug-derived.** A case derived from a closed bug or surprising
manual failure. Start it ungated, keep the exact bad source in
`forbidden_sources`, and promote it only after it has been boring for a while.

```yaml
- name: near miss - cross-kb scope regression
  query: production database restore checklist
  kb: work
  forbidden_sources: [personal/**]
  gate: false
```

## Gating Ladder

Start with roughly 80 percent warning cases and 20 percent gated cases. Gate the
small, boring cases first: smoke checks for required KBs, one recall floor for a
permanent doc, and one precision floor for a bug you have already fixed. Leave
new adversarial cases ungated until they run green on at least three consecutive
merges.

Promote a fixture to `gate: true` only when all of these are true: the
source-of-truth document is stable, the query represents a real user question,
the case has failed at least once for an actionable reason or protected a known
bug, and the owner knows what to do when it fails.

Demote a flaky gated fixture within 24 hours. Flakiness is still evidence, but a
gate that nobody trusts teaches contributors to ignore eval output. Keep the
case as warning-only, add a comment explaining the suspected cause, and open a
follow-up if the instability is worth fixing.

## Gold-Set Rotation

Keep two pools.

The **frozen core** is small, stable, and rarely edited. Ten cases is enough for
a local-first project. Change these only when the source document is renamed,
deleted, or deliberately superseded. The core protects historical behavior and
lets maintainers compare scores over time.

The **rotating arena** keeps pressure on the current system. Rotate 10 to 20
percent of arena cases per release from new bug fixes, new KB content, and
manual retrieval surprises. Rotation means replacement, not deletion of hard
history: if an arena case catches a real regression, move it into the frozen
core or a bug-derived pack before making room for new cases.

Track core-set changes in release notes or the PR body. A score change without
fixture-set provenance is hard to interpret.

## Contamination Guardrails

Never write `required_sources` by copying the current top-k. Read the target
document, decide whether it is truly required, then run `kb search` to see
whether the system finds it.

Keep metadata assertions on authored fields. `frontmatter.status: approved` is
a contract; `chunkIndex: 7` is an implementation accident.

Annotate each non-trivial case with comments:

```yaml
# author: jean
# source-of-truth: docs/architecture/adr/0002-per-file-hash-sidecars.md
# protects: false negatives after index invalidation changes
```

Separate training and evaluation material when possible. If you tune prompts,
thresholds, or retrieval mode on a fixture, move that fixture out of the frozen
core or record that it became calibration data. The easiest way to memorize an
eval is to keep adjusting the system until today's top-k exactly matches the
answer key.

## Failure Mode To Fixture Knob

| Failure mode | Primary knob | Add this context |
|---|---|---|
| Canonical answer disappears | `required_sources` | Keep `query` close to the user wording that failed. |
| Wrong legacy answer returns | `forbidden_sources` | Use only once-bad or clearly obsolete sources. |
| Duplicate chunks crowd the result set | `max_duplicate_groups` | Set a loose budget first; tighten after observing stable output. |
| Search crosses KB boundaries | `kb` plus `forbidden_sources` | Forbid a representative source from the wrong KB. |
| Stale index hides fresh edits | `stale_policy: fresh` | Use this only in environments that refresh before eval. |
| Stale-warning path regresses | `stale_policy: stale` | Reserve for tests that intentionally create stale state. |
| Authored metadata stops flowing | `expected_metadata` | Prefer whitelisted frontmatter fields. |
| Model or mode change shifts quality | `required_sources` and `forbidden_sources` | Run the same fixture under both candidates and compare failures. |
| Threshold or top-k change cuts too hard | `k` and `threshold` | Pin only when the budget itself is part of the contract. |

## Worked Example

`docs/testing/fixtures/methodology-starter.yml` is a five-case starter pack that
demonstrates smoke, recall, precision, metadata, duplicate-budget, and
bug-derived cases. The Jest suite parses it with the same normalizer used by
`kb eval`, so schema drift breaks tests without requiring an embedding provider.
Copy it for a real KB, replace the comments and source paths with documents you
have read, and start with `gate: false` until the pack has proven stable.

## Failure Handling

When a fixture fails, first decide whether the fixture or the system changed.
Run `kb eval <fixture> --format=json` so the failing knob is explicit. Run
`kb search "<query>" --kb=<name> --format=json` to inspect the actual ranked
sources. Run `kb doctor` if the failure could be model, index, backend, or
freshness related. If the branch includes a first-class `kb explain` command,
use it here to compare the failed query against the evidence set; otherwise keep
the JSON search output in the PR or issue.

Only then edit the fixture. A failing eval is useful precisely because it slows
down answer-key edits until after the retrieval behavior has been inspected.
