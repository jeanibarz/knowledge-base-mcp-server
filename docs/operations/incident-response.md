# Incident Response

Use this runbook when a production or local operator needs to triage a `kb`
failure by symptom. It is intentionally symptom-first: confirm what is
happening from canonical logs or read-only health commands, apply the narrowest
mitigation, then escalate only when the state is still unsafe or unexplained.

Keep the first pass read-only. Capture the command output before deleting
index files, clearing quarantine entries, or removing lock files.

## Quick Reference

| Symptom | First confirmation | Primary mitigation | Deeper runbook |
| --- | --- | --- | --- |
| Search returns 0 results for known content | `kb logs recent --format=json` and `kb stats` | Refresh the affected KB or bypass gate/rerank to bisect | [`docs/troubleshooting-local-kb.md`](../troubleshooting-local-kb.md) |
| FAISS write lock is busy | Search error category `lock` or code `REFRESH_LOCK_BUSY` | Wait for the writer; keep using read-only search | [`local-services.md`](local-services.md#refresh-and-reindex-discipline) |
| Embedding provider is degraded | `kb doctor --format=json` backend row or provider error codes | Start/fix the backend, then retry | [`local-services.md`](local-services.md#daily-health-check) |
| LLM judge is unreachable | Gate canonical event has `gate.degraded: true` | Let fail-soft retrieval continue; fix judge endpoint before changing gate defaults | [`eval-gate-harness.md`](eval-gate-harness.md) |
| `kb serve` refuses connections | `kb serve status --json` | Start or restart only the warm CLI daemon | [`daemon-lifecycle.md`](daemon-lifecycle.md) |
| Quarantine count is growing | `kb quarantine list --format=json` | Fix or acknowledge specific files, then retry ingest | [`ADR 0008`](../architecture/adr/0008-ingest-quarantine-jsonl-vs-sqlite.md) |
| Reindex appears stuck | `kb reindex status --format=json` | Inspect `.reindex.run.json` liveness and current progress | [`feature-flags.md`](../feature-flags.md#contextual-retrieval-at-ingest) |

## Evidence Checklist

Run the commands from the same shell or service environment that launches
`kb`:

```bash
kb doctor --format=json
kb stats --format=json
kb logs recent --limit=50 --format=json
kb serve status --json
kb reindex status --format=json
```

If canonical logging is not enabled, turn it on for the producing process and
reproduce once:

```bash
export KB_LOG_FORMAT=both
export LOG_FILE=/tmp/kb.log
```

Then use `kb logs show --request-id=<id> --format=json` when a failed command
printed a request id. Canonical events use the `kb-canonical.v1` fields
documented in [`logs-reader.md`](logs-reader.md): `cmd`, `kb_scope`,
`result_count`, `took_ms`, `embed_ms`, `faiss_ms`, `error.code`,
`error.category`, `recovery_hint`, `gate`, and `llm_provider`.

## Search Returns 0 Results for Known Content

**Confirm**

```bash
kb logs recent --limit=50 --format=json \
  | jq '.events[]
        | select((.cmd == "kb search" or .tool == "retrieve_knowledge")
                 and .result_count == 0)
        | {ts, request_id, process, cmd, tool, kb_scope, search_mode, result_count, gate, error}'

kb stats --format=json
kb doctor --format=json
```

Look for:

- `result_count: 0` with no `error`: retrieval completed but found nothing.
- `gate.state` with `output_count: 0`: the relevance gate may have removed
  every candidate.
- `stale_counts_by_kb.<name>.modified_files` or `.new_files` greater than
  zero in `kb doctor`.
- `chunk_count` or dense coverage of `0` for a KB that has source files.

**Mitigate**

1. Confirm the expected KB exists and has chunks:

   ```bash
   kb list
   kb stats --kb=<name> --format=json
   ```

2. Query an exact phrase from a known file, scoped to the affected KB:

   ```bash
   kb search "exact phrase from the note" --kb=<name> --k=5
   ```

3. If the selected scope is stale, refresh only that KB:

   ```bash
   kb search "exact phrase from the note" --kb=<name> --refresh --k=5
   ```

4. If the query is code-like, path-like, flag-like, or an error code, switch
   to hybrid/auto before broadening the incident:

   ```bash
   kb search "INDEX_NOT_INITIALIZED" --mode=hybrid --k=5
   kb search "src/cli-search.ts" --mode=auto --k=5
   ```

5. If gate or rerank is suspected, bisect the optional layers:

   ```bash
   kb search "known phrase" --kb=<name> --no-gate --no-rerank --format=json
   ```

**Escalate**

File a bug with `kb doctor --format=json`, `kb stats --format=json`, the
canonical request event, and the exact source file path if:

- `kb stats` shows non-zero chunks and an exact phrase still returns no hits
  after a scoped refresh.
- The gate returns an empty verdict while `KB_GATE_EMPTY_VERDICT=off`.
- `CORRUPT_INDEX` appears after a refresh.

## FAISS Write Lock Is Busy

**Confirm**

```bash
kb logs recent --limit=50 --format=json \
  | jq '.events[]
        | select(.error.category == "lock" or .error.code == "REFRESH_LOCK_BUSY")
        | {ts, cmd, request_id, error, recovery_hint}'

kb doctor --format=json
```

`REFRESH_LOCK_BUSY` means another writer is updating the same model index.
Read-only `kb search` does not need the write lock.

**Mitigate**

1. Stop starting new write paths. Avoid `kb search --refresh`, `kb models add`,
   and MCP refresh calls until the current writer finishes.
2. Keep serving from the current index when stale results are acceptable:

   ```bash
   kb search "known phrase" --k=5
   ```

3. Identify the likely writer from shell history, supervisor logs, MCP client
   logs, or refresh progress stderr.
4. Retry after the writer exits. The lock implementation heartbeats every few
   seconds and treats stale locks conservatively.

**Escalate**

Do not remove `${FAISS_INDEX_PATH}/models/<id>/.kb-write.lock` or
`${FAISS_INDEX_PATH}/.kb-sidecar.lock` until you have evidence that no writer
process is alive. Escalate if:

- The same lock error persists well after the suspected writer ended.
- Multiple services are writing the same `FAISS_INDEX_PATH`.
- A lock error is followed by `CORRUPT_INDEX` or missing sidecars.

## Embedding Provider Is Degraded

**Confirm**

```bash
kb doctor --format=json \
  | jq '{status, backend, active_model, checks: [.checks[] | select(.status != "ok")]}'

kb logs recent --limit=50 --format=json \
  | jq '.events[]
        | select(.error.code == "PROVIDER_UNAVAILABLE"
                 or .error.code == "PROVIDER_TIMEOUT"
                 or .error.code == "PROVIDER_AUTH")
        | {ts, cmd, kb_scope, error, recovery_hint}'
```

Look for `backend.healthy: false`, `PROVIDER_UNAVAILABLE`,
`PROVIDER_TIMEOUT`, or `PROVIDER_AUTH`.

**Mitigate**

1. For Ollama, confirm the service and model inventory:

   ```bash
   curl http://localhost:11434/api/tags
   kb doctor
   ```

2. For OpenAI or HuggingFace, verify credentials and endpoint/provider env in
   the same environment as the failing process.
3. Retry the read-only search after the backend is healthy:

   ```bash
   kb search "known phrase" --k=5
   ```

4. If a refresh failed mid-run, inspect `kb doctor` and `kb stats` before
   starting a broad refresh.

**Escalate**

Escalate with the provider row from `kb doctor`, the relevant canonical event,
and the active model id if:

- Provider health alternates between healthy and timeout under normal query
  volume.
- `PROVIDER_AUTH` appears despite credentials being present in the service
  environment.
- Search errors show raw network exceptions instead of classified provider
  codes.

## LLM Judge Is Unreachable

The relevance gate is fail-soft: when Stage B judge calls fail, retrieval
should continue unless the operator has opted into empty verdict behavior.

**Confirm**

```bash
kb logs recent --limit=50 --format=json \
  | jq '.events[]
        | select((.cmd == "relevance-gate.decision"
                  or .tool == "relevance-gate.decision")
                 and (.gate.degraded == true or .gate.degrade_reason != null))
        | {ts, request_id, process, cmd, tool, kb_scope, result_count, gate}'

kb doctor --format=json | jq '.llm_endpoint'
kb llm status --format=json
```

Also run the endpoint probe from the same service environment:

```bash
kb llm probe --endpoint="${KB_GATE_LLM_ENDPOINT:-${KB_LLM_ENDPOINT}}"
```

**Mitigate**

1. Keep `KB_GATE_EMPTY_VERDICT=off` unless you intentionally accept false
   empty results during the incident.
2. Point the gate at a known-good endpoint:

   ```bash
   export KB_GATE_LLM_ENDPOINT=http://127.0.0.1:8080/v1/chat/completions
   ```

3. If using a managed profile, repair it through `kb llm status`, `kb llm
   start --profile=<name>`, or the owning service runbook.
4. Temporarily bypass the gate for user-critical searches:

   ```bash
   kb search "urgent query" --no-gate
   ```

**Escalate**

Escalate when the gate fails closed, canonical events lack `gate.degraded`, or
M1 gate validation fails after endpoint health is restored. Include the
`relevance-gate.decision` canonical event and `kb doctor --format=json`.

## `kb serve` Daemon Refuses Connections

**Confirm**

```bash
kb serve status --json
kb doctor --endpoints --format=json
```

Exit `3` from `kb serve status` means no daemon is listening. That is normal
when callers can fall back to direct in-process search.

**Mitigate**

1. Confirm the configured daemon URL:

   ```bash
   printf '%s\n' "${KB_DAEMON_URL:-http://${KB_DAEMON_HOST:-127.0.0.1}:${KB_DAEMON_PORT:-17799}/}"
   ```

2. Start a daemon only if repeated low-latency CLI reads need it:

   ```bash
   kb serve --idle-timeout-ms=0
   ```

3. If the port is already in use, either stop the conflicting process or pick
   a distinct port:

   ```bash
   KB_DAEMON_PORT=18888 kb serve
   ```

4. Restart only the daemon when stale warm reads are suspected. Writes and
   refreshes always run in-process.

**Escalate**

Escalate if `/health` returns an unusable payload, the daemon binds a
non-loopback address unexpectedly, or direct `kb search` fails with the same
symptom. Include `kb serve status --json` and `kb doctor --endpoints
--format=json`.

## Quarantine Count Is Growing

**Confirm**

```bash
kb doctor --format=json | jq '.quarantine_counts_by_kb'
kb stats --format=json | jq '.quarantined'
kb quarantine list --format=json
```

Quarantine records live at `<kb>/.index/quarantine.jsonl` and use schema
`ingest-quarantine.v1`. They usually mean a specific file could not be loaded
or parsed safely during ingest.

**Mitigate**

1. List the affected files:

   ```bash
   kb quarantine list --kb=<name> --format=json
   ```

2. Fix the source file or ingest config. Common causes are unsupported file
   types, oversized extracted text, malformed markup, permissions, and files
   changing while being read.
3. Retry a single fixed file:

   ```bash
   kb quarantine retry --kb=<name> --path=<relative-path>
   ```

4. Acknowledge a file only when the operator accepts that it should remain
   skipped:

   ```bash
   kb quarantine ack --kb=<name> --path=<relative-path>
   ```

5. Clear entries only after fixing or intentionally removing the files:

   ```bash
   kb quarantine clear --kb=<name> --path=<relative-path>
   ```

**Escalate**

Escalate if quarantine grows after every refresh, if retrying a fixed file
recreates the same record, or if `kb doctor` reports quarantine without
`kb quarantine list` showing the entries. Include the relevant
`quarantine.jsonl` lines and the ingest command that created them.

## Reindex Appears Stuck

This section covers RFC 017 contextual reindex runs and the
`.reindex.run.json` state file. It is separate from the short-lived refresh
write lock.

**Confirm**

```bash
kb reindex status --format=json \
  | jq '{run_active, run, totals, incomplete: [.kbs[] | {knowledge_base, files_incomplete, chunks_failed}]}'

kb logs recent --limit=50 --format=json \
  | jq '.events[]
        | select(.cmd == "reindex.exit"
                 or .cmd == "reindex.zombie-cleanup"
                 or .error.code == "REINDEX_LOCK_HELD"
                 or .error.code == "PREFACE_LLM_FAILURE")
        | {ts, cmd, error, result_count, top_sources}'
```

`run_active: true` means `.reindex.run.json` names a live PID. `run_active:
false` with incomplete files means the previous run ended or was cleaned up
and there is remaining work.

**Mitigate**

1. If a live run exists, do not start another reindex. Watch progress:

   ```bash
   kb reindex status --format=json
   ```

2. If the run is not active and files are incomplete, fix the first failure
   class. For LLM-side failures, verify:

   ```bash
   kb doctor --format=json | jq '.llm_endpoint'
   kb llm probe --endpoint="${KB_LLM_ENDPOINT}"
   ```

3. Restart the contextual rebuild only when the LLM endpoint is healthy and
   the reindex guard window is acceptable:

   ```bash
   KB_CONTEXTUAL_RETRIEVAL=on \
   KB_LLM_ENDPOINT=http://127.0.0.1:8080/v1/chat/completions \
   kb reindex --with-context
   ```

4. Remember that `--kb=<name>` is a guard and estimator hint for contextual
   reindex; the forced rebuild still covers the active model's full FAISS index,
   not just one KB.

**Escalate**

Escalate when `run_active` stays true for a PID that cannot be found, when
`REINDEX_LOCK_HELD` persists after zombie cleanup, or when
`PREFACE_LLM_FAILURE` repeats after endpoint probes pass. Include
`kb reindex status --format=json`, the `.reindex.run.json` contents if
present, and the last `reindex.*` canonical events.

## After Mitigation

1. Re-run the original user-facing command.
2. Re-run the narrow health check that detected the incident.
3. Leave a short note in the issue or incident log with:
   - symptom and time window,
   - confirmation command and key fields,
   - mitigation applied,
   - whether any data/index files were changed,
   - follow-up owner if escalation remains open.

If a new symptom is not covered here, open an issue with the command output
above and link the closest feature runbook so this page can grow without
duplicating every detailed procedure.
