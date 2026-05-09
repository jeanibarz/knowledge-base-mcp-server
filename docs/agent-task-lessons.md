# Agent-task lessons

`kb remember --lesson` is the path for recording a **generic, transferable lesson** an agent learned during a task. Lessons land in the `agent-task-lessons` knowledge base by default and are validated to follow a single, predictable shape so they remain useful months later, in unrelated repos, in different agent harnesses.

## Quick start

```bash
kb remember --lesson \
  --title "Recheck PR state before follow-up pushes" \
  --stdin --yes <<'EOF'
## Mistake

Pushed a follow-up commit without rechecking PR state, after a maintainer had
already merged a competing branch. The push raced against the merged tip and
re-introduced reverted code.

## Why it happened

I treated the PR's HEAD from the start of the session as still authoritative,
even after a long-running review/test cycle. The `gh pr view` cache was stale.

## Better next time

Before any push that follows a non-trivial pause (review, CI, conversation),
re-fetch PR state with `gh pr view <N> --json state,mergeStateStatus,headRefOid`
and confirm `state == "OPEN"` and `headRefOid` matches the local tip.
EOF
```

If stdin is empty, or any of the three required sections is missing, the
command exits `2` and prints a guided skeleton you can pipe back through
stdin. No partial / low-quality note ever lands on disk.

## Required structure

Every lesson body must contain three H2 sections:

```markdown
## Mistake

<one or two sentences: what action led to the unwanted outcome>

## Why it happened

<root cause: missing context, wrong assumption, ambiguous instruction…>

## Better next time

<a generic, transferable rule — avoid task-specific names, paths, branches, or
PR numbers>
```

Heading matching is forgiving: case-insensitive, trailing punctuation stripped,
and the plural `Mistakes` is accepted as `Mistake`. Headings inside fenced code
blocks (` ``` ` … ` ``` `) never count — the validator parses the markdown AST,
not raw lines.

The slugified title becomes the filename. Re-running with the same title fails
loudly (the create path refuses to overwrite an existing slug); use a more
specific title or `kb remember --append=<existing-path>` to extend an
existing note.

## Default knowledge base

`--lesson` defaults `--kb` to `agent-task-lessons`. The KB directory is
auto-created the first time you run the command, so a fresh checkout doesn't
need a separate `mkdir`. If you'd rather scope lessons elsewhere — a personal
KB, a team KB — pass `--kb=<name>` explicitly; the default is only applied
when no `--kb` is given.

## When to use `--lesson` vs other write paths

| Use… | When the content is… |
|---|---|
| `kb remember --lesson` | A **generic transferable rule** an agent should follow next time. Independent of repo, branch, PR, or filesystem layout. Survives the death of the current task. |
| Repo `CLAUDE.md` / `CONTRIBUTING.md` | A rule that applies **only inside this repository**. References this repo's tooling, conventions, or invariants. Lives next to the code it constrains. |
| Agent skill / runbook | A **multi-step procedure** the agent runs (or should run) again — long enough to need its own headings, not a single-paragraph rule. |
| `kb remember --append-section=<H>` | An **incremental fact** added to an existing note's section without rewriting the file. |
| `kb capture` | A **command output snapshot** appended as a fenced block (e.g. a `gh pr view` blob, an `ollama list` table). |

If the rule starts with the name of a specific PR, branch, file path, or
ticket number, it probably belongs in repo-local docs (CLAUDE.md, an ADR, a
PR description) — not in `agent-task-lessons`.

## Composes with the similarity guard

`--lesson` writes go through the same default-on semantic preflight that
landed in #154. If a similar lesson already exists, the write is refused
with the existing chunk surfaced, and you can either refine the existing
note (`kb remember --append=<that-path>`) or rerun with `--force` after
inspecting the candidate. Pass `--no-check-similar` to skip the preflight
for one call.

## Related

- `kb remember` — see `kb --help` for the full flag matrix.
- `kb where --topic=<query>` — pre-write recommendation for the best KB
  + file to update.
- Issue #200 — original feature request.
