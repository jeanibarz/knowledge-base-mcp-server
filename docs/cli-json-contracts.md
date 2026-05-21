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

## `kb help`

Invocation:

```bash
kb help --format=json
kb help <command> --format=json
```

Top-level success envelope:

```json
{
  "schema_version": "kb.help.v1",
  "command": "kb",
  "usage": ["kb <command> [options]"],
  "commands": [
    {
      "name": "search",
      "summary": "Semantic search across one or all knowledge bases.",
      "usage": ["kb search <query> [options]"],
      "options": [
        {
          "flags": ["--format"],
          "value": "md|json|vimgrep",
          "description": "Output format."
        }
      ],
      "stability": "stable"
    }
  ],
  "environment": [
    {
      "name": "KNOWLEDGE_BASES_ROOT_DIR",
      "description": "Root directory containing one folder per KB."
    }
  ],
  "exit_codes": [
    { "code": 0, "description": "success (results found or empty)" }
  ],
  "stability": "stable"
}
```

Command-specific success envelope:

```json
{
  "schema_version": "kb.help.v1",
  "command": {
    "name": "search",
    "summary": "Semantic search across one or all knowledge bases.",
    "usage": ["kb search <query> [options]"],
    "options": [],
    "stability": "stable"
  }
}
```

Stable fields:

- `schema_version`: currently `kb.help.v1`.
- Top-level `command`: literal `kb`.
- Top-level `usage`: array of usage lines from the top-level help block.
- Top-level `commands`: one object per registered command, in CLI help order.
- Command `name`, `summary`, `usage`, `options`, and `stability`.
- Option `flags`: array of flag names without value placeholders, such as
  `--format` and `-h`.
- Option `value`: string value placeholder when the help text declares one,
  otherwise `null`.
- Option `description`: prose description from the command help.
- Top-level `environment` and `exit_codes`: metadata from the top-level help
  block.
- `stability`: currently `stable`; consumers should feature-detect fields and
  check `schema_version` before assuming compatibility.

Stdout/stderr and exit codes:

- Success JSON is stdout with exit `0`.
- Unknown command handling matches prose help: stderr diagnostic, empty stdout,
  exit `2`.
- `kb help` without `--format=json` keeps the existing human-readable output.

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
- `results[].rerank_score`: present for hits that were re-scored by the RFC 019
  reranker. It is a cross-encoder relevance score, not a FAISS distance or RRF
  score.
- `auto_threshold`: present with `--threshold=auto`. Shape:
  `{"threshold": number, "knee_index": number|null, "kept": number}`.
- `timing`: present with `--timing`; keys are elapsed millisecond counters and
  mode labels. Treat the object as diagnostic, not a compatibility contract.
  For dense and hybrid `--refresh` runs, the same diagnostic object may include
  refresh counters such as `refresh_embed_batches`,
  `refresh_embed_batches_total`, `refresh_embed_chunks`,
  `refresh_embed_chunks_total`, `refresh_embed_ms`, `refresh_save_ms`,
  `refresh_sidecar_ms`, and `refresh_manifest_ms`.

Refresh preflight:

- Dense and hybrid `kb search --refresh` compute a nonblocking stale-delta
  preflight before embedding starts when the selected scope exceeds either
  documented threshold: more than 100 changed/new files or more than 100 MiB of
  cheap-to-stat stale bytes.
- The preflight is always stderr text. JSON stdout remains the success envelope
  above, and agents must not expect a JSON field for the preflight.
- Refresh progress heartbeats are also stderr text. Embedding heartbeats include
  the current bounded batch, embedded chunk count, provider/model, elapsed time,
  and rolling throughput when available; save, sidecar, and manifest phases
  emit start/completion lines. These lines never appear in JSON stdout.
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
  "rrf": { "c": 60, "fetch_k": 40 },
  "rerank": {
    "enabled": false,
    "model": "Xenova/ms-marco-MiniLM-L-6-v2",
    "candidates": 0,
    "cache_hits": 0,
    "degraded": false,
    "degrade_reason": null
  }
}
```

Stable hybrid fields are `mode`, `results`, `retrievers.dense.fetched`,
`retrievers.dense.model`, `retrievers.lexical.fetched`,
`retrievers.lexical.refreshed`, `retrievers.lexical.failed`, `rrf.c`, and
`rrf.fetch_k`. `rerank.enabled`, `rerank.model`, `rerank.candidates`,
`rerank.cache_hits`, `rerank.degraded`, and `rerank.degrade_reason` are stable
when the `rerank` object is present.

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

## `kb research`

Invocation:

```bash
kb research plan "<question>" --format=json
kb research collect "<question>" --run-dir <path> --format=json
kb research plan "<question>" --include-kb=<name> --exclude-kb=<name> --max-shelves=<n>
```

`kb research` is read-only. `plan` reads KB descriptions and stats, then
deterministically selects shelves and queries. `collect` writes a local run
directory and retrieves evidence using existing hybrid search.

Planner controls are deterministic and do not trigger any model calls:
`--kb=<name>` / `--include-kb=<name>` pins a shelf into the plan,
`--exclude-kb=<name>` removes a shelf from consideration, and
`--max-shelves=<n>` limits automatic shelf selection. The planner treats broad
tokens such as `agent` as insufficient on their own, so domain shelves with
specific matches rank ahead of operational shelves that only share generic
wording.

Plan success envelope:

```json
{
  "schema_version": "kb-research-plan.v1",
  "question": "research question",
  "selected_shelves": [
    {
      "name": "llm-agents",
      "description": "Autonomous LLM agents",
      "file_count": 4,
      "chunk_count": 12,
      "score": 6,
      "reasons": ["1 shelf-name token match", "shelf has indexed-source files"],
      "risks": []
    }
  ],
  "queries": [
    {
      "id": "q1",
      "text": "research question",
      "purpose": "original research question",
      "shelves": ["llm-agents"]
    }
  ],
  "retrieval": { "mode": "hybrid", "k": 5 },
  "risks": []
}
```

Stable plan fields are `schema_version`, `question`, `selected_shelves`,
`queries`, `retrieval`, and `risks`. `retrieval.mode` is currently `hybrid`.
`selected_shelves[].risks` and top-level `risks` include
`dense_index_empty_coverage` when a selected shelf has files but zero dense
chunks; collection still uses hybrid search in that case.

Collect summary success envelope:

```json
{
  "schema_version": "kb-research-collect-summary.v1",
  "question": "research question",
  "run_dir": "/abs/path/to/run",
  "status": "complete",
  "artifact_paths": {
    "run": "/abs/path/to/run/run.json",
    "plan": "/abs/path/to/run/plan.json",
    "ledger": "/abs/path/to/run/ledger.json",
    "evidence_packet": "/abs/path/to/run/evidence_packet.md",
    "events": "/abs/path/to/run/events.jsonl"
  },
  "evidence_count": 3,
  "risk_count": 0,
  "search_failure_count": 0
}
```

Stable collect summary fields are `schema_version`, `question`, `run_dir`,
`status`, `artifact_paths`, `evidence_count`, `risk_count`, and
`search_failure_count`. `status` is `complete` when all hybrid searches
complete without delegated search failures, and `failed` when at least one
search failed.

Collect artifacts:

- `run.json`: run metadata with `schema_version`, `question`, `command`,
  `run_dir`, `started_at`, `finished_at`, `status`, and `artifact_paths`.
- `plan.json`: the same `kb-research-plan.v1` shape emitted by `plan`.
- `ledger.json`: `kb-research-ledger.v1` with `question`, `retrieval_mode`,
  `entries`, `risks`, and `search_failures`.
- `evidence_packet.md`: markdown packet with Question, Selected Shelves,
  Queries, Evidence Found, Evidence Gaps, and Sources sections. Evidence Found
  is grouped by source file so repeated passages from the same source are
  easier to scan.
- `events.jsonl`: structured event stream for collection progress.

Ledger entries have stable `source_id`, `shelf`, `relative_path`,
`line_range`, `query`, `retrieval_mode`, `score`, `excerpt`, `source_kind`,
`source_generation`, and `risk_flags` fields. `line_range`,
`relative_path`, `source_kind`, and `source_generation` can be `null` when the
underlying search metadata does not provide enough information.

Stdout/stderr and exit codes:

- `plan --format=json` writes the plan JSON to stdout and exits `0`.
- `collect --format=json` writes the summary JSON to stdout after artifacts are
  written. It exits `0` for `status=complete` and `1` for `status=failed`.
- Parser errors are stderr and exit `2`.
- Runtime errors before artifact completion are stderr and exit `1`.

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
kb capture --kb=<name> --append=<path> [--allow-fail] [--max-bytes=<N>] [--no-redact] -- <cmd> [args...]
```

Captured stdout and the displayed `$ <cmd>` line are redacted by default before
they are appended. Common credential surfaces include bearer/basic
Authorization headers, cookie headers, dotenv-style secret variables,
credential-bearing URLs, JSON secret fields, and common provider token shapes.
Pass `--no-redact` only when raw output must be preserved.

Successful captures always print JSON:

```json
{
  "knowledge_base_name": "project",
  "path": "snapshots.md",
  "action": "capture",
  "truncated": false,
  "bytes_elided": 0,
  "exit_code": 0,
  "refreshed": false,
  "redaction_summary": {
    "enabled": true,
    "total": 0,
    "by_type": {}
  }
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
- `redaction_summary`: object describing persisted-content redaction.
  `enabled` is `false` only when `--no-redact` is passed; `total` is the number
  of replacements applied across captured stdout and the displayed command
  line; `by_type` counts replacements by stable detector name. Stable detector
  names are `credential_url`, `authorization_header`, `cookie_header`,
  `json_secret`, `dotenv_secret`, `key_value_secret`, `bearer_token`, and
  `provider_token`.

Stdout/stderr and exit codes:

- Success JSON is stdout with exit `0`.
- There is no stable JSON error envelope. Argument, spawn, command-failure,
  empty-output, path, write, and refresh errors print `kb capture: ...` to
  stderr.
- Argument errors exit `2`; runtime/write/command errors exit `1`.
- The captured child command inherits stderr, so child stderr is not part of the
  JSON contract and can appear beside `kb capture` diagnostics.

Source and test anchors: `src/cli-capture.ts`, `src/cli.test.ts`.

## `kb import-url`

Invocation:

```bash
kb import-url --kb=<name> <url> [--note=<path.md>] [--title=<text>] \
  [--max-bytes=<N>] [--timeout=<ms>] [--max-redirects=<N>] \
  [--allow-local-network] [--refresh]
```

A successful import always prints JSON:

```json
{
  "knowledge_base_name": "research",
  "path": "example-domain.md",
  "action": "import-url",
  "source_url": "https://example.com/",
  "final_url": "https://example.com/",
  "http_status": 200,
  "content_type": "text/html",
  "content_sha256": "fb91d75a6bb430787a61b0aec5e374f580030f2878e1613eab5ca6310f7bbb9a",
  "byte_count": 528,
  "refreshed": false
}
```

Stable success fields:

- `knowledge_base_name`: target KB name.
- `path`: KB-relative path of the newly written note.
- `action`: always `import-url`.
- `source_url`: the URL requested on the command line.
- `final_url`: the URL that served the content after any redirects.
- `http_status`: terminal HTTP status (always `2xx` on success).
- `content_type`: response content type, parameters stripped.
- `content_sha256`: SHA-256 of the downloaded response body.
- `byte_count`: size of the downloaded response body in bytes.
- `refreshed`: boolean matching whether `--refresh` was requested and completed.

The written note carries a YAML frontmatter provenance block — `title`,
`source_url`, optional `resolved_url` (only when it differs from `source_url`),
`fetched_at`, `content_sha256`, `content_type`, `http_status`, `byte_count` —
followed by the extracted plain text.

Stdout/stderr and exit codes:

- Success JSON is stdout with exit `0`.
- There is no stable JSON error envelope. Argument, fetch (scheme / SSRF /
  redirect / size / timeout), extraction, write, and refresh errors print
  `kb import-url: ...` to stderr.
- Argument errors exit `2`; runtime/fetch/write errors exit `1`.
- Private, loopback, and link-local addresses are refused by default; pass
  `--allow-local-network` to permit them.

Source and test anchors: `src/cli-import-url.ts:283-299`,
`src/url-snapshot.ts:175-205`, `src/url-snapshot.ts:395-470`,
`src/cli-import-url.test.ts:132-330`.

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
kb doctor --endpoints --format=json
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
  "reranker": {
    "enabled": false,
    "model": "Xenova/ms-marco-MiniLM-L-6-v2",
    "top_n": 40,
    "status": "ok",
    "cache_path": null,
    "detail": "KB_RERANK is off"
  },
  "llm_endpoint": {
    "status": "ok",
    "endpoint": "http://127.0.0.1:8080/v1/chat/completions",
    "health_url": "http://127.0.0.1:8080/health",
    "endpoint_source": "profile",
    "profile_name": "local-research-agent",
    "profile_mode": "external",
    "managed_by": "local-research-agent",
    "unit_name": null,
    "health_ok": true,
    "chat_ok": true,
    "detail": "ready; profile=local-research-agent; source=profile; ...",
    "next_action": null
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
- `reranker`: RFC 019 reranker readiness. Stable fields are `enabled`,
  `model`, `top_n`, `status`, `cache_path`, and `detail`; `cache_path` is
  `null` when no local Transformers.js cache candidate is known.
- `llm_endpoint`: local LLM readiness for `kb ask`. `status` is `ok` or
  `warn`; failed LLM readiness is a warning because search health can still be
  usable. `endpoint_source` is `env`, `profile`, `default`, or `unresolved`.
  `profile_name`, `profile_mode`, `managed_by`, and `unit_name` describe the
  resolved profile/ownership when known. `health_ok` checks the derived
  `/health` URL and `chat_ok` checks an OpenAI-compatible chat completion.
  `next_action` is `null` when ready, otherwise a human-readable repair hint.
- `cli`: `version`, `package_root`, `invoked_path`, and
  `symlinked_checkout_path`.
- `git`: either `null` or an object with `branch`, `head`, `origin_main`, and
  `relation`.
- `last_index_update`: the latest update summary. Fresh processes use the
  compact persisted summary for the active model when no update has run in the
  current process. The object shape is shared with stats/manager observability;
  agents should branch first on `last_index_update.status`.
  When `KB_REFRESH_QUIESCE_MS` is non-zero, recently modified files or files
  that change during the refresh scan are deferred and reported additively via
  `warning_count` and `warnings[]`. Warning entries contain `relative_path`,
  stable `code`, `message`, and may include numeric `mtime_age_ms` and
  `quiesce_ms`. Stable codes are `KB_REFRESH_NOT_QUIESCENT` and
  `KB_REFRESH_FILE_CHANGED_DURING_SCAN`.

Stdout/stderr and exit codes:

- JSON reports are stdout. The command exits `0` when `status` is `ok` or
  `warn`, and exits `1` when `status` is `error`.
- There is no separate JSON error envelope; failing health checks are encoded in
  the report with `status: "error"`.
- Argument errors print `kb doctor: ...` to stderr and exit `2`.

`kb doctor --endpoints --format=json` emits the focused endpoint-readiness
schema instead of the full report:

```json
{
  "schema_version": "kb.doctor.endpoints.v1",
  "status": "ok",
  "endpoints": [
    {
      "name": "mcp_bind",
      "kind": "bind",
      "status": "ok",
      "configured": true,
      "target": "127.0.0.1:8765",
      "source": "env",
      "detail": "bind target is available"
    }
  ]
}
```

Endpoint rows use `status: "ok" | "warn" | "error" | "skipped"`. The current
row names are `mcp_bind`, `kb_daemon`, `embedding_ollama`, and
`llm_endpoint`. Skipped rows mean the relevant endpoint is not configured in
the current process environment/profile state. The command exits `1` only when
the focused endpoint report has overall `status: "error"`.

Source and test anchors: `src/cli-doctor.ts:92-146`,
`src/cli-doctor.ts:347-418`, `src/cli-doctor.ts:421-743`,
`src/cli-doctor.ts:1365-1452`, `src/cli-doctor.test.ts:923-1120`,
`src/cli-json-contracts.test.ts:215-237`.

## `kb logs`

Invocation:

```bash
kb logs recent --format=json [--limit=<n>] [--file=<path>]
kb logs show --request-id=<id> --format=json [--file=<path>]
kb logs show --query-sha=<hash> --format=json [--file=<path>]
```

Report envelope:

```json
{
  "schema_version": "kb.logs.v1",
  "action": "show",
  "source": "/tmp/kb.log",
  "filters": { "request_id": "req-1" },
  "scanned_line_count": 10,
  "canonical_event_count": 3,
  "ignored_line_count": 6,
  "malformed_canonical_line_count": 1,
  "result_count": 1,
  "events": [
    {
      "ts": "2026-05-18T20:00:00.000Z",
      "request_id": "req-1",
      "process": "cli",
      "cmd": "kb search",
      "query_sha256": "0123456789abcdef",
      "took_ms": 42,
      "timings": { "embed_ms": 10, "faiss_ms": 20, "format_ms": 3 },
      "cache": "miss",
      "result_count": 3,
      "top_sources": ["docs/a.md"],
      "error": { "code": "PROVIDER_TIMEOUT", "category": "provider" },
      "recovery_hint": "Run `kb doctor`."
    }
  ]
}
```

Stable fields:

- `schema_version` is `kb.logs.v1`.
- `action` is `recent` or `show`.
- `source` is the resolved log file path. Resolution uses `--file`, then
  `LOG_FILE`, then existing local default paths.
- Counts report the scan outcome before filtering.
- `events[]` contains summaries of `kb-canonical.v1` lines only. Text log
  lines are ignored. Each event includes `timings`; optional fields are
  present only when the canonical log line carried them.

Stdout/stderr and exit codes:

- JSON reports are stdout. No matches still exit `0` with `result_count: 0`.
- If no log file is discoverable, JSON output uses an error envelope with
  `schema_version: "kb.logs.v1"` and exits `2`.
- Argument errors print `kb logs: ...` to stderr and exit `2`.
- File read failures use a JSON error envelope and exit `1`.

Source and test anchors: `src/cli-logs.ts:114-161`,
`src/cli-logs.ts:222-259`, `src/cli-logs.ts:309-390`,
`src/cli-logs.test.ts:68-174`.

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

## `kb eval-gate`

The RFC 018 relevance-gate validation harness. Two modes, gated by `--m1`:

- **M0 (default)** — "validate before build". Answers each query twice (raw
  top-k vs. gate-simulated top-k via threshold surgery) and grades both for
  downstream quality. Live with `--endpoint` (and optionally `--model`), or
  simulation with `--dry-run` / when no endpoint is reachable.
- **M1 (`--m1`)** — canary against the real gate (`KB_RELEVANCE_GATE=on`,
  Stage B judge live). Requires a reachable endpoint. Reports downstream
  answer quality, recall on known-good fixtures, position-swap probe,
  `KB_GATE_SCORE_FLOOR` sweep, BM25-veto calibration, and go/no-go.

Invocation:

```bash
kb eval-gate <fixture.yml|json> --format=json [--endpoint=<url>] [--model=<id>]
             [--dry-run] [--calibration=<path>] [--out=<path>]
kb eval-gate <fixture.yml|json> --m1 --format=json --endpoint=<url>
             [--model=<id>] [--score-floor=<n>] [--floor-sweep=lo:hi:step]
             [--calibration=<path>] [--out=<path>]
```

M0 report envelope:

```json
{
  "meta": {
    "fixturePath": "docs/testing/fixtures/rfc-018-gate-eval/queries.yml",
    "mode": "live",
    "answererModel": "llama-3.1",
    "graderModel": "llama-3.1",
    "generatedAt": "2026-05-21T08:30:00.000Z"
  },
  "summary": {
    "case_count": 24,
    "kb_names": ["operating-environment"],
    "has_answer_count": 18,
    "no_good_answer_count": 6,
    "no_good_answer_ratio": 0.25,
    "directional_pass": true,
    "epsilon": 0.05,
    "no_good_answer_delta": -0.08,
    "has_answer_delta": -0.02,
    "empty_verdict_fire_rate": 0.12,
    "empty_verdict_fire_count": 3,
    "per_chunk_drop_no_good_answer_delta": -0.04,
    "per_chunk_drop_has_answer_delta": -0.01,
    "answer_present_but_distant_count": 2,
    "judge_false_empty_count": 0,
    "judge_false_empty_rate": 0,
    "grader_admissibility": null
  },
  "cases": [
    {
      "name": "deployment runbook",
      "kb": "operating-environment",
      "bucket": "has_answer",
      "fixture_class": "in_kb",
      "gated_verdict": "kept",
      "empty_fired": false,
      "conditions": [
        { "label": "raw", "outcome": "answered_correctly", "passages": 5 },
        { "label": "gated", "outcome": "answered_correctly", "passages": 3 }
      ]
    }
  ]
}
```

Stable fields:

- `meta.mode` is `"live"` or `"simulation"`.
- `summary.directional_pass` is the pre-registered RFC 018 M0 go/no-go boolean.
- `summary.empty_verdict_fire_rate`, `summary.per_chunk_drop_no_good_answer_delta`,
  `summary.judge_false_empty_rate` are the three pre-registered M0 numbers.
- `cases[].bucket` is `"has_answer"` or `"no_good_answer"`.
- `cases[].fixture_class` is `"in_kb"`, `"adjacent"`, or `"out_of_kb"`.

The M1 (`--m1`) JSON report has a different shape (canary measurements, sweep
points, recommendation). See `src/relevance-gate-m1.ts:toM1JsonReport` and
`docs/rfcs/018-m1-canary-report.md` for the field list.

Stdout/stderr and exit codes:

- JSON report on stdout, plus `--out=<path>` mirrors the report to a file.
- Exit `0` always for M0 (the harness "runs straight through" by design).
- Exit `2` for argv/fixture errors and for `--m1` without a reachable endpoint.
- Exit `1` only for an M1 run that fails after the endpoint probe succeeded.

Source and test anchors: `src/cli-eval-gate.ts:58-138`,
`src/cli-eval-gate.ts:163-237`, `src/cli-eval-gate.ts:244-303`,
`src/cli-eval-gate.ts:493-529`, `src/relevance-gate-m1.ts:822-940`,
`src/cli-json-contracts.test.ts` (eval-gate goldens).

## `kb feedback`

Records and promotes per-KB relevance judgments. The ledger lives in
`<kb>/.index/relevance-feedback.jsonl`. Promotion converts every ledger row
for a single query into a `kb eval` fixture case, so accumulated judgments
become regression coverage.

Invocation:

```bash
kb feedback add --kb=<name> --query=<text> --source=<rel-path>
                [--chunk-id=<id>] [--verdict=relevant|irrelevant|stale|misleading]
                [--relevance=0..3] [--task-context=<text>] [--note=<text>]
                [--group=<label>]... --format=json
kb feedback list --kb=<name> [--query=<text>] [--limit=<int>] --format=json
kb feedback promote --kb=<name> --query=<text> [--name=<case-name>]
                    [--k=<int>] [--mode=dense|lexical|hybrid|auto] [--gate]
                    [--fixture=<path> --yes] --format=json
```

`add` envelope:

```json
{
  "ledger_path": "/home/jean/knowledge_bases/work/.index/relevance-feedback.jsonl",
  "entry": {
    "id": "01HVT7C0DXFG2MJC9Y4N9YEH3R",
    "kb": "work",
    "created_at": "2026-05-21T09:15:00.000Z",
    "query": "rollback procedure",
    "source": "runbooks/deploy.md",
    "chunk_id": "work/runbooks/deploy.md#L42-L78",
    "verdict": "relevant",
    "relevance": 3,
    "task_context_sha256": "0123…",
    "note": "matches step 3 in deploy.md",
    "groups": ["runbook"]
  }
}
```

`list` envelope:

```json
{
  "ledger_path": "/home/jean/knowledge_bases/work/.index/relevance-feedback.jsonl",
  "entries": [
    { "id": "…", "kb": "work", "created_at": "…", "query": "…", "source": "…", "verdict": "relevant", "relevance": 3 }
  ]
}
```

`promote` envelopes:

```json
{
  "query": "rollback procedure",
  "fixture_path": null,
  "wrote": false,
  "fixture_yaml": "gate: false\ncases:\n  - name: rollback procedure\n    ...\n"
}
```

```json
{
  "fixture_path": "docs/testing/feedback-fixture.yml",
  "wrote": true,
  "created": false,
  "case_count": 7
}
```

Stable fields:

- Every envelope includes the ledger path; `add` returns the new `entry`.
- `entry.verdict` is one of `relevant`, `irrelevant`, `stale`, `misleading`.
- `entry.relevance` is `0..3`. Non-relevant verdicts default to `0`; `relevant`
  defaults to `3` unless `--relevance` overrides.
- `entry.task_context_sha256` is present only when `--task-context` was passed;
  the raw text is never stored.
- `promote` is read-only without `--fixture --yes`; the preview includes the
  full `fixture_yaml` so an operator can review before writing.
- Promote-with-write returns `case_count` (the fixture's case count after the
  append) and `created` (`true` if the fixture file did not exist).

Stdout/stderr and exit codes:

- Reports on stdout. Errors print `kb feedback: <message>` to stderr.
- Exit `0` on success.
- Exit `2` on argv errors and missing KB.
- Exit `1` on ledger I/O or fixture-write failures.

Source and test anchors: `src/cli-feedback.ts:56-140`,
`src/cli-feedback.ts:253-326`, `src/feedback-ledger.ts`,
`src/cli-feedback.test.ts`.

## `kb serve status`

A read-only lifecycle probe for the resident `kb serve` daemon. Queries
`GET /health` at the configured `KB_DAEMON_URL` (defaults to
`http://127.0.0.1:17799`) and reports reachability without starting or
stopping a daemon.

Invocation:

```bash
kb serve status [--json]
```

Reachable envelope:

```json
{
  "reachable": true,
  "url": "http://127.0.0.1:17799/",
  "daemon": {
    "url": "http://127.0.0.1:17799/",
    "pid": 41234,
    "uptime_ms": 124500,
    "idle_timeout_ms": 300000,
    "commands": ["search", "list", "stats"]
  }
}
```

Not-reachable envelope:

```json
{
  "reachable": false,
  "url": "http://127.0.0.1:17799/"
}
```

Stable fields:

- `reachable`, `url` always present.
- `daemon.commands` always lists the read-only commands the daemon accepts.
- `daemon.pid`, `daemon.uptime_ms`, `daemon.idle_timeout_ms` are present when
  the daemon's `/health` payload supplies them.

Stdout/stderr and exit codes:

- JSON envelope on stdout. The default (non-`--json`) markdown output goes to
  stdout too.
- Exit `0` when a daemon is reachable.
- Exit `2` for invalid arguments or environment (bad `KB_DAEMON_URL`).
- Exit `3` when no daemon is reachable at the configured URL (this is the
  "happy idle" state, distinct from errors).
- Exit `1` when a daemon answered but the `/health` payload was unusable.

Source and test anchors: `src/cli-serve.ts:114-166`,
`src/daemon-client.ts:46-122`, `src/cli-serve.test.ts:109-180`.

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

## `kb open`

Invocation:

```bash
kb open alpha/docs/deploy.md#L42-L78 --json
kb open kb://alpha/docs/deploy.md --json
```

`kb open` resolves any of the three pointers `kb search` prints — a chunk id,
a `kb://` resource URI, or a KB-relative result path — back to the absolute
filesystem path of the source document. It is strictly read-only: it never
launches an editor or touches the FAISS index.

Text mode (default) prints the resolved absolute path on stdout, one line.

`--json` envelope:

```json
{
  "target": "alpha/docs/deploy.md#L42-L78",
  "knowledgeBase": "alpha",
  "relativePath": "alpha/docs/deploy.md",
  "path": "/home/user/knowledge-bases/alpha/docs/deploy.md",
  "line": 42,
  "lineEnd": 78,
  "editorUri": "vscode://file/home/user/knowledge-bases/alpha/docs/deploy.md:42:0"
}
```

Stable fields:

- `target` echoes the reference exactly as supplied.
- `knowledgeBase` and `relativePath` (KB-prefixed, matching a search result's
  `metadata.relativePath`) identify the document.
- `path` is the realpath-resolved absolute file path.
- `line` and `lineEnd` are present only when the reference carried an
  `#L<from>-L<to>` (or bare `#L<line>`) fragment.
- `chunkIndex` is present only for a `#chunk-<n>` fragment.
- `editorUri` is present only when `KB_EDITOR_URI` is `vscode`, `cursor`, or
  `file`; it mirrors the `editor_uri` field `kb search` emits.

Stdout/stderr and exit codes:

- The resolved path (text) or JSON object is stdout with exit `0`.
- There is no stable JSON error envelope. Errors print `kb open: ...` to
  stderr.
- Exit `2` for a missing/invalid argument, an unparseable reference, an
  unknown KB, or a path that escapes the KB root.
- Exit `1` when the reference is well-formed but the file does not exist (a
  stale pointer).

Source and test anchors: `src/cli-open.ts`, `src/chunk-id.ts::parseChunkReference`,
`src/cli-open.test.ts`, `src/chunk-id.test.ts`.

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

## `kb reindex status`

Invocation:

```bash
kb reindex status [--kb=<name>...] [--format=json]
```

`kb reindex status` is a read-only command (RFC 017 #407). It rolls the
contextual-preface sidecars under `$FAISS_INDEX_PATH/.contextual-prefaces/`
into a per-KB / per-file progress ledger so an operator can see, after a
SIGINT, crash, or host reboot, which files completed their LLM preface work
and which still need it.

Success envelope:

```json
{
  "schema_version": "reindex-progress.v1",
  "computed_at": "2026-05-19T11:02:03.456Z",
  "run_active": false,
  "run": null,
  "kbs": [
    {
      "knowledge_base": "operating-environment",
      "files_indexed": 120,
      "files_with_sidecar": 50,
      "files_complete": 47,
      "files_incomplete": 3,
      "files_pending": 70,
      "chunks_resolved": 1843,
      "chunks_failed": 12,
      "files": [
        {
          "source": "/abs/path/to/note.md",
          "status": "incomplete",
          "chunks_total": 10,
          "chunks_resolved": 8,
          "chunks_failed": 2,
          "error_codes": ["llm_unreachable"]
        }
      ]
    }
  ],
  "totals": {
    "knowledge_bases": 1,
    "files_indexed": 120,
    "files_with_sidecar": 50,
    "files_complete": 47,
    "files_incomplete": 3,
    "files_pending": 70,
    "chunks_resolved": 1843,
    "chunks_failed": 12
  }
}
```

Stable fields:

- `schema_version` is the string `reindex-progress.v1`.
- `computed_at` is an ISO-8601 timestamp.
- `run_active` is a boolean — `true` when `.reindex.run.json` names a live PID.
- `run` is `null`, or an object with `pid`, `started_at`, and `kbs_in_scope`.
- `kbs` is an array, sorted by `knowledge_base`. Each entry has the integer
  counts shown above and a `files` array sorted by `source`.
- `files[].status` is `complete` (every chunk has a preface) or `incomplete`.
- `files[].error_codes` is a sorted array of distinct contextual error codes
  (`llm_unreachable`, `llm_malformed`, `llm_refusal`, `truncated_doc`).
- `totals` aggregates every reported KB.

Notes:

- `files_indexed` counts chunk manifests under `<kb>/.index/` and is the
  denominator the reindex walks; `files_pending` is
  `max(0, files_indexed - files_with_sidecar)`. Both are approximate while a
  reindex is in flight.
- `--kb=<name>` (repeatable) restricts the report. A named KB with no sidecars
  is still reported with zero counts.

Stdout/stderr and exit codes:

- The JSON snapshot is stdout with exit `0`; the same snapshot is also
  materialized to `$FAISS_INDEX_PATH/.reindex.progress.json`.
- Argument errors print `kb reindex status: ...` to stderr and exit `2`.

Source and test anchors: `src/cli-reindex.ts::runReindexStatusCli`,
`src/reindex-progress.ts::computeReindexProgress`,
`src/cli-reindex-status.test.ts`, `src/reindex-progress.test.ts`.
