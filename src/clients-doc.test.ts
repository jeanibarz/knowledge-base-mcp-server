import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

import { PACKAGE_SPEC } from './cli-config-client.js';
import { CONFIG_SCHEMA } from './config/schema.js';

// docs/clients.md holds the hand-written, copy-paste client recipes. Nothing
// generates them, so they drift whenever a default changes (issue #1303: the
// snippets kept `all-MiniLM-L6-v2`, `text-embedding-ada-002` and the bare
// package spec long after #47 / PR #98). This test pins every config snippet
// to the values the source of truth uses today:
//   - the package spec comes from `PACKAGE_SPEC`, which `kb config client` emits;
//   - each model value comes from the default registered in `CONFIG_SCHEMA`.
// So the next default-model change fails here instead of leaving the doc stale.

const CLIENTS_DOC_PATH = path.join('docs', 'clients.md');
const PACKAGE_NAME = PACKAGE_SPEC.replace(/@[^@/]+$/, ''); // '@scope/name'
// Every fenced block is a snippet that could carry a stale config value, whatever
// its language tag (json, toml, bash, yaml, text, untagged, ...). The one
// exception is a fenced Markdown file (the Claude Code skill wrapper), which is
// prose, not client config.
const PROSE_LANGS = new Set(['markdown', 'md']);
// An opening or closing fence. Leading whitespace is allowed so a fence nested in
// a list item is still found; group 1 is the info string (language tag).
const FENCE_PATTERN = /^[ \t]*```(\S*)\s*$/;

// Env vars that pick an embedding model: every `*_MODEL_NAME` plus OLLAMA_MODEL.
const MODEL_VAR_PATTERN = /^(?:[A-Z0-9_]+_MODEL_NAME|OLLAMA_MODEL)$/;

function defaultModels(): Map<string, string> {
  const defaults = new Map<string, string>();
  for (const spec of CONFIG_SCHEMA) {
    if (MODEL_VAR_PATTERN.test(spec.name) && typeof spec.default === 'string') {
      defaults.set(spec.name, spec.default);
    }
  }
  return defaults;
}

interface Snippet {
  lang: string;
  line: number; // 1-based line of the opening fence
  body: string;
}

function extractSnippets(markdown: string): Snippet[] {
  const snippets: Snippet[] = [];
  const lines = markdown.split('\n');
  let open: { lang: string; line: number; body: string[] } | null = null;
  lines.forEach((text, index) => {
    const fence = FENCE_PATTERN.exec(text);
    // A fence with an info string cannot close a block (CommonMark), so inside an
    // open block it is plain content.
    if (!fence || (open && fence[1] !== '')) {
      open?.body.push(text);
      return;
    }
    if (open) {
      if (!PROSE_LANGS.has(open.lang)) {
        snippets.push({ lang: open.lang, line: open.line, body: open.body.join('\n') });
      }
      open = null;
    } else {
      open = { lang: fence[1].toLowerCase(), line: index + 1, body: [] };
    }
  });
  return snippets;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Returns one human-readable problem per stale value found in the doc's snippets. */
function findSnippetDrift(markdown: string): string[] {
  const problems: string[] = [];
  const defaults = defaultModels();
  // The package name followed by an optional `@version` / `@tag` suffix.
  const packageRef = new RegExp(`${escapeRegExp(PACKAGE_NAME)}(@[\\w.-]+)?`, 'g');
  // `"VAR": "value"` (JSON), `VAR = "value"` (TOML) or `VAR=value` (shell).
  const modelAssignment = /\b([A-Z][A-Z0-9_]*)"?\s*[:=]\s*"?([^"\s,]+)/g;

  for (const snippet of extractSnippets(markdown)) {
    const where = `docs/clients.md ${snippet.lang || 'untagged'} block at line ${snippet.line}`;
    for (const match of snippet.body.matchAll(packageRef)) {
      if (match[0] !== PACKAGE_SPEC) {
        problems.push(`${where}: launches "${match[0]}", expected "${PACKAGE_SPEC}"`);
      }
    }
    for (const match of snippet.body.matchAll(modelAssignment)) {
      const [, name, value] = match;
      if (!MODEL_VAR_PATTERN.test(name)) continue;
      const expected = defaults.get(name);
      if (expected === undefined) {
        problems.push(`${where}: ${name} has no registered default in CONFIG_SCHEMA`);
      } else if (value !== expected) {
        problems.push(`${where}: ${name}="${value}", expected the current default "${expected}"`);
      }
    }
  }
  return problems;
}

function readClientsDoc(): string {
  return fs.readFileSync(path.join(process.cwd(), CLIENTS_DOC_PATH), 'utf8');
}

describe('docs/clients.md snippet parity', () => {
  it('reads the defaults it checks against from source', () => {
    expect(PACKAGE_SPEC).toMatch(/@latest$/);
    const defaults = defaultModels();
    for (const name of ['HUGGINGFACE_MODEL_NAME', 'OPENAI_MODEL_NAME', 'OLLAMA_MODEL']) {
      expect(defaults.get(name)).toEqual(expect.any(String));
    }
  });

  it('actually inspects the client snippets (guards against a vacuous pass)', () => {
    const doc = readClientsDoc();
    const bodies = extractSnippets(doc).map((snippet) => snippet.body).join('\n');
    expect(bodies.split(PACKAGE_SPEC).length - 1).toBeGreaterThanOrEqual(10);
    for (const name of defaultModels().keys()) {
      expect(bodies).toContain(name);
    }
  });

  it('every snippet launches PACKAGE_SPEC and uses the current default models', () => {
    expect(findSnippetDrift(readClientsDoc())).toEqual([]);
  });

  describe('fails when a stale value is put back', () => {
    const doc = readClientsDoc();
    const defaults = defaultModels();

    it.each([
      [
        'unversioned package spec in an args array',
        `"args": ["-y", "${PACKAGE_SPEC}"]`,
        `"args": ["-y", "${PACKAGE_NAME}"]`,
      ],
      ['unversioned package spec in a shell command', `npx -y ${PACKAGE_SPEC}`, `npx -y ${PACKAGE_NAME}`],
      ['pinned old version', `"args": ["-y", "${PACKAGE_SPEC}"]`, `"args": ["-y", "${PACKAGE_NAME}@0.1.0"]`],
      [
        'old HuggingFace default',
        `"HUGGINGFACE_MODEL_NAME": "${defaults.get('HUGGINGFACE_MODEL_NAME')}"`,
        '"HUGGINGFACE_MODEL_NAME": "sentence-transformers/all-MiniLM-L6-v2"',
      ],
      [
        'old OpenAI default (JSON)',
        `"OPENAI_MODEL_NAME": "${defaults.get('OPENAI_MODEL_NAME')}"`,
        '"OPENAI_MODEL_NAME": "text-embedding-ada-002"',
      ],
      [
        'old OpenAI default (TOML)',
        `OPENAI_MODEL_NAME = "${defaults.get('OPENAI_MODEL_NAME')}"`,
        'OPENAI_MODEL_NAME = "text-embedding-ada-002"',
      ],
      [
        'non-default Ollama model (shell -e flag)',
        `-e OLLAMA_MODEL=${defaults.get('OLLAMA_MODEL')}`,
        '-e OLLAMA_MODEL=nomic-embed-text',
      ],
    ])('%s', (_label, current, stale) => {
      expect(doc).toContain(current);
      const mutated = doc.replace(current, stale);
      const problems = findSnippetDrift(mutated);
      expect(problems).toHaveLength(1);
    });

    it.each([
      ['an indented fence (inside a list item)', '   ```json', '   ```'],
      ['an untagged fence', '```', '```'],
      ['a yaml fence', '```yaml', '```'],
      ['a text fence', '```text', '```'],
    ])('checks a stale snippet in %s', (_label, opening, closing) => {
      const indent = /^\s*/.exec(opening)?.[0] ?? '';
      const snippet = [
        opening,
        `${indent}npx -y ${PACKAGE_NAME}`,
        `${indent}OPENAI_MODEL_NAME: text-embedding-ada-002`,
        closing,
      ].join('\n');
      expect(findSnippetDrift(`${doc}\n\n1. Item:\n\n${snippet}\n`)).toHaveLength(2);
    });

    it('skips a fenced markdown file (prose, not client config)', () => {
      const snippet = ['```markdown', `Run \`npx -y ${PACKAGE_NAME}\`.`, '```'].join('\n');
      expect(findSnippetDrift(`${doc}\n\n${snippet}\n`)).toEqual([]);
    });

    it('treats a tagged fence line inside an open block as content, not a close', () => {
      const snippet = ['```', '```json', `npx -y ${PACKAGE_NAME}`, '```'].join('\n');
      expect(findSnippetDrift(`${doc}\n\n${snippet}\n`)).toHaveLength(1);
    });

    it('ignores prose outside fenced snippets', () => {
      const prose = `${doc}\n\nOlder releases used \`${PACKAGE_NAME}\` with text-embedding-ada-002.\n`;
      expect(findSnippetDrift(prose)).toEqual([]);
    });
  });
});

describe('docs/clients.md Continue and JetBrains sections (issue #1310)', () => {
  const doc = readClientsDoc();

  it('drops the deprecated Continue config.json recipe', () => {
    expect(doc).not.toContain('modelContextProtocolServers');
    expect(doc).not.toContain('~/.continue/config.json');
  });

  it('no longer lists Continue or JetBrains as not generated', () => {
    const notGenerated = doc.split('\n').filter((line) => line.includes('not generated'));
    expect(notGenerated.length).toBeGreaterThan(0);
    for (const line of notGenerated) expect(line).not.toMatch(/Continue|JetBrains/);
  });

  it('shows the Continue recipe as a v1 block file with one server entry', () => {
    const start = doc.indexOf('## Continue\n');
    const section = doc.slice(start, doc.indexOf('\n## ', start + 1));
    const block = extractSnippets(section).find((snippet) => snippet.lang === 'yaml');
    if (block === undefined) throw new Error('no yaml block in the Continue section');
    const parsed = yaml.load(block.body) as { schema: string; mcpServers: Array<Record<string, unknown>> };
    expect(parsed.schema).toBe('v1');
    expect(parsed.mcpServers).toHaveLength(1);
    expect(parsed.mcpServers[0]).toMatchObject({ name: 'knowledge-base', command: 'npx', args: ['-y', PACKAGE_SPEC] });
  });
});
