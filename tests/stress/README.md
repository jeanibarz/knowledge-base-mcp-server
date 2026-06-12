# Concurrency Stress Test Suite

This suite covers concurrency invariants that are intentionally outside the
default Jest run. It uses scoped temp directories, fake embeddings, and a fake
FAISS store so scenarios do not need network providers or a persistent local
knowledge base.

The suite is opt-in:

```bash
KB_RUN_STRESS=1 npm test -- --runTestsByPath tests/stress/scenarios/search-during-refresh.test.ts --runInBand
KB_RUN_STRESS=1 npm test -- --runTestsByPath tests/stress/scenarios/parallel-mcp-mutations.test.ts --runInBand
```

Without `KB_RUN_STRESS=1`, direct path runs skip the scenarios cleanly:

```bash
npm test -- --runTestsByPath tests/stress/scenarios/search-during-refresh.test.ts --runInBand
```

Current scenarios:

| Scenario | Concurrency surface | Invariant |
| --- | --- | --- |
| `search-during-refresh.test.ts` | Read queries while a scoped refresh is blocked at atomic save | searches do not throw, return only well-formed documents from the target KB, and the refreshed document is visible after save completes |
| `parallel-mcp-mutations.test.ts` | Parallel `add_document` calls through the MCP mutation handler | per-model write lock admits one refresh at a time, every mutation writes the expected document, and every tool result stays successful |

Keep additions deterministic: prefer explicit barriers, fake providers, and
state assertions over wall-clock sleeps or throughput thresholds.
