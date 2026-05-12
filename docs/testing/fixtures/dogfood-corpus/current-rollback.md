---
fixture_owner: retrieval-eval
status: current
topic: operations
---

# Current Rollback Procedure

Production rollback starts by freezing writers, checking the latest manifest,
and restoring the most recent verified index snapshot. Operators then run the
doctor command and a smoke retrieval query before reopening writes.

The current procedure does not delete the docstore. It preserves canonical
document identifiers so query traces and audit logs remain comparable before
and after the rollback.

