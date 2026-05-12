import * as path from 'path';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config.js';
import { listKnowledgeBases } from './kb-fs.js';
import {
  ackIngestQuarantineEntry,
  clearIngestQuarantine,
  forceRetryIngestQuarantineEntry,
  listIngestQuarantine,
  removeIngestQuarantineEntry,
  type IngestQuarantineRecord,
} from './ingest-quarantine.js';

export const QUARANTINE_HELP = `kb quarantine — inspect and manage ingest quarantine entries

Usage:
  kb quarantine list [--kb=<name>] [--format=md|json]
  kb quarantine clear --kb=<name> --path=<relative-path>
  kb quarantine clear --kb=<name> --all
  kb quarantine retry --kb=<name> --path=<relative-path>
  kb quarantine ack --kb=<name> --path=<relative-path>

Options:
  --kb=<name>           Knowledge base name. Required for mutating commands.
  --path=<rel>          KB-relative quarantined file path.
  --all                 With clear, remove every entry in the KB.
  --format=md|json      Output format for list (default: md).
  --help, -h            Show this help.

Examples:
  kb quarantine list
  kb quarantine list --kb=work --format=json
  kb quarantine retry --kb=work --path=drafts/bad.md
`;

export interface RunQuarantineDeps {
  listKnowledgeBases: (rootDir: string) => Promise<string[]>;
  listIngestQuarantine: (kbPath: string) => Promise<IngestQuarantineRecord[]>;
  removeIngestQuarantineEntry: (kbPath: string, relativePath: string) => Promise<boolean>;
  clearIngestQuarantine: (kbPath: string) => Promise<number>;
  forceRetryIngestQuarantineEntry: (kbPath: string, relativePath: string) => Promise<IngestQuarantineRecord | null>;
  ackIngestQuarantineEntry: (kbPath: string, relativePath: string) => Promise<IngestQuarantineRecord | null>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const DEFAULT_DEPS: RunQuarantineDeps = {
  listKnowledgeBases,
  listIngestQuarantine,
  removeIngestQuarantineEntry,
  clearIngestQuarantine,
  forceRetryIngestQuarantineEntry,
  ackIngestQuarantineEntry,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

type QuarantineAction = 'list' | 'clear' | 'retry' | 'ack';

interface QuarantineArgs {
  action: QuarantineAction;
  kb?: string;
  path?: string;
  all: boolean;
  format: 'md' | 'json';
}

export async function runQuarantine(
  rest: string[],
  deps: RunQuarantineDeps = DEFAULT_DEPS,
): Promise<number> {
  let parsed: QuarantineArgs;
  try {
    parsed = parseQuarantineArgs(rest);
  } catch (err) {
    deps.stderr(`kb quarantine: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    if (parsed.action === 'list') {
      const rows = await listRows(parsed.kb, deps);
      if (parsed.format === 'json') {
        deps.stdout(`${JSON.stringify({ entries: rows }, null, 2)}\n`);
      } else {
        deps.stdout(formatQuarantineMarkdown(rows));
      }
      return 0;
    }

    if (parsed.kb === undefined) throw new Error('--kb is required');
    const kbPath = path.join(KNOWLEDGE_BASES_ROOT_DIR, parsed.kb);
    if (parsed.action === 'clear' && parsed.all) {
      const cleared = await deps.clearIngestQuarantine(kbPath);
      deps.stdout(`Cleared ${cleared} quarantined entr${cleared === 1 ? 'y' : 'ies'} from ${parsed.kb}.\n`);
      return 0;
    }
    if (parsed.path === undefined) throw new Error('--path is required');

    if (parsed.action === 'clear') {
      const removed = await deps.removeIngestQuarantineEntry(kbPath, parsed.path);
      if (!removed) {
        deps.stderr(`kb quarantine: no entry for ${parsed.kb}/${parsed.path}\n`);
        return 1;
      }
      deps.stdout(`Cleared ${parsed.kb}/${parsed.path}.\n`);
      return 0;
    }
    if (parsed.action === 'retry') {
      const record = await deps.forceRetryIngestQuarantineEntry(kbPath, parsed.path);
      if (record === null) {
        deps.stderr(`kb quarantine: no entry for ${parsed.kb}/${parsed.path}\n`);
        return 1;
      }
      deps.stdout(`Retry scheduled for ${parsed.kb}/${parsed.path}.\n`);
      return 0;
    }
    const record = await deps.ackIngestQuarantineEntry(kbPath, parsed.path);
    if (record === null) {
      deps.stderr(`kb quarantine: no entry for ${parsed.kb}/${parsed.path}\n`);
      return 1;
    }
    deps.stdout(`Acked ${parsed.kb}/${parsed.path}; next refresh may retry it.\n`);
    return 0;
  } catch (err) {
    deps.stderr(`kb quarantine: ${(err as Error).message}\n`);
    return 1;
  }
}

export function parseQuarantineArgs(rest: string[]): QuarantineArgs {
  const [actionRaw, ...args] = rest;
  if (actionRaw === undefined) throw new Error('missing action: list, clear, retry, or ack');
  if (actionRaw !== 'list' && actionRaw !== 'clear' && actionRaw !== 'retry' && actionRaw !== 'ack') {
    throw new Error(`unknown action: ${actionRaw}`);
  }
  const out: QuarantineArgs = {
    action: actionRaw,
    all: false,
    format: 'md',
  };
  for (const raw of args) {
    if (raw.startsWith('--kb=')) {
      const value = raw.slice('--kb='.length);
      if (value === '') throw new Error('empty --kb value');
      out.kb = value;
      continue;
    }
    if (raw.startsWith('--path=')) {
      const value = raw.slice('--path='.length);
      if (value === '') throw new Error('empty --path value');
      out.path = value;
      continue;
    }
    if (raw === '--all') {
      out.all = true;
      continue;
    }
    if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length);
      if (value !== 'md' && value !== 'json') throw new Error(`invalid --format: ${raw}`);
      out.format = value;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
  }
  if (out.action !== 'list' && out.format !== 'md') {
    throw new Error('--format is only supported with list');
  }
  if (out.all && out.path !== undefined) {
    throw new Error('--all and --path cannot be combined');
  }
  if (out.action !== 'clear' && out.all) {
    throw new Error('--all is only supported with clear');
  }
  return out;
}

async function listRows(
  kb: string | undefined,
  deps: RunQuarantineDeps,
): Promise<Array<IngestQuarantineRecord & { kb: string }>> {
  const kbNames = kb === undefined ? await deps.listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR) : [kb];
  const rows: Array<IngestQuarantineRecord & { kb: string }> = [];
  for (const kbName of kbNames) {
    const kbPath = path.join(KNOWLEDGE_BASES_ROOT_DIR, kbName);
    const records = await deps.listIngestQuarantine(kbPath);
    for (const record of records) {
      rows.push({ kb: kbName, ...record });
    }
  }
  rows.sort((a, b) => `${a.kb}/${a.relative_path}`.localeCompare(`${b.kb}/${b.relative_path}`));
  return rows;
}

export function formatQuarantineMarkdown(
  rows: ReadonlyArray<IngestQuarantineRecord & { kb: string }>,
): string {
  if (rows.length === 0) return 'No quarantined ingest files.\n';
  const lines = [
    '| KB | Path | Category | Code | Retries | Next retry | Ack |',
    '| --- | --- | --- | --- | ---: | --- | --- |',
  ];
  for (const row of rows) {
    lines.push(
      `| ${escapeCell(row.kb)} | ${escapeCell(row.relative_path)} | ` +
        `${escapeCell(row.error_category)} | ${escapeCell(row.error_code)} | ` +
        `${row.retry_count} | ${escapeCell(row.next_retry_at)} | ${row.ack ? 'yes' : 'no'} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function escapeCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
