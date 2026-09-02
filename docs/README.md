# Documentation

Start at the repo [`README.md`](../README.md) if you're new — it covers install,
configuration, and the day-one commands. This page routes you to everything
deeper, grouped by what you're trying to do.

## Set up and use

| Doc | Read it when |
| --- | --- |
| [clients.md](clients.md) | Wiring a specific MCP client — Claude Desktop, Codex CLI, Cursor, Continue, Cline. |
| [authoring-knowledge.md](authoring-knowledge.md) | Writing notes the server can actually retrieve: chunk-friendly markdown, frontmatter, content-boundary risk, the note lifecycle. |
| [search-neighbor-context.md](search-neighbor-context.md) | Deciding whether to pull adjacent chunks in around each match. |
| [llm-provider.md](llm-provider.md) | Pointing `kb ask` and the other chat-completion paths at a local or hosted LLM. |
| [agent-task-lessons.md](agent-task-lessons.md) | Recording transferable lessons from an agent task with `kb remember --lesson`. |
| [troubleshooting-local-kb.md](troubleshooting-local-kb.md) | Search returns nothing, the index looks stale, or `kb` seems to be running the wrong checkout. |

## MCP surface

| Doc | Read it when |
| --- | --- |
| [reference/mcp-tools.md](reference/mcp-tools.md) | You need a tool's exact input schema, types, and bounds. *(generated)* |
| [mcp-resources.md](mcp-resources.md) | Your client wants to enumerate and read source documents directly, rather than search them. |
| [mcp-prompts.md](mcp-prompts.md) | Your client wants reusable KB-backed prompt templates. |
| [mcp-logging.md](mcp-logging.md) | You want per-session log levels over HTTP or SSE. |

## Reference

Everything under [`reference/`](reference/) is **generated from source** and gated
in CI, so it cannot drift from the shipped behaviour. Don't hand-edit these
files — change the source and regenerate.

| Doc | Covers |
| --- | --- |
| [reference/cli.md](reference/cli.md) | Every `kb` command and flag. |
| [reference/configuration.md](reference/configuration.md) | Every environment variable, with defaults and validation rules. |
| [reference/mcp-tools.md](reference/mcp-tools.md) | Every MCP tool and its input schema. |
| [reference/error-codes.md](reference/error-codes.md) | Every stable error code, with cause and remedy. |
| [reference/embedding-models.md](reference/embedding-models.md) | Supported models, dimensions, task prefixes, reindex caveats. |
| [reference/loaders.md](reference/loaders.md) | Which file types are ingested and how they're decoded. |
| [reference/metrics.md](reference/metrics.md) | Every exported metric. |

Two hand-maintained companions sit alongside them:

- [feature-flags.md](feature-flags.md) — the operator-facing defaults matrix: what each retrieval, LLM, ingest, and diagnostic knob does, its rollout status, and how to validate a change.
- [cli-json-contracts.md](cli-json-contracts.md) — stable JSON shapes for the agent-facing `kb` commands, for anyone scripting against the output.

## Run it in production

[`operations/`](operations/README.md) holds symptom- and task-keyed runbooks:
daemon lifecycle, incident response, indexing throughput, index quantization,
local service health, log reading, metrics export, query cache, the research and
feedback workflows, secret scanning, and switching embedding models. Start at
[operations/incident-response.md](operations/incident-response.md) during a live
incident.

## Understand and change the design

| Folder | Perspective |
| --- | --- |
| [architecture/](architecture/README.md) | How the system works **today** — C4 views, sequence and state diagrams, data model, QA budgets, threat model. Every claim is anchored to a file and line on `main`. |
| [architecture/adr/](architecture/adr/) | Decisions already made, including superseded ones, with the reasoning preserved. |
| [rfcs/](rfcs/) | Where things are going. Numbered design docs for non-trivial changes; merging an RFC does not imply it is implemented. |
| [requirements/INDEX.md](requirements/INDEX.md) | The canonical requirements catalog. |
| [testing/INDEX.md](testing/INDEX.md) | Test strategy, retrieval-eval methodology, and the fake-LLM harness. |

Benchmark harnesses and archived results live outside `docs/`, in
[`benchmarks/`](../benchmarks/README.md).
