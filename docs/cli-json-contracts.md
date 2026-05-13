# CLI JSON Output Contracts

This page records the stable JSON shapes for agent-facing `kb` commands. It is
for shell agents that branch on fields, not for humans reading examples.

Contract policy:

- Fields listed as stable are safe for agents to parse by name.
- Fields listed as optional are stable when present, but only appear for the
  named flag, mode, or failure class.
- Other fields in the same object should be treated as incidental unless this
  page names them.
- JSON payloads are written to stdout and end with one trailing newline unless a
  command section says otherwise. Human diagnostics, warnings, logger output,
  and argv/runtime errors generally go to stderr.

## `kb search`

Invocation:

```bash
kb search "<query>" --format=json [--kb=<name>] [--model=<id>] [--k=<int>]
kb search "<query>" --format=json --refresh [--kb=<name>]
kb search --stdin --format=json
kb search "<query>" --format=json --mode=dense|lexical|hybrid|auto
KB_EDITOR_URI=cursor kb search "<query>" --format=json
kb search "<query>" --format=vimgrep
```

Dense success envelope, including the default `--mode=dense`:

```json
{
  "results": [
    {
      "score": 0.42,
      "content": "chunk text",
      "metadata": {
        "source": "/abs/path/to/file.md",
        "relativePath": "kb/file.md",
        "knowledgeBase": "kb",
        "loc": { "lines": { "from": 10, "to": 12 } }
      },
      "chunk_id": "kb/file.md#L10-L12"
    }
  ],
  "index_mtime": "2026-05-03T15:33:56.964Z",
  "stale": false,
  "modified_files": 0,
  "new_files": 0,
  "global_stale": false,
  "global_modified_files": 0,
  "global_new_files": 0
}
```

Stable fields:

- `results`: array of retrieval hits. Each hit has stable `score`, `content`,
  and `metadata` keys. `score` is a number when known and `null` when absent.
- `results[].metadata`: sanitized chunk metadata. `source`, `relativePath`,
  `knowledgeBase`, `loc`, `chunkIndex`, `extension`, and lifted
  `frontmatter` fields are commonly present, but metadata keys depend on the
  ingested document and should be feature-detected.
- `index_mtime`: ISO timestamp string or `null`.
- `stale`, `modified_files`, `new_files`: staleness for the selected scope. If
  `--refresh` was used, these selected-scope counts are reported as fresh for
  that run.
- `global_stale`, `global_modified_files`, `global_new_files`: staleness across
  all KBs.

Optional stable fields:

- `scope`: present when `--kb=<name>` is used. Shape:
  `{"kb": string, "stale": boolean, "modified_files": number, "new_files": number}`.
- `grouped_results`: present with `--group-by-source` in dense JSON mode. Each
  source group has `source`, `chunk_count`, `best_score`, `locations`, and
  `chunks`. Each chunk follows the same hit contract as `results[]`, plus a
  stable `location` field.
- `results[].chunk_id` and `grouped_results[].chunks[].chunk_id`: stable chunk
  handle when enough metadata is available. Line-aware handles use
  `kb/path.md#L10-L12`; chunks without line metadata can use a `#chunk-N`
  suffix. The field is absent when a citation cannot be built.
- `results[].editor_uri` and `grouped_results[].chunks[].editor_uri`: present
  only when `KB_EDITOR_URI` is `vscode`, `cursor`, or `file` and the hit has
  enough source metadata. The default `KB_EDITOR_URI=none` omits local absolute
  paths.
- `auto_threshold`: present with `--threshold=auto`. Shape:
  `{"threshold": number, "knee_index": number|null, "kept": number}`.
- `timing`: present with `--timing`; keys are elapsed millisecond counters and
  mode labels. Treat the object as diagnostic, not a compatibility contract.

Refresh preflight:

- Dense and hybrid `kb search --refresh` compute a nonblocking stale-delta
  preflight before embedding starts when the selected scope exceeds either
  documented threshold: more than 100 changed/new files or more than 100 MiB of
  cheap-to-stat stale bytes.
- The preflight is always stderr text. JSON stdout remains the success envelope
  above, and agents must not expect a JSON field for the preflight.
- TTY and non-TTY runs continue without prompting by default; there is no
  confirmation gate or required `--yes` for `kb search --refresh`.
- The stderr text includes changed/new file counts by KB, estimated stale bytes,
  top KBs by stale bytes/files, the active provider/model, provider class
  (`local` or `paid`), `--kb=<name>` scoping suggestions, and PDF exclusion
  guidance when stale PDFs are present.
- `mode`, `requested_mode`, `auto_mode`: present when `--mode=auto` is used.
  `mode` is the selected effective mode; `auto_mode` has `mode` and `reason`.

Lexical success envelope:

```json
{
  "mode": "lexical",
  "results": [],
  "knowledge_bases": [
    {
      "kb": "notes",
      "files": 10,
      "chunks": 40,
      "refresh": {
        "added": 0,
        "updated": 0,
        "removed": 0,
        "failed": 0
      },
      "error": null
    }
  ]
}
```

Stable lexical fields are `mode`, `results`, and `knowledge_bases[]` with
`kb`, `files`, `chunks`, `refresh`, and `error`. The lexical path may write
per-KB warnings to stderr and can return exit code `1` when one or more KBs
failed while still printing this JSON payload.

Hybrid success envelope:

```json
{
  "mode": "hybrid",
  "results": [],
  "retrievers": {
    "dense": { "fetched": 0, "model": "ollama__nomic-embed-text-latest" },
    "lexical": { "fetched": 0, "refreshed": 0, "failed": 0 }
  },
  "rrf": { "c": 60, "fetch_k": 40 }
}
```

Stable hybrid fields are `mode`, `results`, `retrievers.dense.fetched`,
`retrievers.dense.model`, `retrievers.lexical.fetched`,
`retrievers.lexical.refreshed`, `retrievers.lexical.failed`, `rrf.c`, and
`rrf.fetch_k`.

Stable error envelope for dense and hybrid JSON mode:

```json
{
  "error": {
    "code": "KB_NOT_FOUND",
    "category": "configuration",
    "message": "unknown KB \"foo\"",
    "next_action": "Run `kb list` to see registered knowledge bases..."
  }
}
```

Stable error fields are `error.code`, `error.category`, `error.message`, and
`error.next_action`. For refresh lock contention, `error.lock_path`,
`error.resource`, and `error.retry_hint` are also stable; `retry_hint` is a
backward-compatible alias of `next_action`.

Stdout/stderr and exit codes:

- Success JSON is stdout with exit `0`.
- Dense and hybrid JSON-mode classified failures are stdout with exit `1` or
  `2`.
- Human-mode failures are stderr. Parser errors such as missing query or
  invalid flags are stderr and exit `2`.
- Lexical-mode setup and per-KB errors are stderr; lexical JSON does not use the
  unified `{"error": ...}` envelope for those paths.
- `--format=vimgrep` is not JSON. It writes quickfix-style
  `path:line:column:preview` lines to stdout, writes parser/runtime diagnostics
  to stderr, and uses the same search exit-code classes.

Source and test anchors: `src/cli-search.ts:262-320`,
`src/cli-search.ts:762-785`, `src/cli-search.ts:985-999`,
`src/formatter.ts:136-213`, `src/cli-search-errors.ts:181-215`,
`src/formatter.test.ts:133-185`, `src/cli-search-errors.test.ts:121-159`.

## `kb remember`

Invocation:

```bash
printf '%s\n' "note body" | kb remember --kb=<name> --title=<title> --stdin --yes
printf '%s\n' "append body" | kb remember --kb=<name> --append=<path> --stdin --yes
printf '%s\n' "lesson body" | kb remember --lesson --title=<title> --stdin --yes
```

Successful create, append, and append-section writes print JSON by default:

```json
{
  "knowledge_base_name": "project",
  "path": "daily-meeting-notes.md",
  "action": "create",
  "refreshed": false
}
```

Stable success fields:

- `knowledge_base_name`: target KB name.
- `path`: KB-relative path written.
- `action`: one of `create`, `append`, or `append-section`.
- `refreshed`: boolean matching whether `--refresh` was requested and completed.

Optional stable success fields:

- `lesson`: `true` for `--lesson` writes.
- `write_performed`: `true` for successful `--lesson` writes.
- `similarity_check`: present when the semantic preflight ran successfully.
  Stable child fields are `performed`, `candidates_found`, and, for forced
  overrides, `overridden_with_force` and `candidates`.
- `similarity_check.candidates[]`: each candidate has `knowledge_base`,
  `relative_path`, `score`, `chunk`, and `suggested_invocation`.

Stable similarity-guard refusal envelope:

```json
{
  "action": "similarity-check",
  "write_performed": false,
  "decision_hint": {
    "summary": "Similar KB chunks were found before writing.",
    "recommended_agent_actions": []
  },
  "candidates": [
    {
      "knowledge_base": "project",
      "relative_path": "notes.md",
      "score": 0.42,
      "chunk": "matching excerpt",
      "suggested_invocation": "kb remember --kb=project --append=notes.md --stdin --yes"
    }
  ]
}
```

Stable lesson-validation envelope:

```json
{
  "action": "lesson-validation",
  "write_performed": false,
  "lesson": true,
  "knowledge_base_name": "agent-task-lessons",
  "empty_input": true,
  "missing_sections": ["Mistake", "Why it happened", "Better next time"],
  "found_sections": [],
  "skeleton": "## Mistake\n\n...",
  "decision_hint": {
    "summary": "Lesson body is empty...",
    "recommended_agent_actions": []
  }
}
```

Stdout/stderr and exit codes:

- Successful writes print JSON to stdout and exit `0`.
- Similarity-guard refusals print JSON to stdout and exit `3`.
- Lesson validation failures print JSON to stdout by default and exit `2`.
- Argument errors and write/runtime errors print `kb remember: ...` to stderr.
  Argument errors exit `2`; runtime/write errors exit `1`.
- If the default-on similarity guard cannot run, the command can warn on stderr
  and still perform the write. The success JSON remains on stdout.
- `kb remember --suggest` is a human-readable text surface today; do not treat
  it as a JSON contract even if `--format=json` is accepted by the parser.

Source and test anchors: `src/cli-remember.ts:381-400`,
`src/cli-remember.ts:468-491`, `src/cli-remember.ts:544-550`,
`src/cli-remember-similarity.ts:81-93`, `src/cli-remember.test.ts:60-79`,
`src/cli.test.ts:204-272`, `src/cli.test.ts:822-941`.

## `kb capture`

Invocation:

```bash
kb capture --kb=<name> --append=<path> [--allow-fail] [--max-bytes=<N>] -- <cmd> [args...]
```

Successful captures always print JSON:

```json
{
  "knowledge_base_name": "project",
  "path": "snapshots.md",
  "action": "capture",
  "truncated": false,
  "bytes_elided": 0,
  "exit_code": 0,
  "refreshed": false
}
```

Stable success fields:

- `knowledge_base_name`: target KB name.
- `path`: KB-relative file path appended.
- `action`: always `capture`.
- `truncated`: whether stdout exceeded `--max-bytes`.
- `bytes_elided`: number of bytes omitted when truncated, otherwise `0`.
- `exit_code`: captured command exit code. This can be non-zero only when
  `--allow-fail` is used.
- `refreshed`: boolean matching whether `--refresh` was requested and completed.

Stdout/stderr and exit codes:

- Success JSON is stdout with exit `0`.
- There is no stable JSON error envelope. Argument, spawn, command-failure,
  empty-output, path, write, and refresh errors print `kb capture: ...` to
  stderr.
- Argument errors exit `2`; runtime/write/command errors exit `1`.
- The captured child command inherits stderr, so child stderr is not part of the
  JSON contract and can appear beside `kb capture` diagnostics.

Source and test anchors: `src/cli-capture.ts:204-213`,
`src/cli-capture.ts:89-125`, `src/cli.test.ts:1063-1247`.

## `kb where`

Invocation:

```bash
kb where --topic="<query>" --format=json [--threshold=<float>] [--k=<int>] [--model=<id>]
```

Recommendation envelope:

```json
{
  "recommended_kb": "project",
  "existing_target": "notes/status.md",
  "confidence": 0.4,
  "suggested_invocation": "kb remember --kb=project --append=notes/status.md --stdin --yes"
}
```

No-match envelope:

```json
{
  "recommended_kb": null,
  "results": []
}
```

Stable fields:

- `recommended_kb`: KB name, or `null` when no usable recommendation exists.
- `existing_target`: KB-relative path when the best file is under the confidence
  threshold, otherwise `null`.
- `confidence`: FAISS distance used for the decision. Lower is closer.
- `suggested_invocation`: copyable `kb remember` command for append or create.
- In the no-match envelope, `results: []` is stable.

Stdout/stderr and exit codes:

- JSON recommendations and no-match envelopes are stdout with exit `0`.
- There is no stable JSON error envelope. Argument/config/runtime errors print
  `kb where: ...` to stderr.
- Argument and active-model resolution errors exit `2`; runtime/index/search
  errors exit `1`.

Source and test anchors: `src/cli-where.ts:139-157`,
`src/cli-where.ts:290-297`, `src/cli-where.test.ts:16-57`,
`src/cli-where.test.ts:60-127`.

## `kb doctor`

Invocation:

```bash
kb doctor --format=json
```

Report envelope:

```json
{
  "status": "ok",
  "checks": [
    { "name": "active_model", "status": "ok", "detail": "ollama__nomic-embed-text-latest" }
  ],
  "active_model": {
    "model_id": "ollama__nomic-embed-text-latest",
    "provider": "ollama",
    "model_name": "nomic-embed-text:latest"
  },
  "index": {
    "path": "/path/to/.faiss",
    "binary_path": "/path/to/.faiss/models/.../index.v3/faiss.index",
    "version": "index.v3",
    "mtime": "2026-05-03T15:33:56.964Z"
  },
  "stale_counts_by_kb": {
    "project": { "modified_files": 0, "new_files": 0 }
  },
  "backend": {
    "provider": "ollama",
    "healthy": true,
    "detail": "Ollama http://localhost:11434 is reachable..."
  },
  "cli": {
    "version": "0.2.2",
    "package_root": "/path/to/package",
    "invoked_path": "/path/to/kb",
    "symlinked_checkout_path": "/path/to/checkout"
  },
  "git": {
    "branch": "main",
    "head": "abc123",
    "origin_main": "def456",
    "relation": "behind"
  },
  "last_index_update": {
    "status": "never_run"
  }
}
```

Stable fields:

- `status`: `ok`, `warn`, or `error`.
- `checks[]`: each check has `name`, `status`, and `detail`.
- `active_model`: `model_id`, `provider`, and `model_name`, each string or
  `null`.
- `index`: `path`, `binary_path`, `version`, and `mtime`.
- `stale_counts_by_kb`: object keyed by KB name with `modified_files` and
  `new_files`.
- `backend`: `provider`, `healthy`, and `detail`.
- `cli`: `version`, `package_root`, `invoked_path`, and
  `symlinked_checkout_path`.
- `git`: either `null` or an object with `branch`, `head`, `origin_main`, and
  `relation`.
- `last_index_update`: the latest update summary. Fresh processes use the
  compact persisted summary for the active model when no update has run in the
  current process. The object shape is shared with stats/manager observability;
  agents should branch first on `last_index_update.status`.

Stdout/stderr and exit codes:

- JSON reports are stdout. The command exits `0` when `status` is `ok` or
  `warn`, and exits `1` when `status` is `error`.
- There is no separate JSON error envelope; failing health checks are encoded in
  the report with `status: "error"`.
- Argument errors print `kb doctor: ...` to stderr and exit `2`.

Source and test anchors: `src/cli-doctor.ts:66-99`,
`src/cli-doctor.ts:114-130`, `src/cli-doctor.ts:149-237`,
`src/cli-doctor.test.ts:39-180`.

## `kb eval`

Invocation:

```bash
kb eval <fixture.yml|json> --format=json [--model=<id>] [--k=<int>] [--threshold=<float>]
```

Report envelope:

```json
{
  "total": 1,
  "passed": 1,
  "failed": 0,
  "gate_failed": 0,
  "cases": [
    {
      "name": "deployment runbook",
      "query": "rollback procedure",
      "kb": "work",
      "gate": true,
      "passed": true,
      "failures": [],
      "warnings": [],
      "result_count": 3,
      "duplicate_groups": 0
    }
  ]
}
```

Stable fields:

- Top-level `total`, `passed`, `failed`, `gate_failed`, and `cases`.
- `cases[]`: `name`, `query`, optional `kb`, `gate`, `passed`, `failures`,
  `warnings`, `result_count`, and `duplicate_groups`.

Stdout/stderr and exit codes:

- JSON reports are stdout.
- Exit `0` means no gated case failed. Ungated failures are reported in JSON as
  warnings/failures but still exit `0`.
- Exit `1` means at least one gated case failed, or a runtime/index/search error
  occurred before a report could be produced.
- Exit `2` covers argv and fixture loading/normalization errors.
- There is no stable JSON error envelope. Errors before report construction
  print `kb eval: ...` to stderr.

Source and test anchors: `src/cli-eval.ts:136-142`,
`src/cli-eval.ts:198-216`, `src/retrieval-eval.ts:45-63`,
`src/retrieval-eval.ts:140-153`, `src/retrieval-eval.test.ts:38-74`,
`src/retrieval-eval.test.ts:140-156`.

## `kb list`

Invocation:

```bash
kb list --format=json
kb list --describe --format=json
```

Name-only envelope:

```json
[
  { "name": "project" }
]
```

Describe envelope:

```json
[
  { "name": "project", "description": "Project notes" }
]
```

Stable fields:

- Top-level array of KB entries.
- Each entry has `name`.
- `description` is present only with `--describe` or `-v`; it is a string and
  may be empty.

Stdout/stderr and exit codes:

- JSON lists are stdout with exit `0`.
- There is no stable JSON error envelope. Argument errors and filesystem errors
  print `kb list: ...` to stderr.
- Argument errors exit `2`; filesystem/runtime errors exit `1`.

Source and test anchors: `src/cli-list.ts:53-101`,
`src/cli.test.ts:1328-1385`.

## `kb models list`

Invocation:

```bash
kb models list
```

Current contract:

- `kb models list` has no JSON output mode in the current CLI.
- Its stable agent-facing behavior is text on stdout with exit `0`: either a
  no-models message, or one row per registered model with an active `*` marker
  and optional `[downgrade-hazard]` suffix.
- Errors from the `models` command family print `kb models: ...` or
  `kb models <verb>: ...` to stderr and use exit `1` for runtime/layout errors
  and `2` for argv/configuration errors.

Agents that need a machine-readable model inventory should not parse
`kb models list` text as JSON. Use this section as a negative contract until a
future CLI adds `--format=json`.

Source and test anchors: `src/cli-models.ts:20-64`,
`src/cli-models.ts:88-117`, `src/active-model.ts:129-166`,
`src/cli.test.ts:1463-1505`.
