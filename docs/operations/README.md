# Operations Runbooks

Use these runbooks for day-two operation of the `kb` CLI and MCP server. They
are task- or symptom-keyed and intentionally favor concrete confirmation and
rollback commands over design background.

| Runbook | Use when |
| --- | --- |
| [Daemon lifecycle](daemon-lifecycle.md) | Running or diagnosing the loopback `kb serve` daemon. |
| [Eval gate harness](eval-gate-harness.md) | Measuring relevance-gate behavior before or after rollout. |
| [Feedback workflow](feedback-workflow.md) | Recording retrieval judgements and promoting them into eval fixtures. |
| [Incident response](incident-response.md) | Triage starts from a user-visible failure symptom. |
| [Index quantization](index-quantization.md) | Registering or evaluating an SQ8 FAISS index. |
| [Local services](local-services.md) | Checking Ollama, llama-server, n8n, and local service health. |
| [Logs reader](logs-reader.md) | Inspecting canonical logs and request ids. |
| [Metrics export](metrics-export.md) | Enabling and scraping OpenMetrics output. |
| [Research workflow](research-workflow.md) | Running the read-only `kb research` evidence pass. |
| [Secret scan](secret-scan.md) | Enabling ingest-time credential scanning and reviewing quarantine hits. |
| [Switching embedding models](switching-embedding-models.md) | Changing the active embedding model with verification and rollback. |
