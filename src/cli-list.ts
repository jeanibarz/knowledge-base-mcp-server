import { KNOWLEDGE_BASES_ROOT_DIR } from './config.js';
import { listKnowledgeBases } from './kb-fs.js';

export async function runList(): Promise<number> {
  try {
    const kbs = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
    for (const name of kbs) {
      process.stdout.write(`${name}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`kb list: ${(err as Error).message}\n`);
    return 1;
  }
}
