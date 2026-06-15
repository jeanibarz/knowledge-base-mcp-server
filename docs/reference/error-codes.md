# KB Error Codes

This reference documents the stable `KBErrorCode` values emitted by the server
and CLI. Operators can see these codes in classified CLI JSON failures under
`error.code`, MCP tool error payloads, and canonical logs from server-side and
reindex paths that preserve `KBError` details. Some CLI wrappers log only their
process exit class, such as `EXIT_1` or `EXIT_2`, so prefer the command's JSON
error payload when available. Contextual-retrieval ingest can also surface
related per-chunk sidecar `error_code` values; those are lower-level
diagnostics, while the codes below are the operator-facing taxonomy from
`src/errors.ts`.

Use the code to decide the first response. Message text is diagnostic prose and
can change between releases.

## Reference

| Code | Meaning | Typical Cause | Operator Remedy | Transient? |
| --- | --- | --- | --- | --- |
| `INDEX_NOT_INITIALIZED` | The active FAISS index is missing from memory or has not been built. | Search ran before `initialize` / `updateIndex`, or the active model was registered without an index refresh. | Build the index with `kb search --refresh`; if no active model exists, register one with `kb models add`. | No |
| `PROVIDER_UNAVAILABLE` | The embedding provider cannot be reached or returned an availability failure. | Ollama is stopped, a managed provider endpoint is down, DNS/proxy routing is broken, or a non-context Ollama 4xx was classified as unavailable. | Run `kb doctor --format=json`, confirm the configured backend and endpoint, start/fix the provider, then retry. | Yes |
| `PROVIDER_TIMEOUT` | The embedding provider did not complete within the request timeout. | Slow provider response, network/proxy latency, overload, or a timed-out provider SDK call. | Retry once; if it repeats, check provider health and network/proxy settings from the same environment that launches `kb`. | Yes |
| `PROVIDER_AUTH` | Provider credentials are missing or invalid. | `OPENAI_API_KEY` or `HUGGINGFACE_API_KEY` is absent, expired, or not visible to the service process. | Set the provider key in the launching environment and confirm `kb doctor` sees the expected provider configuration. | No |
| `KB_NOT_FOUND` | The requested knowledge base does not exist or is not registered. | A misspelled `--kb` value, stale client configuration, missing KB root, or a document mutation targeted an unknown KB. | Run `kb list`, choose a registered KB, or restore/register the missing KB root before retrying. | No |
| `PERMISSION_DENIED` | The running user cannot read or write a required KB or index path. | Filesystem errors such as `EACCES`, `EPERM`, or `EROFS` on `$FAISS_INDEX_PATH`, a KB root, or a `.index` directory. | Grant the service user access to the affected path, remount writable storage if needed, then retry the original command. | No |
| `CORRUPT_INDEX` | A committed index or lexical index artifact cannot be parsed or has an invalid shape. | Truncated files, partial writes, incompatible artifact contents, or invalid JSON in lexical index data. | Rebuild with `kb search --refresh`; if corruption repeats, run `kb doctor` and inspect the model's FAISS and lexical-index artifacts. | No |
| `VALIDATION` | Caller input or derived request data failed validation before the operation could proceed. | Empty paths, null bytes, path traversal, invalid KB names, unsupported arguments, or provider context-length validation. | Fix the field named in the message and retry; for context-length failures, reduce chunk/query size or change model settings. | No |
| `INTERNAL` | The server reached an unexpected or unclassified failure path. | A bug, unknown thrown value, malformed internal state, or an error that reached a boundary without a more specific `KBErrorCode`. | Run `kb doctor --format=json`, capture canonical logs for the request, and file an issue with the command and environment details. | No |
| `PREFACE_LLM_FAILURE` | Contextual-preface generation failed while calling or parsing the LLM. | `KB_LLM_ENDPOINT` is unreachable, the LLM returned malformed/refusal/truncated output, or a preface call failed during ingest/reindex. | Probe the LLM endpoint from the service environment, fix the endpoint or model, then rerun ingest or contextual reindex. | Yes |
| `PREFACE_SIDECAR_CORRUPT` | A contextual-preface sidecar is unreadable or inconsistent. | Corrupt sidecar JSON, partial sidecar writes, or sidecar content that no longer matches expected contextual-retrieval schema. | Delete the offending sidecar under `$FAISS_INDEX_PATH/.contextual-prefaces/` so the next ingest can regenerate it. | No |
| `REINDEX_LOCK_HELD` | A contextual reindex cannot start because another reindex owns the model lock. | A live `kb reindex --with-context` run is active, or a previous run left a state file that still appears live. | Check `kb reindex status --format=json`; wait for the active run or follow the incident runbook before removing any lock/state file. | Yes |
| `REINDEX_BUDGET_EXCEEDED` | The contextual reindex estimate exceeds the configured quiet-window budget. | The estimated runtime would cross the LRA cron window or configured reindex budget guard. | Schedule the run inside the quiet window, reduce scope where supported, or pass `--force` only when the operator accepts the risk. | No |
| `INSUFFICIENT_DISK_SPACE` | A write-heavy reindex/ingest preflight estimated more bytes than the volume can hold. | Estimated index/sidecar bytes plus the `KB_MIN_FREE_DISK_BYTES` margin exceed the `statfs`-reported free space under `$FAISS_INDEX_PATH`; the run refused before writing. | Free disk space under `$FAISS_INDEX_PATH` (prune old index versions, clear caches) or lower `KB_MIN_FREE_DISK_BYTES`, then retry. | No |

## Response Guidance

Treat `PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT`, `PREFACE_LLM_FAILURE`, and
`REINDEX_LOCK_HELD` as retry candidates after the underlying condition is fixed
or the competing process exits. The remaining codes are terminal for the
current request: change input, configuration, credentials, permissions, or index
state before retrying.

For symptom-first triage, start with
[`docs/operations/incident-response.md`](../operations/incident-response.md).
For JSON output shapes, see
[`docs/cli-json-contracts.md`](../cli-json-contracts.md).
