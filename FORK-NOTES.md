# Fork workflow notes

This fork (`gundestrup/knowledge-base-mcp-server`) tracks upstream
`jeanibarz/knowledge-base-mcp-server`. `main` carries a few fork-local
files that must never reach upstream — see `FORK-ONLY` for the list and
the reason for each entry.

## Contributing a change upstream

```bash
scripts/prepare-upstream-branch.sh <branch-name>   # strips FORK-ONLY paths
git push -u origin <branch-name>
gh pr create --repo jeanibarz/knowledge-base-mcp-server --head gundestrup:<branch-name> ...
```

The strip is a separate commit on the PR branch, so `main` keeps the
fork-local files. After upstream merges, delete the branch — it's a
one-way snapshot.

## Rules of thumb

- **Fork-local** = anything bound to this account or machine: SonarQube
  Cloud org/project/token, IDE bindings, this tooling itself.
- **Upstream-safe** = dependency bumps, CI hardening, bug fixes, tests —
  anything a maintainer could merge without owning your secrets.
- Adding a new private file? Append it to `FORK-ONLY` so the next PR
  branch strips it automatically.
- Sync after upstream merges: `git merge upstream/main`. Expect trivial
  conflicts in `package.json`/`package-lock.json` where both sides made
  the same edit — take either; they're identical.

## Currently excluded files

- `.vscode/` — SonarLint connected-mode binding (personal connection id)
- `sonar-project.properties`, `.github/workflows/sonar.yml` — SonarQube
  Cloud project + `SONAR_TOKEN` belong to this fork's account
- `FORK-ONLY`, `FORK-NOTES.md`, `scripts/prepare-upstream-branch.sh` —
  this machinery is internal
