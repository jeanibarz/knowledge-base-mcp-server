import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import { KBError } from './errors.js';
import { KnowledgeBaseExistsError, createKnowledgeBase } from './kb-fs.js';

export const INIT_HELP = `kb init — create a new, empty knowledge base

Usage:
  kb init <name> [--format=md|json]

Creates a new knowledge-base directory named <name> under
\`KNOWLEDGE_BASES_ROOT_DIR\` so that \`kb remember\`, \`kb capture\`, and the MCP
\`add_document\` tool can immediately write into it. Until now the only way to
start a fresh shelf was a manual \`mkdir\`; every write path throws
\`KB_NOT_FOUND\` for a directory that does not exist yet.

The shelf is left empty — no index is built and no files are added — so the
first write behaves exactly as it would for any existing KB (least surprise).

The name is validated with the same rules the read and write surfaces use to
address a KB: it must not be empty, start with ".", contain a path separator
(\`/\` or \`\\\`), or be an absolute path. Re-running with a name that already
exists errors instead of clobbering the existing shelf.

Options:
  --format=md|json      Output format (default: md). \`md\` prints the created
                        directory path; \`json\` prints an object with
                        \`knowledge_base_name\`, \`path\`, and \`created\`.
  --help, -h            Show this help.

Exit codes:
  0   the knowledge base was created
  1   a knowledge base with that name already exists (or another runtime error)
  2   missing / extra arguments, or an unsafe name

Examples:
  kb init new-topic
  kb init research --format=json
`;

interface InitArgs {
  name: string;
  format: 'md' | 'json';
}

function parseInitArgs(rest: string[]): InitArgs {
  let name: string | undefined;
  let format: 'md' | 'json' = 'md';
  for (const arg of rest) {
    if (arg.startsWith('--format=')) {
      const value = arg.slice('--format='.length);
      if (value !== 'md' && value !== 'json') {
        throw new Error(`invalid --format value '${value}' (expected md or json)`);
      }
      format = value;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`unknown option '${arg}'`);
    }
    if (name !== undefined) {
      throw new Error(`unexpected argument '${arg}' (kb init takes a single <name>)`);
    }
    name = arg;
  }
  if (name === undefined || name === '') {
    throw new Error('missing <name> (usage: kb init <name>)');
  }
  return { name, format };
}

export async function runInit(rest: string[] = []): Promise<number> {
  let parsed: InitArgs;
  try {
    parsed = parseInitArgs(rest);
  } catch (err) {
    process.stderr.write(`kb init: ${(err as Error).message}\n`);
    return 2;
  }

  let kbDir: string;
  try {
    kbDir = await createKnowledgeBase(KNOWLEDGE_BASES_ROOT_DIR, parsed.name);
  } catch (err) {
    if (err instanceof KnowledgeBaseExistsError) {
      process.stderr.write(`kb init: ${err.message}\n`);
      return 1;
    }
    if (err instanceof KBError && err.code === 'VALIDATION') {
      // Unsafe / malformed name — an argument problem, not a runtime failure.
      process.stderr.write(`kb init: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`kb init: ${(err as Error).message}\n`);
    return 1;
  }

  if (parsed.format === 'json') {
    process.stdout.write(`${JSON.stringify({
      knowledge_base_name: parsed.name,
      path: kbDir,
      created: true,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`Created knowledge base "${parsed.name}" at ${kbDir}\n`);
  }
  return 0;
}
