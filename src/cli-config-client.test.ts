import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
  findOnPath,
  parseConfigClientArgs,
  runConfigClient,
  shellQuote,
  SUPPORTED_CLIENTS,
  type ConfigClientReport,
} from './cli-config-client.js';
import { runConfig } from './cli-config.js';
import { resetProjectConfigForTests } from './config/project-config.js';
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

const JSON_CLIENTS = SUPPORTED_CLIENTS.filter((c) => c !== 'claude-code');

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

async function runJson(...args: string[]): Promise<ConfigClientReport> {
  stdout = '';
  const code = await runConfig(['client', ...args, '--format=json']);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  return JSON.parse(stdout) as ConfigClientReport;
}

function fencedBlock(markdown: string): string {
  const m = /```(?:json|bash)\n([\s\S]*?)\n```/.exec(markdown);
  if (m === null) throw new Error(`no fenced block in:\n${markdown}`);
  return m[1];
}

/** Runs the generated command in bash with a stub `claude` and returns its argv. */
function claudeArgv(command: string): string[] {
  const r = spawnSync('bash', ['-c', `claude() { printf '%s\\0' "$@"; }\n${command}`], { encoding: 'utf-8' });
  expect(r.status).toBe(0);
  return r.stdout.split('\0').slice(0, -1);
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
    const code = await runConfig(['client', 'emacs']);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('unknown client: emacs');
    for (const name of SUPPORTED_CLIENTS) expect(stderr).toContain(name);
  });

  it('exits 2 when the client name is missing or a flag is invalid', async () => {
    expect(await runConfig(['client'])).toBe(2);
    expect(stderr).toContain('supported clients: claude-desktop');
    expect(await runConfig(['client', 'cursor', '--command=bunx'])).toBe(2);
    expect(await runConfig(['client', 'cursor', '--format=yaml'])).toBe(2);
    expect(await runConfig(['client', 'cursor', 'cline'])).toBe(2);
  });
});

describe('kb config client: each supported client', () => {
  beforeEach(() => {
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.OPENAI_MODEL_NAME = 'text-embedding-3-large';
  });

  it.each(JSON_CLIENTS)('%s: markdown block is valid JSON with the effective settings', async (client) => {
    expect(await runConfig(['client', client])).toBe(0);
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
    expect(await runConfig(['client', 'claude-code'])).toBe(0);
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
            { resolveServerBin: () => bin },
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
    expect(await runConfig(['client', 'claude-code', '--command=global'])).toBe(0);
    expect(claudeArgv(fencedBlock(stdout)).slice(-2)).toEqual(['--', bin]);
  });

  it('exits 2 when the bin is not on PATH', async () => {
    const code = await runConfigClient(['cursor', '--command=global'], { resolveServerBin: () => null });
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
      { cwd: tempDir, encoding: 'utf-8', env: { ...process.env, EMBEDDING_PROVIDER: 'ollama', ...SECRETS } },
    );
    expect(result.stderr).not.toMatch(/unknown flag|Did you mean/);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as ConfigClientReport;
    expect(report.env.KNOWLEDGE_BASES_ROOT_DIR).toBe(kbRoot);
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
