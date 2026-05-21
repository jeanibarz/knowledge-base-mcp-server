import * as fsp from 'node:fs/promises';

import {
  parseDotEnvText,
  validateConfigEnv,
  type ConfigFinding,
  type ConfigValidateReport,
} from './config/schema.js';

export const CONFIG_HELP = `kb config — inspect and validate KB configuration

Usage:
  kb config validate [--file=.env] [--format=md|json]

Validates known environment variables against the static KB config schema:
type, enum membership, numeric ranges, URL syntax, and cross-variable
dependencies. The command is read-only and does not probe live endpoints.

Options:
  --file=<path>             Parse this dotenv file instead of process.env.
  --format=md|json          Output format (default: md).
  --help, -h                Show this help.

Exit codes:
  0   validation passed with no errors
  1   validation found one or more errors
  2   invalid arguments or unreadable dotenv file
`;

export interface ConfigArgs {
  action: 'validate';
  file?: string;
  format: 'md' | 'json';
}

export async function runConfig(rest: string[]): Promise<number> {
  let parsed: ConfigArgs;
  try {
    parsed = parseConfigArgs(rest);
  } catch (err) {
    process.stderr.write(`kb config: ${(err as Error).message}\n`);
    return 2;
  }

  let env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env;
  let source = 'process.env';
  let parseErrors: ConfigFinding[] = [];
  if (parsed.file !== undefined) {
    source = parsed.file;
    let raw: string;
    try {
      raw = await fsp.readFile(parsed.file, 'utf-8');
    } catch (err) {
      process.stderr.write(`kb config validate: cannot read ${parsed.file}: ${(err as Error).message}\n`);
      return 2;
    }
    const parsedEnv = parseDotEnvText(raw, source);
    env = parsedEnv.env;
    parseErrors = parsedEnv.errors;
  }

  const report = validateConfigEnv(env, { source });
  if (parseErrors.length > 0) {
    report.findings.unshift(...parseErrors);
    report.counts = recount(report.findings);
    report.status = report.counts.error > 0 ? 'error' : report.counts.warn > 0 ? 'warn' : 'ok';
  }

  if (parsed.format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatConfigValidateMarkdown(report));
  }
  return report.counts.error > 0 ? 1 : 0;
}

export function parseConfigArgs(rest: readonly string[]): ConfigArgs {
  if (rest.length === 0) {
    throw new Error('expected action: validate');
  }
  const [action, ...args] = rest;
  if (action !== 'validate') {
    throw new Error(`unknown action: ${action}`);
  }
  const out: ConfigArgs = { action: 'validate', format: 'md' };
  for (const raw of args) {
    if (raw === '--format=json') {
      out.format = 'json';
      continue;
    }
    if (raw === '--format=md') {
      out.format = 'md';
      continue;
    }
    if (raw.startsWith('--format=')) {
      throw new Error(`invalid --format: ${raw}`);
    }
    if (raw.startsWith('--file=')) {
      const value = raw.slice('--file='.length);
      if (value.trim() === '') throw new Error('--file requires a path');
      out.file = value;
      continue;
    }
    throw new Error(`unknown flag: ${raw}`);
  }
  return out;
}

export function formatConfigValidateMarkdown(report: ConfigValidateReport): string {
  const lines = [
    '# kb config validate',
    '',
    `status: ${report.status}`,
    `source: ${report.source}`,
    `checked_at: ${report.checked_at}`,
    `counts: ok=${report.counts.ok} warn=${report.counts.warn} error=${report.counts.error}`,
    '',
    '| Variable | Status | Kind | Value | Message |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const finding of report.findings) {
    lines.push([
      '',
      finding.name,
      finding.status,
      finding.kind,
      finding.value ?? '',
      finding.message,
      '',
    ].map(escapeMarkdownTableCell).join(' | '));
  }
  return `${lines.join('\n')}\n`;
}

function recount(findings: readonly ConfigFinding[]): ConfigValidateReport['counts'] {
  return findings.reduce<ConfigValidateReport['counts']>(
    (counts, finding) => {
      counts[finding.status] += 1;
      return counts;
    },
    { ok: 0, warn: 0, error: 0 },
  );
}

function escapeMarkdownTableCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
}
