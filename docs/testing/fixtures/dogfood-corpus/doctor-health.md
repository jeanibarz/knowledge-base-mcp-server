---
fixture_owner: retrieval-eval
status: stable
topic: doctor
---

# Doctor Health Checks

The doctor command verifies the local knowledge-base layout before retrieval.
It checks that the index directory exists, that metadata manifests can be read,
that the configured embedding provider is reachable, and that the active model
matches the index metadata.

The command reports stale files separately from structural failures. A stale
file warning means the corpus can still answer queries, while a missing index
or provider failure means retrieval should be treated as unavailable.

