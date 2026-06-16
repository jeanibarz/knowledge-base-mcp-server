# Contributing to Knowledge Base MCP Server

Thank you for your interest in contributing! Please read [`CLAUDE.md`](./CLAUDE.md) for the full agent-facing guide — it covers architecture, conventions, and verification steps.

## How to Contribute

1. Check open [RFCs](./docs/rfcs/) for in-flight design discussions.
2. Fork the repository and create a feature branch (`git checkout -b feat/amazing-feature`).
3. Make your changes, following the conventions below.
4. Ensure the local CI-parity gate passes: `npm run check`
5. If your change affects performance, run the benchmark harness: `BENCH_PROVIDER=stub npm run bench`
6. Commit using **conventional commits** — `feat:`, `fix(scope):`, `docs:`, `chore:` (see `git log` for prior style).
7. Push to the branch and open a Pull Request using the PR template.

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

Use `npm run check` before opening a PR; it runs the TypeScript build, full Jest suite, and documentation anchor verifier.

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
