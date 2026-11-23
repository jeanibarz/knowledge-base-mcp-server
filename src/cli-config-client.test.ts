import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  findOnPath,
  parseConfigClientArgs,
  runConfigClient,
  shellQuote,
  SUPPORTED_CLIENTS,
  tomlString,
  type ConfigClientReport,
} from './cli-config-client.js';
import { resetProjectConfigForTests } from './config/project-config.js';
import { deriveModelId } from './model-id.js';
import { makeTempDir } from './test-support/tempdir.js';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();
const tsxLoaderPath = path.join(ORIGINAL_CWD, 'node_modules', 'tsx', 'dist', 'loader.mjs');

// Fake, distinctive secret values. Built at runtime so secret scanners do not
// mistake the fixtures for committed credentials.
const fakeSecret = (name: string): string => ['fake', name, 'secret', 'value'].join('-');
const SECRETS = {
  OPENAI_API_KEY: fakeSecret('openai'),
  HUGGINGFACE_API_KEY: fakeSecret('huggingface'),
  MCP_AUTH_TOKEN: fakeSecret('mcp-auth'),
  KB_OPENROUTER_API_KEY: fakeSecret('openrouter'),
};

const JSON_CLIENTS = SUPPORTED_CLIENTS.filter((c) => c !== 'claude-code' && c !== 'codex');

let stdout = '';
let stderr = '';
let tempDir = '';
let kbRoot = '';

beforeEach(async () => {
  stdout = '';
  stderr = '';
  tempDir = await makeTempDir('kb-config-client-');
  // A root with a space proves the shell quoting and JSON escaping.
  kbRoot = path.join(tempDir, 'my kbs');
  // Hermetic: no inherited KB/provider vars, no project config above the temp dir.
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (/^(KB_|KNOWLEDGE_BASES|FAISS|EMBEDDING|OLLAMA|OPENAI|HUGGINGFACE|MCP_|OPENROUTER)/.test(name)) continue;
    env[name] = value;
  }
  process.env = { ...env, XDG_CONFIG_HOME: path.join(tempDir, 'xdg'), KNOWLEDGE_BASES_ROOT_DIR: kbRoot };
  process.chdir(tempDir);
  resetProjectConfigForTests();
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  });
  jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  process.chdir(ORIGINAL_CWD);
  process.env = { ...ORIGINAL_ENV };
  resetProjectConfigForTests();
  await fsp.rm(tempDir, { recursive: true, force: true });
});

// The unit tests pin "no registered model" so they never depend on the shared
// test index directory; the spawned-CLI tests exercise real resolution.
const NO_ACTIVE = { resolveActive: async () => null };
const run = (args: string[]): Promise<number> => runConfigClient(args, NO_ACTIVE);

async function runJson(...args: string[]): Promise<ConfigClientReport> {
  stdout = '';
  const code = await run([...args, '--format=json']);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  return JSON.parse(stdout) as ConfigClientReport;
}

function fencedBlock(markdown: string): string {
  const m = /```(?:json|bash|toml)\n([\s\S]*?)\n```/.exec(markdown);
  if (m === null) throw new Error(`no fenced block in:\n${markdown}`);
  return m[1];
}

/** Runs the generated command in bash with a stub `claude` and returns its argv. */
function claudeArgv(command: string): string[] {
  const r = spawnSync('bash', ['-c', `claude() { printf '%s\\0' "$@"; }\n${command}`], { encoding: 'utf-8' });
  expect(r.status).toBe(0);
  return r.stdout.split('\0').slice(0, -1);
}

type TomlTable = { [key: string]: string | string[] | TomlTable };

/**
 * Strict parser for the TOML subset `kb config client codex` emits: `[a.b]`
 * table headers, and `key = "basic string"` or `key = ["...", ...]` pairs.
 * It decodes escapes per the TOML 1.0 spec independently of tomlString and
 * throws on anything a real TOML parser would reject in that subset (raw
 * control characters, unknown escapes, unterminated strings, trailing junk,
 * duplicate keys), so the encoder cannot pass by sharing a bug with it.
 */
function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let table = root;
  const fail = (line: number, why: string): never => {
    throw new Error(`TOML line ${line + 1}: ${why}`);
  };
  const BARE = /^[A-Za-z0-9_-]+/;
  text.split('\n').forEach((raw, lineNo) => {
    let i = 0;
    const ws = (): void => { while (raw[i] === ' ' || raw[i] === '\t') i++; };
    const end = (): void => {
      ws();
      if (i < raw.length && raw[i] !== '#') fail(lineNo, `unexpected ${JSON.stringify(raw.slice(i))}`);
    };
    const basicString = (): string => {
      if (raw[i] !== '"') fail(lineNo, 'expected "');
      i++;
      let out = '';
      for (;;) {
        if (i >= raw.length) fail(lineNo, 'unterminated string');
        const ch = raw[i];
        const code = ch.charCodeAt(0);
        if (ch === '"') { i++; return out; }
        if ((code < 0x20 && ch !== '\t') || code === 0x7f) fail(lineNo, `raw control U+${code.toString(16)}`);
        if (ch !== '\\') { out += ch; i++; continue; }
        const esc = raw[i + 1];
        const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
        if (esc in simple) { out += simple[esc]; i += 2; continue; }
        if (esc === 'u' || esc === 'U') {
          const len = esc === 'u' ? 4 : 8;
          const hex = raw.slice(i + 2, i + 2 + len);
          if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) fail(lineNo, `bad \\${esc} escape`);
          out += String.fromCodePoint(parseInt(hex, 16));
          i += 2 + len;
          continue;
        }
        fail(lineNo, `invalid escape \\${esc}`);
      }
    };
    const key = (): string => {
      if (raw[i] === '"') return basicString();
      const m = BARE.exec(raw.slice(i));
      if (m === null) fail(lineNo, 'expected a key');
      i += m![0].length;
      return m![0];
    };
    ws();
    if (i >= raw.length || raw[i] === '#') return;
    if (raw[i] === '[') {
      i++;
      table = root;
      for (;;) {
        ws();
        const k = key();
        ws();
        const next = table[k] ?? {};
        if (typeof next !== 'object' || Array.isArray(next)) fail(lineNo, `${k} is not a table`);
        table[k] = next;
        table = next as TomlTable;
        if (raw[i] === '.') { i++; continue; }
        if (raw[i] === ']') { i++; break; }
        fail(lineNo, 'bad table header');
      }
      end();
      return;
    }
    const k = key();
    ws();
    if (raw[i] !== '=') fail(lineNo, 'expected =');
    i++;
    ws();
    if (k in table) fail(lineNo, `duplicate key ${k}`);
    if (raw[i] === '[') {
      i++;
      const items: string[] = [];
      ws();
      while (raw[i] !== ']') {
        items.push(basicString());
        ws();
        if (raw[i] === ',') { i++; ws(); } else if (raw[i] !== ']') fail(lineNo, 'expected , or ]');
      }
      i++;
      table[k] = items;
    } else {
      table[k] = basicString();
    }
    end();
  });
  return root;
}

function codexServer(toml: string): { command: string; args: string[]; env: Record<string, string> } {
  const parsed = parseToml(toml);
  expect(Object.keys(parsed)).toEqual(['mcp_servers']);
  const servers = parsed.mcp_servers as TomlTable;
  expect(Object.keys(servers)).toEqual(['knowledge-base']);
  const server = servers['knowledge-base'] as TomlTable;
  expect(Object.keys(server).sort()).toEqual(['args', 'command', 'env']);
  return server as unknown as { command: string; args: string[]; env: Record<string, string> };
}

function envFromClaudeArgv(argv: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '-e') continue;
    const pair = argv[i + 1];
    const eq = pair.indexOf('=');
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return env;
}

describe('kb config client: argument parsing', () => {
  it('parses a client name and flags', () => {
    expect(parseConfigClientArgs(['cursor'])).toEqual({ client: 'cursor', format: 'md', command: 'npx' });
    expect(parseConfigClientArgs(['vscode', '--format=json', '--command=global']))
      .toEqual({ client: 'vscode', format: 'json', command: 'global' });
  });

  it('exits 2 and lists supported names for an unknown client', async () => {
    const code = await run(['emacs']);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('unknown client: emacs');
    for (const name of SUPPORTED_CLIENTS) expect(stderr).toContain(name);
  });

  it('exits 2 when the client name is missing or a flag is invalid', async () => {
    expect(await run([])).toBe(2);
    expect(stderr).toContain('supported clients: claude-desktop');
    expect(await run(['cursor', '--command=bunx'])).toBe(2);
    expect(await run(['cursor', '--format=yaml'])).toBe(2);
    expect(await run(['cursor', 'cline'])).toBe(2);
  });
});

describe('kb config client: each supported client', () => {
  beforeEach(() => {
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_MODEL_NAME = 'text-embedding-3-large';
  });

  it.each(JSON_CLIENTS)('%s: markdown block is valid JSON with the effective settings', async (client) => {
    expect(await run([client])).toBe(0);
    const parsed = JSON.parse(fencedBlock(stdout)) as Record<string, Record<string, Record<string, unknown>>>;
    const key = client === 'vscode' ? 'servers' : 'mcpServers';
    expect(Object.keys(parsed)).toEqual([key]);
    const server = parsed[key]['knowledge-base'];
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', '@jeanibarz/knowledge-base-mcp-server@latest']);
    if (client === 'vscode') expect(server.type).toBe('stdio');
    else expect(server.type).toBeUndefined();
    expect(server.env).toEqual({
      KNOWLEDGE_BASES_ROOT_DIR: kbRoot,
      EMBEDDING_PROVIDER: 'openai',
      OPENAI_API_KEY: '<OPENAI_API_KEY>',
      OPENAI_MODEL_NAME: 'text-embedding-3-large',
    });
    expect(stdout).toContain('Replace these placeholders before use: <OPENAI_API_KEY>');
  });

  it.each(JSON_CLIENTS)('%s: --format=json snippet matches the structured fields', async (client) => {
    const report = await runJson(client);
    expect(report.schema_version).toBe('kb.config-client.v1');
    expect(report.client).toBe(client);
    expect(report.config_locations.length).toBeGreaterThan(0);
    const parsed = JSON.parse(report.snippet) as Record<string, Record<string, Record<string, unknown>>>;
    const server = parsed[report.shape]['knowledge-base'];
    expect(server.env).toEqual(report.env);
    expect(server.command).toBe(report.command);
    expect(server.args).toEqual(report.args);
  });

  it('claude-code: the command line parses in a shell and carries the effective settings', async () => {
    expect(await run(['claude-code'])).toBe(0);
    const argv = claudeArgv(fencedBlock(stdout));
    expect(argv.slice(0, 4)).toEqual(['mcp', 'add', 'knowledge-base', '-s']);
    expect(argv.slice(-4)).toEqual(['--', 'npx', '-y', '@jeanibarz/knowledge-base-mcp-server@latest']);
    expect(envFromClaudeArgv(argv)).toEqual({
      KNOWLEDGE_BASES_ROOT_DIR: kbRoot,
      EMBEDDING_PROVIDER: 'openai',
      OPENAI_API_KEY: '<OPENAI_API_KEY>',
      OPENAI_MODEL_NAME: 'text-embedding-3-large',
    });

    const report = await runJson('claude-code');
    expect(report.shape).toBe('shell');
    expect(envFromClaudeArgv(claudeArgv(report.snippet))).toEqual(report.env);
  });
});

describe('kb config client codex (TOML)', () => {
  beforeEach(() => {
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_MODEL_NAME = 'text-embedding-3-large';
  });

  it('markdown block is a TOML table with the effective settings', async () => {
    expect(await run(['codex'])).toBe(0);
    expect(stdout).toContain('```toml\n[mcp_servers.knowledge-base]\n');
    expect(stdout).toContain('~/.codex/config.toml');
    expect(stdout).toContain('Replace these placeholders before use: <OPENAI_API_KEY>');
    expect(stdout).toContain('no restart is needed');
    expect(stdout).not.toContain('Restart the client');
    const server = codexServer(fencedBlock(stdout));
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', '@jeanibarz/knowledge-base-mcp-server@latest']);
    expect(server.env).toEqual({
      KNOWLEDGE_BASES_ROOT_DIR: kbRoot,
      EMBEDDING_PROVIDER: 'openai',
      OPENAI_API_KEY: '<OPENAI_API_KEY>',
      OPENAI_MODEL_NAME: 'text-embedding-3-large',
    });
  });

  it('--format=json reports shape "toml" and a snippet matching the structured fields', async () => {
    const report = await runJson('codex');
    expect(report.client).toBe('codex');
    expect(report.shape).toBe('toml');
    expect(report.placeholders).toEqual(['OPENAI_API_KEY']);
    const server = codexServer(report.snippet);
    expect(server.command).toBe(report.command);
    expect(server.args).toEqual(report.args);
    expect(server.env).toEqual(report.env);
  });

  it('round-trips a root with backslashes, quotes and control characters', async () => {
    // A Windows-style path segment plus every character TOML forces us to escape.
    const nasty = path.join(tempDir, 'C:\\Users\\me "quoted"\\kb\ttab\u0001\u007f\\\\end');
    process.env.KNOWLEDGE_BASES_ROOT_DIR = nasty;
    const report = await runJson('codex');
    expect(report.env.KNOWLEDGE_BASES_ROOT_DIR).toBe(nasty);
    expect(codexServer(report.snippet).env.KNOWLEDGE_BASES_ROOT_DIR).toBe(nasty);
  });

  it('round-trips an absolute --command=global bin path containing backslashes', async () => {
    const bin = 'C:\\Program Files\\nodejs\\knowledge-base-mcp-server.cmd';
    stdout = '';
    expect(await runConfigClient(['codex', '--format=json', '--command=global'], {
      ...NO_ACTIVE,
      resolveServerBin: () => bin,
    })).toBe(0);
    const server = codexServer((JSON.parse(stdout) as ConfigClientReport).snippet);
    expect(server.command).toBe(bin);
    expect(server.args).toEqual([]);
  });

  it('tomlString escapes exactly what TOML requires', () => {
    expect(tomlString('plain /path')).toBe('"plain /path"');
    expect(tomlString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(tomlString('\b\t\n\f\r')).toBe('"\\b\\t\\n\\f\\r"');
    expect(tomlString('\u0000\u001f\u007f')).toBe('"\\u0000\\u001F\\u007F"');
    expect(tomlString('é 日本')).toBe('"é 日本"');
  });

  it('the test parser rejects invalid TOML (guards against a vacuous round-trip)', () => {
    expect(() => parseToml('a = "x\\qy"')).toThrow('invalid escape');
    expect(() => parseToml('a = "x\u0001"')).toThrow('raw control');
    expect(() => parseToml('a = "x')).toThrow('unterminated');
    expect(() => parseToml('a = "x" junk')).toThrow('unexpected');
    expect(() => parseToml('a = "x"\na = "y"')).toThrow('duplicate');
  });
});

describe('kb config client: provider and layering', () => {
  it('uses the ollama provider defaults with no secret placeholder', async () => {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    const report = await runJson('claude-desktop');
    expect(report.env).toEqual({
      KNOWLEDGE_BASES_ROOT_DIR: kbRoot,
      EMBEDDING_PROVIDER: 'ollama',
      OLLAMA_BASE_URL: 'http://localhost:11434',
      OLLAMA_MODEL: 'dengcao/Qwen3-Embedding-0.6B:Q8_0',
    });
    expect(report.placeholders).toEqual([]);
  });

  it('defaults to huggingface and emits non-default extras only when set', async () => {
    let report = await runJson('cursor');
    expect(report.env.EMBEDDING_PROVIDER).toBe('huggingface');
    expect(report.env.HUGGINGFACE_API_KEY).toBe('<HUGGINGFACE_API_KEY>');
    expect(report.env.HUGGINGFACE_MODEL_NAME).toEqual(expect.any(String));
    expect(report.env).not.toHaveProperty('FAISS_INDEX_PATH');
    expect(report.env).not.toHaveProperty('KB_ACTIVE_MODEL');

    process.env.FAISS_INDEX_PATH = path.join(tempDir, 'faiss');
    process.env.KB_ACTIVE_MODEL = 'huggingface__bge';
    report = await runJson('cursor');
    expect(report.env.FAISS_INDEX_PATH).toBe(path.join(tempDir, 'faiss'));
    expect(report.env.KB_ACTIVE_MODEL).toBe('huggingface__bge');
  });

  it('reads provider and model from the project config file, like kb config show', async () => {
    await fsp.writeFile(
      path.join(tempDir, '.kbrc'),
      JSON.stringify({ EMBEDDING_PROVIDER: 'ollama', OLLAMA_MODEL: 'nomic-embed-text' }),
    );
    resetProjectConfigForTests();
    const report = await runJson('windsurf');
    expect(report.config_file).toBe(path.join(tempDir, '.kbrc'));
    expect(report.env.EMBEDDING_PROVIDER).toBe('ollama');
    expect(report.env.OLLAMA_MODEL).toBe('nomic-embed-text');
  });
});

describe('kb config client: defaults, extras and failures', () => {
  it('prints the default root when KNOWLEDGE_BASES_ROOT_DIR is unset', async () => {
    delete process.env.KNOWLEDGE_BASES_ROOT_DIR;
    const report = await runJson('cursor');
    expect(report.env.KNOWLEDGE_BASES_ROOT_DIR).toBe(path.join(os.homedir(), 'knowledge_bases'));
  });

  it('prints provider extras only when set', async () => {
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_ORG_ID = 'org-123';
    process.env.OPENAI_BASE_URL = 'https://proxy.example/v1';
    let report = await runJson('cursor');
    expect(report.env.OPENAI_ORG_ID).toBe('org-123');
    expect(report.env.OPENAI_BASE_URL).toBe('https://proxy.example/v1');
    expect(report.env).not.toHaveProperty('OPENAI_PROJECT_ID');

    process.env.EMBEDDING_PROVIDER = 'huggingface';
    process.env.HUGGINGFACE_ENDPOINT_URL = 'https://hf.example/embed';
    report = await runJson('cursor');
    expect(report.env.HUGGINGFACE_ENDPOINT_URL).toBe('https://hf.example/embed');
    expect(report.env).not.toHaveProperty('HUGGINGFACE_PROVIDER');
  });

  it('exits 2 for an unsupported EMBEDDING_PROVIDER', async () => {
    process.env.EMBEDDING_PROVIDER = 'bogus';
    expect(await run(['cursor'])).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('unsupported EMBEDDING_PROVIDER="bogus"');
  });

  it('exits 2 for an unreadable project config', async () => {
    await fsp.writeFile(path.join(tempDir, '.kbrc'), '{not json');
    resetProjectConfigForTests();
    expect(await run(['cursor'])).toBe(2);
    expect(stderr).toContain('invalid project config');
  });

  it('tells JSON-client users to restart, but not claude-code users', async () => {
    expect(await run(['cursor'])).toBe(0);
    expect(stdout).toContain('Restart the client');
    stdout = '';
    expect(await run(['claude-code'])).toBe(0);
    expect(stdout).not.toContain('Restart the client');
  });
});

describe('kb config client: active model and value hygiene', () => {
  it('follows the registered active model, not EMBEDDING_PROVIDER', async () => {
    stdout = '';
    const code = await runConfigClient(['cursor', '--format=json'], {
      resolveActive: async () => ({ id: 'openai__text-embedding-3-large', provider: 'openai', modelName: 'text-embedding-3-large' }),
    });
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as ConfigClientReport;
    expect(report.active_model).toBe('openai__text-embedding-3-large');
    expect(report.env).toEqual({
      KNOWLEDGE_BASES_ROOT_DIR: kbRoot,
      EMBEDDING_PROVIDER: 'openai',
      OPENAI_API_KEY: '<OPENAI_API_KEY>',
      OPENAI_MODEL_NAME: 'text-embedding-3-large',
    });
  });

  it('makes relative and ~ paths absolute', async () => {
    process.env.KNOWLEDGE_BASES_ROOT_DIR = './kb';
    process.env.FAISS_INDEX_PATH = '~/idx';
    const report = await runJson('cline');
    expect(report.env.KNOWLEDGE_BASES_ROOT_DIR).toBe(path.join(process.cwd(), 'kb'));
    expect(path.isAbsolute(report.env.FAISS_INDEX_PATH)).toBe(true);
    expect(report.env.FAISS_INDEX_PATH).not.toContain('~');
  });

  it('replaces URLs that embed credentials or a query string with placeholders', async () => {
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_BASE_URL = 'https://user:SECRET-in-url@proxy.example/v1';
    let report = await runJson('cursor');
    expect(report.env.OPENAI_BASE_URL).toBe('<OPENAI_BASE_URL>');
    expect(report.placeholders).toContain('OPENAI_BASE_URL');
    expect(JSON.stringify(report)).not.toContain('SECRET-in-url');

    process.env.OPENAI_BASE_URL = 'https://proxy.example/v1';
    report = await runJson('cursor');
    expect(report.env.OPENAI_BASE_URL).toBe('https://proxy.example/v1');
  });
});

describe('kb config client: secrets are never printed', () => {
  it.each(['openai', 'huggingface', 'ollama'])('provider %s: no secret value in any client, format or command mode', async (provider) => {
    Object.assign(process.env, SECRETS, { EMBEDDING_PROVIDER: provider });
    const bin = path.join(tempDir, 'bin', 'knowledge-base-mcp-server');
    for (const client of SUPPORTED_CLIENTS) {
      for (const format of ['md', 'json']) {
        for (const command of ['npx', 'global']) {
          stdout = '';
          const code = await runConfigClient(
            [client, `--format=${format}`, `--command=${command}`],
            { ...NO_ACTIVE, resolveServerBin: () => bin },
          );
          expect(code).toBe(0);
          for (const secret of Object.values(SECRETS)) expect(stdout).not.toContain(secret);
          expect(stdout).not.toContain('MCP_AUTH_TOKEN');
        }
      }
    }
    if (provider !== 'ollama') {
      const keyVar = provider === 'openai' ? 'OPENAI_API_KEY' : 'HUGGINGFACE_API_KEY';
      expect((await runJson('cline')).env[keyVar]).toBe(`<${keyVar}>`);
    }
  });
});

describe('kb config client --command=global', () => {
  it('writes the absolute bin path found on PATH', async () => {
    const binDir = path.join(tempDir, 'global bin');
    await fsp.mkdir(binDir);
    const bin = path.join(binDir, 'knowledge-base-mcp-server');
    await fsp.writeFile(bin, '#!/bin/sh\n', { mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;

    const report = await runJson('vscode', '--command=global');
    expect(report.command_mode).toBe('global');
    expect(report.command).toBe(bin);
    expect(report.args).toEqual([]);

    stdout = '';
    expect(await run(['claude-code', '--command=global'])).toBe(0);
    expect(claudeArgv(fencedBlock(stdout)).slice(-2)).toEqual(['--', bin]);
  });

  it('exits 2 when the bin is not on PATH', async () => {
    const code = await runConfigClient(['cursor', '--command=global'], { ...NO_ACTIVE, resolveServerBin: () => null });
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('knowledge-base-mcp-server not found on PATH');
  });

  it('findOnPath skips non-executable files and missing dirs', async () => {
    const dir = path.join(tempDir, 'p');
    await fsp.mkdir(dir);
    await fsp.writeFile(path.join(dir, 'tool'), '', { mode: 0o644 });
    expect(findOnPath('tool', `${path.join(tempDir, 'missing')}${path.delimiter}${dir}`, 'linux')).toBeNull();
    await fsp.chmod(path.join(dir, 'tool'), 0o755);
    expect(findOnPath('tool', dir, 'linux')).toBe(path.join(dir, 'tool'));
  });

  it('findOnPath tries .cmd on win32', async () => {
    const dir = path.join(tempDir, 'w');
    await fsp.mkdir(dir);
    await fsp.writeFile(path.join(dir, 'tool.cmd'), '');
    expect(findOnPath('tool', dir, 'win32')).toBe(path.join(dir, 'tool.cmd'));
  });

  it('findOnPath skips npx caches and node_modules/.bin', async () => {
    const npxBin = path.join(tempDir, '_npx', 'abc', 'node_modules', '.bin');
    const localBin = path.join(tempDir, 'repo', 'node_modules', '.bin');
    const globalBin = path.join(tempDir, 'global');
    for (const dir of [npxBin, localBin, globalBin]) {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'tool'), '', { mode: 0o755 });
    }
    const envPath = [npxBin, localBin, globalBin].join(path.delimiter);
    expect(findOnPath('tool', envPath, 'linux')).toBe(path.join(globalBin, 'tool'));
  });
});

describe('shellQuote', () => {
  it('leaves safe words alone and single-quotes the rest', () => {
    expect(shellQuote('EMBEDDING_PROVIDER=ollama')).toBe('EMBEDDING_PROVIDER=ollama');
    expect(shellQuote('A=<KEY>')).toBe("'A=<KEY>'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe('kb config client (spawned CLI)', () => {
  it('passes the CLI typo guard and prints JSON', () => {
    const result = spawnSync(
      process.execPath,
      ['--enable-source-maps', '--import', tsxLoaderPath, path.join(ORIGINAL_CWD, 'src', 'cli.ts'),
        'config', 'client', 'cursor', '--format=json', '--command=npx'],
      { cwd: tempDir, encoding: 'utf-8', env: { ...process.env, EMBEDDING_PROVIDER: 'openai', ...SECRETS } },
    );
    expect(result.stderr).not.toMatch(/unknown flag|Did you mean/);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as ConfigClientReport;
    expect(report.env.KNOWLEDGE_BASES_ROOT_DIR).toBe(kbRoot);
    expect(report.env.OPENAI_API_KEY).toBe('<OPENAI_API_KEY>');
    for (const secret of Object.values(SECRETS)) expect(result.stdout).not.toContain(secret);
  });

  it('uses the provider of the model registered in active.txt', async () => {
    const faiss = path.join(tempDir, 'faiss');
    const id = deriveModelId('openai', 'text-embedding-3-large');
    await fsp.mkdir(path.join(faiss, 'models', id), { recursive: true });
    await fsp.writeFile(path.join(faiss, 'models', id, 'model_name.txt'), 'text-embedding-3-large\n');
    await fsp.writeFile(path.join(faiss, 'active.txt'), `${id}\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, FAISS_INDEX_PATH: faiss, ...SECRETS };
    delete env.EMBEDDING_PROVIDER;
    const result = spawnSync(
      process.execPath,
      ['--enable-source-maps', '--import', tsxLoaderPath, path.join(ORIGINAL_CWD, 'src', 'cli.ts'),
        'config', 'client', 'vscode', '--format=json'],
      { cwd: tempDir, encoding: 'utf-8', env },
    );
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as ConfigClientReport;
    expect(report.active_model).toBe(id);
    expect(report.env.EMBEDDING_PROVIDER).toBe('openai');
    expect(report.env.OPENAI_MODEL_NAME).toBe('text-embedding-3-large');
    expect(report.env.OPENAI_API_KEY).toBe('<OPENAI_API_KEY>');
    expect(report.env).not.toHaveProperty('HUGGINGFACE_API_KEY');
    for (const secret of Object.values(SECRETS)) expect(result.stdout).not.toContain(secret);
  });

  it('exits 2 for an unknown client', () => {
    const result = spawnSync(
      process.execPath,
      ['--enable-source-maps', '--import', tsxLoaderPath, path.join(ORIGINAL_CWD, 'src', 'cli.ts'),
        'config', 'client', 'nope'],
      { cwd: tempDir, encoding: 'utf-8', env: process.env },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('supported clients:');
  });
});
