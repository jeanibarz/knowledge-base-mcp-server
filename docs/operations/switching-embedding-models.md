# Switching Embedding Models

Use this runbook when changing the default embedding model for an existing
deployment. The current RFC 013 layout keeps one index directory per model
under `${FAISS_INDEX_PATH}/models/<model_id>/`; switching the default writes
`${FAISS_INDEX_PATH}/active.txt` and does not delete the previous model.

Keep the old model registered until the new model has passed the retrieval
gate and the rollback window has expired.

## Quick Reference

| Step | Command | Notes |
| --- | --- | --- |
| Inventory | `kb models list` | The `*` marks the active model. |
| Estimate new model | `kb models add <provider> <model> --dry-run` | Prints file/chunk/token estimates and paid-provider cost. |
| Register new model | `kb models add <provider> <model> --yes` | Builds the candidate model index once. |
| Refresh existing model | `kb search "known phrase" --model=<id> --refresh` | Incremental refresh for changed source files. |
| Compare models | `kb compare "query" <old_id> <new_id> --k=10` | Scores are per-model; compare source/rank fit, not raw score magnitudes. |
| Switch default | `kb models set-active <new_id>` | `KB_ACTIVE_MODEL` still overrides this for processes that inherit it. |
| Roll back | `kb models set-active <old_id>` | Works while the old model directory remains registered. |
| Plan cleanup | `kb models gc --dry-run` | Dry-run only; remove explicit models with `kb models remove`. |

## Preflight

Run preflight from the same shell or service environment that normally starts
`kb` or the MCP server:

```bash
kb doctor --format=json
kb models list
kb stats --format=json
kb reindex status --format=json
```

In the doctor JSON, check `embedding_canary.status` for the active model:

- `ok` means the active provider re-embedded the persisted canary close enough
  to the vector captured when the index was built.
- `not_recorded` means the index was built before canary fingerprints were
  recorded. Rebuild that model once with the current CLI before relying on the
  canary for drift detection.
- `warn` means the canary changed or its dimensions no longer match. Treat that
  as possible silent embedding-model drift: either rebuild the index for the
  intended provider/model or restore the original embedding backend before
  serving queries from that index.

Capture the current active model id:

```bash
OLD_MODEL_ID=<old model_id from kb models list>
```

Pick the target provider/model pair and derive or confirm its registered id:

```bash
kb models add openai text-embedding-3-small --dry-run
NEW_MODEL_ID=openai__text-embedding-3-small
```

Before running a model add or broad refresh, stop starting new write paths
against the same `FAISS_INDEX_PATH`: avoid `kb search --refresh`,
`kb models add`, `kb reindex --with-context`, MCP refresh calls, and filesystem
watcher-triggered reindex work until the current writer finishes. Read-only
searches against already-loaded models can continue.

If any MCP client or service sets `KB_ACTIVE_MODEL`, note it now. That env var
has higher precedence than `active.txt`, so `kb models set-active` will not
change that process's default until the env is removed or changed and the
process restarts.

## Register Or Refresh The Candidate

For a new model id, run the dry run first:

```bash
kb models add ollama nomic-embed-text --dry-run
kb models add openai text-embedding-3-small --dry-run
kb models add huggingface BAAI/bge-small-en-v1.5 --dry-run
```

Then register the chosen model:

```bash
kb models add <provider> <model> --yes
kb models list
```

`kb models add` creates `${FAISS_INDEX_PATH}/models/<id>/`, writes a temporary
`.adding` sentinel while work is in progress, and removes that sentinel only
after the model is registered. If the command is interrupted, recover or clean
up the incomplete directory before retrying:

```bash
kb models add <provider> <model> --recover --yes
kb models remove <model_id> --force-incomplete --yes
```

For an already registered target model, refresh only changed files before
comparison:

```bash
kb search "known phrase from the corpus" --model=<model_id> --refresh --k=5
```

`--refresh` does not print a paid-provider cost prompt. For paid providers,
treat a large batch of newly added source files as billable embedding work and
re-run a dry-run add or external token estimate before refreshing.

## Verification Gate

Use the same representative queries you expect operators or MCP clients to ask.
Keep them in a plain-text file if you want repeatable `diff-index` runs:

```bash
printf '%s\n' \
  "rollback procedure" \
  "provider timeout recovery" \
  "known project-specific term" > /tmp/kb-model-switch-queries.txt
```

First verify direct retrieval against the candidate:

```bash
kb search "known project-specific term" --model="$NEW_MODEL_ID" --k=5 --timing
```

Then compare the old and new models on the same queries:

```bash
kb compare "rollback procedure" "$OLD_MODEL_ID" "$NEW_MODEL_ID" --k=10
kb compare "provider timeout recovery" "$OLD_MODEL_ID" "$NEW_MODEL_ID" --k=10
```

Treat the gate as failed when the candidate drops known-good sources for
important queries, returns empty results for known content, or materially
worsens the operator's labelled retrieval-eval fixture.

If the candidate rebuild produced two saved versions for the same model, use
`kb diff-index` to quantify before/after churn for that model:

```bash
ls -1 "$FAISS_INDEX_PATH/models/$NEW_MODEL_ID" | grep '^index.v' | sort -V
kb diff-index \
  --model="$NEW_MODEL_ID" \
  --before=<old_version_number> \
  --after=<new_version_number> \
  --queries=/tmp/kb-model-switch-queries.txt \
  --format=json
```

`kb diff-index` compares two persisted FAISS versions for one embedding model.
It is not a replacement for `kb compare` when deciding between two model ids.

For a heavier latency, storage, and cross-model agreement report, run:

```bash
npm run bench:compare -- \
  --models="$OLD_MODEL_ID,$NEW_MODEL_ID" \
  --fixture=medium \
  --yes
```

## Switch

Promote the candidate only after the verification gate is acceptable:

```bash
kb models set-active "$NEW_MODEL_ID"
unset KB_ACTIVE_MODEL
kb models list
kb search "canary query" --k=5 --timing
kb stats --format=json
```

Restart long-lived MCP clients or services when you need a clean operating
boundary in logs, or when their environment pins `KB_ACTIVE_MODEL`. Unscoped
CLI calls are fresh processes, so after `KB_ACTIVE_MODEL` is unset they use
the active model from `active.txt`.

## Rollback

Rollback is a metadata change while the old model remains registered:

```bash
kb models set-active "$OLD_MODEL_ID"
unset KB_ACTIVE_MODEL
kb search "canary query" --k=5 --timing
```

For MCP clients that pin a model with `KB_ACTIVE_MODEL`, change that env value
back to `$OLD_MODEL_ID` or remove it, then restart the client process.

Rollback requires the old model directory to remain on disk and pass
`isRegisteredModel`: the directory exists, `model_name.txt` is present, and no
`.adding` sentinel is present. If the old model was removed, re-add it with
`kb models add <provider> <model> --yes` and repeat the verification gate.

## Cleanup

After the rollback window expires, plan inactive-model cleanup:

```bash
kb models gc --dry-run
kb models gc --dry-run --format=json
```

`kb models gc` is a planner only. Remove a specific inactive model explicitly:

```bash
kb models remove <old_or_rejected_model_id> --yes
```

The CLI refuses to remove the active model. If you intend to remove the old
model after promotion, confirm `kb models list` marks the new model with `*`
before deleting the old directory.

## Related

- [Feature flags and defaults](../feature-flags.md) for `KB_ACTIVE_MODEL`,
  provider env vars, and `FAISS_INDEX_PATH`.
- [RFC 013 - multi-model embedding support](../rfcs/013-multimodel-support.md)
  for the side-by-side model layout.
- [ADR 0005 - auto-rebuild superseded](../architecture/adr/0005-auto-rebuild-on-model-change.md)
  for why changing models no longer destroys the previous index.
- [Reindex and model selection sequence](../architecture/sequence-reindex.md)
  for the model-add, activation, and forced-rebuild flows.
- [MCP client configuration](../clients.md#multi-model-setups-rfc-013-030)
  for `KB_ACTIVE_MODEL` and per-call `model_name` behavior.
