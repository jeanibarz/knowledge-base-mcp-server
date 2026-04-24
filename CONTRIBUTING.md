# Contributing to Knowledge Base MCP Server

Thank you for your interest in contributing! Please read [`CLAUDE.md`](./CLAUDE.md) for the full agent-facing guide — it covers architecture, conventions, and verification steps.

## How to Contribute

1. Check open [RFCs](./docs/rfcs/) for in-flight design discussions.
2. Fork the repository and create a feature branch (`git checkout -b feat/amazing-feature`).
3. Make your changes, following the conventions below.
4. Ensure tests pass: `npm test`
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
- Update `CHANGELOG.md` under `## [Unreleased]` for any user-visible change.
- Update documentation as needed.

## Spinning Off Follow-Up Issues

If you notice an obvious-but-out-of-scope bug or improvement while working, do not silently absorb it into the current PR. Open a tracking issue with the **What / Where (file:line) / Why / Suggested fix** format and link it in the PR's **Follow-ups** section.

## Questions?

Feel free to open a discussion or issue.
