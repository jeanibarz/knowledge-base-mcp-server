#!/usr/bin/env node
import * as fsp from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { BenchmarkReport } from '../types.js';
import { ensureDirectory, writeJsonFile } from '../utils.js';
import { decideEvolutionPromotion } from './decision.js';
import { renderEvolutionMarkdown } from './report.js';
import {
  EVOLUTION_PLAN_SCHEMA_VERSION,
  type EvolutionArm,
  type EvolutionArmRun,
  type EvolutionPlan,
} from './types.js';

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const plan = await readPlan(args.planPath);
  const runId = plan.run_id ?? timestampRunId(new Date());
  const outDir = args.outDir ?? path.join(process.cwd(), 'benchmarks', 'results', 'evolution', runId);
  await ensureDirectory(outDir);

  const champion = await resolveArm(plan.champion, outDir, 'champion');
  const candidates: EvolutionArmRun[] = [];
  for (const candidate of plan.candidates) {
    candidates.push(await resolveArm(candidate, outDir, 'candidate'));
  }

  const decision = decideEvolutionPromotion({
    champion,
    candidates,
    objective: plan.objective,
    gate: plan.gate,
    runId,
  });

  await writeJsonFile(path.join(outDir, 'decision.json'), decision);
  await fsp.writeFile(path.join(outDir, 'report.md'), renderEvolutionMarkdown(decision), 'utf-8');
  process.stdout.write(`Decision: ${path.join(outDir, 'decision.json')}\n`);
  process.stdout.write(`Report: ${path.join(outDir, 'report.md')}\n`);
}

interface CliArgs {
  outDir?: string;
  planPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  let planPath: string | undefined;
  let outDir: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith('--plan=')) planPath = arg.slice('--plan='.length);
    else if (arg.startsWith('--out-dir=')) outDir = arg.slice('--out-dir='.length);
    else if (!arg.startsWith('--') && planPath === undefined) planPath = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!planPath) {
    throw new Error('usage: node build/benchmarks/evolution/run.js --plan=<plan.json> [--out-dir=<dir>]');
  }
  return { planPath, ...(outDir ? { outDir } : {}) };
}

async function readPlan(planPath: string): Promise<EvolutionPlan> {
  const parsed = JSON.parse(await fsp.readFile(planPath, 'utf-8')) as EvolutionPlan;
  if (parsed.schema_version !== EVOLUTION_PLAN_SCHEMA_VERSION) {
    throw new Error(`evolution plan schema_version must be ${EVOLUTION_PLAN_SCHEMA_VERSION}`);
  }
  if (!parsed.champion?.id) throw new Error('evolution plan must include champion.id');
  if (!Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
    throw new Error('evolution plan must include at least one candidate');
  }
  if (!parsed.objective?.metric_path || !['higher', 'lower'].includes(parsed.objective.direction)) {
    throw new Error('evolution plan objective must include metric_path and direction');
  }
  return parsed;
}

async function resolveArm(arm: EvolutionArm, outDir: string, role: 'champion' | 'candidate'): Promise<EvolutionArmRun> {
  if (!arm.id) throw new Error(`${role} arm is missing id`);
  let reportPath = arm.report;
  if (!reportPath) {
    if (!arm.command || arm.command.length === 0) {
      throw new Error(`${role} arm ${arm.id} must provide report or command`);
    }
    reportPath = await runArmCommand(arm, outDir);
  }
  const report = JSON.parse(await fsp.readFile(reportPath, 'utf-8')) as BenchmarkReport;
  const copiedPath = path.join(outDir, 'reports', `${safeFileSegment(arm.id)}.json`);
  await writeJsonFile(copiedPath, report);
  return { arm, report, report_path: copiedPath };
}

async function runArmCommand(arm: EvolutionArm, outDir: string): Promise<string> {
  const [file, ...args] = arm.command ?? [];
  if (!file) throw new Error(`arm ${arm.id} command is empty`);
  const resultsDir = path.join(outDir, 'raw');
  await ensureDirectory(resultsDir);
  const env = {
    ...process.env,
    ...arm.env,
    BENCH_RESULTS_DIR: arm.env?.BENCH_RESULTS_DIR ?? resultsDir,
    BENCH_RESULTS_PREFIX: arm.env?.BENCH_RESULTS_PREFIX ?? `evol-${safeFileSegment(arm.id)}`,
  };
  const completed = await execFileAsync(file, args, {
    cwd: process.cwd(),
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return findJsonArtifact(completed.stdout);
}

function findJsonArtifact(stdout: string): string {
  const candidates: string[] = [];
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (text.startsWith('JSON:')) candidates.push(text.slice('JSON:'.length).trim());
    else if (text.endsWith('.json')) candidates.push(text);
  }
  const found = candidates.at(-1);
  if (!found) {
    throw new Error(`arm command did not print a JSON artifact path\nstdout:\n${stdout}`);
  }
  return found;
}

function timestampRunId(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function safeFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'arm';
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
