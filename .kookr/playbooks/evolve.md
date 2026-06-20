---
name: KB MCP - unattended kb CLI evolution chain
description: Run kb CLI performance/efficiency evolution one iteration at a time from durable state.json. Each iteration benchmarks the current champion against untried candidate arms, applies the objective and budget gates, records history, and advances the state cursor.
tags: [kb, cli, evolution, benchmark, self-continuation]
cwd: $HOME/git/knowledge-base-mcp-server
parameters:
  - name: maxIter
    description: "Optional cap on iterations for this chain run. 0 = run until STOP/state cap/no candidates."
    required: false
    default: "0"
  - name: sleep
    description: "Seconds to wait between iterations in the shell chain."
    required: false
    default: "1"
---

# Unattended kb CLI evolution chain

This playbook gives the repo the same operator shape as the other evolution
repos: durable state, a single-iteration driver, a chain driver, a STOP file,
and append-only history.

## How to run

Single iteration:

```bash
cd ~/git/knowledge-base-mcp-server
bin/run-iteration.sh
```

Run until stopped, no candidates remain, or a cap is reached:

```bash
cd ~/git/knowledge-base-mcp-server
bin/run-chain.sh --max-iter {{maxIter}} --sleep {{sleep}}
```

Stop with `Ctrl-C`, `touch ./STOP`, or `kill <pid>`; the chain writes
`.chain-heartbeat` while active.

## Self-continuation contract

When run as a Kookr self-continuation task chain, each task must:

1. Read durable state from `state.json`; never rely on prior conversation.
2. Do exactly one iteration: `bin/run-iteration.sh`.
3. Treat `benchmarks/results/evolution/<run-id>/decision.json` as the mechanical
   result for that iteration.
4. Record state/history before spawning any successor. The driver updates
   `state.json` and appends `history.md`.
5. Stop without spawning when:
   - `bin/run-iteration.sh` exits non-zero,
   - `./STOP` exists,
   - `state.json: chain.stop_after_iter` is reached,
   - no eligible candidate remains for the current champion.
6. Otherwise spawn the successor with this same contract and a uniqueness cursor
   derived from fresh state, for example:
   `cursor: iter=<state.chain.iter> champion=<state.current_champion.id> last=<state.last_run_id>`.

The successor prompt must be self-contained and written through a prompt file,
not embedded as a shell argv string.

## State model

- `current_champion` is the benchmark arm future candidates compare against.
- `candidate_pool` contains candidate env/command mutations.
- `candidate_history` prevents rerunning the same candidate against the same
  champion.
- `chain.candidates_per_iteration` controls batch size.
- `chain.stop_after_iter` is a persistent cap; `null` means no persistent cap.

The harness is advisory. A promotion updates `state.json`'s benchmark champion,
but it does not rewrite production defaults or refresh committed baselines. If a
candidate should become code or defaults, create a normal PR from the winning
decision/report.
