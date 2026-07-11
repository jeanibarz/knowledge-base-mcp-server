<!--
Work every checklist row carrying a `kookr:check:*` marker. The PR checklist
workflow verifies these rows against the merge-base diff with Kookr's pinned,
deterministic verifier:

- check a row when you performed it;
- strike the whole row through and add a one-line reason when it is not applicable;
- do not leave marked rows blank.

The verifier also checks new source modules for test coverage and scans added
non-documentation lines for common committed-secret patterns. It does not judge
whether prose is semantically correct, so review the documentation contract in
CLAUDE.md as well.
-->

## Summary

Brief description of the change and which issue is fixed. Include relevant motivation and context.

Fixes # (issue)

## Testing

- [ ] `npm test` passes
- [ ] End-to-end verified for tool/transport changes (see `CLAUDE.md`)
- [ ] Benchmark run if performance-relevant: `BENCH_PROVIDER=stub npm run bench`
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
