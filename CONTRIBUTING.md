# Contributing to Knowledge Base MCP Server

Thank you for your interest in contributing! Please read [`CLAUDE.md`](./CLAUDE.md) for the full agent-facing guide — it covers architecture, conventions, and verification steps.

## How to Contribute

1. Check open [RFCs](./docs/rfcs/) for in-flight design discussions.
2. Fork the repository and create a feature branch (`git checkout -b feat/amazing-feature`).
3. Make your changes, following the conventions below.
4. Ensure the local CI-parity gate passes: `npm run check` (which now also runs `npm run lint`)
5. If your change affects performance, run the benchmark harness: `BENCH_PROVIDER=stub npm run bench`
6. Commit using **conventional commits** — `feat:`, `fix(scope):`, `docs:`, `chore:` (see `git log` for prior style). PR titles are checked with `npm run lint:commit-message` because squash merges use the PR title as the final commit message.
7. Push to the branch and open a Pull Request using the PR template.

The marked rows in the PR template are verified against the actual diff by the
`PR checklist` workflow. Check a marked row only when it is true; otherwise
strike the row through and add a one-line reason. A blank marked row fails CI.

**Preflight the checklist locally before you open the PR.** The most common
first-attempt CI failure is a PR body that was not built from
[`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md), so the
`kookr:check:*` rows are absent. Draft your body into a file, then run the same
verifier CI runs against it:

```sh
npm run pr-checklist -- pr-body.md          # verifies against origin/main
gh pr create --body-file pr-body.md         # only after it passes
```

This catches a wrong-shape body in seconds instead of after a full CI cycle. CI
remains authoritative; the preflight is a convenience that shells out to the
Kookr CLI (set `KOOKR_BIN` if it is not on your `PATH`).

## Reporting Bugs

Please use the [Bug Report issue template](./.github/ISSUE_TEMPLATE/bug_report.yml) and include:

- What you observed
- Where it occurs (`file.ts:line` or URL)
- Why it matters
- A suggested fix if obvious

## Requesting Features

Please use the [Feature Request issue template](./.github/ISSUE_TEMPLATE/feature_request.yml).

## Code Style

- Follow existing TypeScript patterns (`tsconfig.json` strict mode).
- Add tests for new features.
- Update documentation as needed.

## Local Test Iteration

Use `npm run check` before opening a PR; it runs the TypeScript build, ESLint, the full Jest suite, and documentation/configuration consistency checks (including generated `.env.example` drift).

For local configuration, copy [`.env.example`](./.env.example) to `.env`. The template is generated from `CONFIG_SCHEMA`; after changing the schema, run `npm run docs:generate-env-example` and commit the result.

## Local Git Hooks

`npm run dev:setup` points git at the tracked [`.githooks/`](./.githooks/) directory (`git config core.hooksPath .githooks`). Two lifecycle hooks then run automatically:

- **`post-merge` / `post-rewrite`** rebuild the linked `kb` bins after every `git pull` / `git merge` / `git pull --rebase`.
- **`pre-push`** runs the fast CI-parity subset — `npm run check:fast` (ESLint plus the generated-doc drift gates) — before a push reaches CI. This catches the two most common red-build causes (lint violations and stale reference docs) in seconds locally, instead of after a full CI round-trip. It deliberately skips the slow `test:coverage` step, so CI remains the source of truth for the full test suite.

`check:fast` is `npm run check` minus the slow `test:coverage` step (the leading `tsc` build is incremental, so it is quick); you can run it directly (`npm run check:fast`) any time. The hook is **opt-in** — it only fires once `dev:setup` has pointed `core.hooksPath` at `.githooks/`, so contributors who never ran setup are unaffected. Bypass it for emergencies with `git push --no-verify`.

## Linting

Use `npm run lint` (`eslint src`) to run the type-aware ESLint gate, or `npm run lint:fix` to apply autofixes. It is also wired into `npm run check` and the CI Tests workflow, so a clean `npm run lint` is required before a PR is mergeable.

The flat config lives in [`eslint.config.js`](./eslint.config.js). It seeds typescript-eslint's `recommendedTypeChecked` ruleset (scoped to `src/`, excluding tests) with the currently-failing rules disabled so the gate is green today. Those disabled rules are documented ratchet targets — follow-up PRs should fix the violations and re-enable rules one at a time.

Use `npm test` for the local CI-parity test gate. It builds the TypeScript output first, then runs the Jest `parallel` project with four workers followed by the Jest `serial` project in-band. The scripts clear `LOG_FILE` so ambient local logging does not redirect canonical stderr assertions into a personal log file.

Use the project scripts when you need a narrower runner check:

- `npm run test:parallel` runs the parallel-safe Jest project with `--maxWorkers=4`.
- `npm run test:serial` runs the explicit serial Jest project with `--runInBand`.

For focused local work:

- `npm run test:file -- src/cli-search.test.ts` runs one or more explicit test files with Jest's `--runTestsByPath` filter.
- `npm run test:watch -- src/cli-search.test.ts` starts Jest watch mode while accepting the same Jest path or name filters you would pass manually.

Treat watch mode as local-only. It expects an interactive terminal and should not be used in automation.

## Incremental Builds

`tsc` runs with `incremental: true`, persisting compile state to `build/.tsbuildinfo` (and `build/benchmarks/.tsbuildinfo` for the bench config). Unchanged files are skipped, so the second `npm run build` after a small edit is much faster than the cold build. The `.tsbuildinfo` files live under the git-ignored `build/` directory and are never committed; CI always runs from a clean checkout, so it gets a correct cold build.

If a branch switch or other change leaves stale build state, reset it with the clean escape hatch:

- `npm run build:clean` — removes the `build/` directory (including `.tsbuildinfo`).
- Equivalently, `rm -rf build` or `tsc --build --clean`.

The next `npm run build` then rebuilds from scratch.

## Spinning Off Follow-Up Issues

If you notice an obvious-but-out-of-scope bug or improvement while working, do not silently absorb it into the current PR. Open a tracking issue with the **What / Where (file:line) / Why / Suggested fix** format and link it in the PR's **Follow-ups** section.

## Questions?

Feel free to open a discussion or issue.
