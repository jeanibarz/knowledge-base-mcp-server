#!/usr/bin/env node
import * as fsp from 'fs/promises';
import * as path from 'path';
import { ensureDirectory, writeJsonFile } from '../utils.js';
import { runEvolutionPlan } from './run.js';
import {
  appendHistory,
  applyDecisionToState,
  buildIterationPlan,
  readEvolutionState,
  renderHistoryLine,
  writeEvolutionState,
} from './state.js';
import type { EvolutionDecision } from './types.js';

interface IterationArgs {
  historyPath: string;
  outRoot: string;
  statePath: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const state = await readEvolutionState(args.statePath);
  if (state.chain.stop_after_iter !== null && state.chain.iter >= state.chain.stop_after_iter) {
    process.stdout.write(`chain cap reached: iter ${state.chain.iter} >= ${state.chain.stop_after_iter}\n`);
    process.exitCode = 3;
    return;
  }

  let built;
  try {
    built = buildIterationPlan(state);
  } catch (error) {
    process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 3;
    return;
  }

  const outDir = path.join(args.outRoot, built.plan.run_id!);
  await ensureDirectory(outDir);
  const planPath = path.join(outDir, 'plan.json');
  await writeJsonFile(planPath, built.plan);

  const result = await runEvolutionPlan({ planPath, outDir });
  const decision = JSON.parse(await fsp.readFile(result.decisionPath, 'utf-8')) as EvolutionDecision;
  const nextState = applyDecisionToState(state, built.plan, decision);
  await writeEvolutionState(args.statePath, nextState);
  await appendHistory(args.historyPath, renderHistoryLine(decision));

  process.stdout.write(`iteration complete: ${decision.run_id}\n`);
  process.stdout.write(`Decision: ${result.decisionPath}\n`);
  process.stdout.write(`Report: ${result.reportPath}\n`);
  process.stdout.write(`State: ${args.statePath}\n`);
}

function parseArgs(argv: string[]): IterationArgs {
  const repoRoot = process.cwd();
  let statePath = path.join(repoRoot, 'state.json');
  let historyPath = path.join(repoRoot, 'history.md');
  let outRoot = path.join(repoRoot, 'benchmarks', 'results', 'evolution');

  for (const arg of argv) {
    if (arg.startsWith('--state=')) statePath = arg.slice('--state='.length);
    else if (arg.startsWith('--history=')) historyPath = arg.slice('--history='.length);
    else if (arg.startsWith('--out-root=')) outRoot = arg.slice('--out-root='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return { historyPath, outRoot, statePath };
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
