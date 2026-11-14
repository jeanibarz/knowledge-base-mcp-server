<!--
Work every checklist row carrying a `kookr:check:*` marker. The PR checklist
workflow verifies these rows against the merge-base diff with Kookr's pinned,
deterministic verifier:

- keep each marked row verbatim on ONE line (the marker comment included);
- check a row only when you performed it: a checked row is an assertion that
  the evidence is in this PR;
- strike the whole row through and add a one-line reason on the same line when
  it is not applicable (a struck row with no reason fails). Keep the checkbox
  OUTSIDE the strikethrough and the marker comment INSIDE it, then put the
  reason after the closing tildes:

      - [ ] ~~(marker comment) row text~~ — why it does not apply

  A row struck from its leading dash (`- ~~- [ ] …~~`) is not recognised, and
  the verifier then reports the row as missing from the template;
- a checked row needs matching files in the diff: `tests` matches a `test/` or
  `tests/` directory or a `*.test.*` / `*.spec.*` file (a shell harness such as
  `plugins/swiftbar/test.sh` does not count); `readme` matches only the
  top-level `README.md`; `docs` matches anything under `docs/`; `changelog`
  matches only `CHANGELOG.md`; `benchmarks` matches `benchmarks/`. When your
  evidence lives elsewhere, waive the row with a reason instead;
- do not leave marked rows blank;
- build the body from this template and pass it with `--body-file` (inside the
  worktree) or a quoted heredoc: an inline `--body` skips the template and
  fails the check.

The verifier also checks new source modules for test coverage and scans added
non-documentation lines for common committed-secret patterns. It does not judge
whether prose is semantically correct, so review the documentation contract in
CLAUDE.md as well.
-->

## Summary

Brief description of the change and which issue is fixed. Include relevant motivation and context.

Fixes # (issue)

## Testing

- [ ] <!-- kookr:check:npm-test --> `npm test` passes
- [ ] <!-- kookr:check:e2e-verified --> End-to-end verified for tool/transport changes (see `CLAUDE.md`)
- [ ] <!-- kookr:check:bench-run --> Benchmark run if performance-relevant: `BENCH_PROVIDER=stub npm run bench`
- [ ] <!-- kookr:check:tests --> Tests were added or updated for changed behavior; bug fixes include a regression test

## Documentation contract

- [ ] <!-- kookr:check:readme --> `README.md` reflects user-visible CLI, MCP, installation, or configuration changes
- [ ] <!-- kookr:check:docs --> Relevant operator, API, configuration, and retrieval documentation under `docs/` is consistent with the implementation
- [ ] <!-- kookr:check:mbse --> RFCs are updated when this PR implements, supersedes, or changes an accepted design

## Changelog

- [ ] <!-- kookr:check:changelog --> `CHANGELOG.md` has an `Unreleased` entry for user-visible changes

## Retrieval and performance evidence

- [ ] <!-- kookr:check:benchmarks --> Retrieval-quality or performance changes include the relevant benchmark/evaluation evidence, or this row is waived with a reason

## Follow-ups

List any obvious-but-out-of-scope findings that were spun off as separate issues (see `CLAUDE.md`).
