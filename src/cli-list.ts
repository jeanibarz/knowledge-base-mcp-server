import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { describeKnowledgeBase, listKnowledgeBases } from './kb-fs.js';

export const LIST_HELP = `kb list — list available knowledge bases

Usage:
  kb list [--describe|-v] [--format=md|json]

Reads \`KNOWLEDGE_BASES_ROOT_DIR\` and prints one knowledge-base name per
line (text format) or a JSON array (\`--format=json\`). Strictly read-only —
does not touch the FAISS index.

Options:
  --describe, -v        Append a one-line description sourced from each
                        KB's README.md. With \`--format=json\`, adds a
                        \`description\` field to each entry.
  --format=md|json      Output format (default: md). \`md\` is plain text;
                        \`json\` is a stable shape suitable for agent shells.
  --help, -h            Show this help.

Examples:
  kb list
  kb list --describe
  kb list --format=json
`;

interface ListArgs {
  describe: boolean;
  format: 'md' | 'json';
}

function parseListArgs(rest: string[]): ListArgs {
  let describe = false;
  let format: 'md' | 'json' = 'md';
  for (const arg of rest) {
    if (arg === '--describe' || arg === '-v') {
      describe = true;
      continue;
    }
    if (arg.startsWith('--format=')) {
      const value = arg.slice('--format='.length);
      if (value !== 'md' && value !== 'json') {
        throw new Error(`invalid --format value '${value}' (expected md or json)`);
      }
      format = value;
      continue;
    }
    throw new Error(`unknown option '${arg}'`);
  }
  return { describe, format };
}

export async function runList(rest: string[] = []): Promise<number> {
  let parsed: ListArgs;
  try {
    parsed = parseListArgs(rest);
  } catch (err) {
    process.stderr.write(`kb list: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    const kbs = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);

    if (parsed.format === 'json') {
      const items = parsed.describe
        ? await Promise.all(
            kbs.map(async (name) => ({
              name,
              description: await describeKnowledgeBase(KNOWLEDGE_BASES_ROOT_DIR, name),
            })),
          )
        : kbs.map((name) => ({ name }));
      process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
      return 0;
    }

    if (!parsed.describe) {
      for (const name of kbs) {
        process.stdout.write(`${name}\n`);
      }
      return 0;
    }

    const descriptions = await Promise.all(
      kbs.map((name) => describeKnowledgeBase(KNOWLEDGE_BASES_ROOT_DIR, name)),
    );
    const longest = kbs.reduce((max, n) => Math.max(max, n.length), 0);
    for (let i = 0; i < kbs.length; i++) {
      const desc = descriptions[i];
      if (desc.length === 0) {
        process.stdout.write(`${kbs[i]}\n`);
      } else {
        process.stdout.write(`${kbs[i].padEnd(longest)}   ${desc}\n`);
      }
    }
    return 0;
  } catch (err) {
    process.stderr.write(`kb list: ${(err as Error).message}\n`);
    return 1;
  }
}
