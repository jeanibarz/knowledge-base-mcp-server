import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Guards the gap behind #1195: the typo guard, generated CLI reference and
// shell completions all derive from help text, so a flag a parser accepts but
// its help omits is invisible there (and can even be rejected by the guard).

// Jest runs from the project root (import.meta.url is unsupported here).
const SRC_DIR = join(process.cwd(), 'src');

// Flags a parser recognises only to reject or special-case, keyed by file.
// Each entry needs a reason; prefer documenting the flag over adding one.
const INTENTIONALLY_UNDOCUMENTED: Record<string, readonly string[]> = {
  // Matches flags of *other* commands' parsed manifests when building completions.
  'cli-completion.ts': ['--exclude-kb', '--include-kb', '--kb', '--llm-profile', '--model', '--profile'],
  // Recognised only to reject with a specific message (canonical logs hold hashes).
  'cli-diff-index.ts': ['--sample-logs'],
  // These are arguments passed to `git`, not kb flags.
  'cli-doctor.ts': ['--abbrev-ref', '--count', '--left-right', '--short'],
  // --owner is set internally by daemon autostart; --mode/--refresh are inspected
  // on forwarded `kb search` args and documented under `kb search`.
  'cli-serve.ts': ['--mode', '--owner', '--refresh'],
};

function helpAndCode(source: string): { help: string; code: string } {
  const helpRe = /export const \w*HELP\w* = `(?:\\[\s\S]|[^`\\])*`;/g;
  const help = (source.match(helpRe) ?? []).join('\n');
  return { help, code: source.replace(helpRe, '') };
}

function parserFlags(code: string): string[] {
  const flags = new Set<string>();
  for (const m of code.matchAll(/'(--[a-z][a-z0-9-]*)=?'/g)) flags.add(m[1]);
  return [...flags].sort();
}

const files = readdirSync(SRC_DIR)
  .filter((f) => /^cli-[a-z0-9-]+\.ts$/.test(f) && !f.endsWith('.test.ts'))
  .sort();

describe('CLI parser flags are documented in --help', () => {
  for (const file of files) {
    const { help, code } = helpAndCode(readFileSync(join(SRC_DIR, file), 'utf8'));
    if (help === '') continue;
    it(`${file}: every parsed --flag appears in its help text`, () => {
      const excluded = new Set(INTENTIONALLY_UNDOCUMENTED[file] ?? []);
      const missing = parserFlags(code).filter(
        (flag) => !excluded.has(flag) && !new RegExp(`${flag}(?![a-z0-9-])`).test(help),
      );
      expect(missing).toEqual([]);
    });
  }
});

describe('kb logs show --query-sha256 (spawned CLI)', () => {
  it('reaches the handler instead of being rejected by the typo guard', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-logs-1195-'));
    try {
      const file = join(dir, 'empty.log');
      writeFileSync(file, '');
      const result = spawnSync(
        process.execPath,
        [join(process.cwd(), 'build', 'cli.js'), 'logs', 'show', '--query-sha256=abc123', `--file=${file}`],
        { encoding: 'utf-8', env: { ...process.env, LOG_FILE: '' } },
      );
      const output = `${result.stdout}${result.stderr}`;
      expect(output).not.toMatch(/unknown flag|Did you mean/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
