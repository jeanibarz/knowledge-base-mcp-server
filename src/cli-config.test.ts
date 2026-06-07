import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  formatConfigShowMarkdown,
  formatConfigValidateMarkdown,
  parseConfigArgs,
  runConfig,
} from './cli-config.js';

const ORIGINAL_ENV = { ...process.env };
const cliPath = path.join(process.cwd(), 'build', 'cli.js');

let stdout = '';
let stderr = '';
let tempDir = '';

beforeEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  stdout = '';
  stderr = '';
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-config-validate-'));
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
  process.env = { ...ORIGINAL_ENV };
  await fsp.rm(tempDir, { recursive: true, force: true });
});

describe('kb config validate (FR-OBS-470)', () => {
  it('parses the validate action and supported flags', () => {
    expect(parseConfigArgs(['validate', '--file=.env', '--format=json'])).toEqual({
      action: 'validate',
      file: '.env',
      format: 'json',
      nonDefaultOnly: false,
    });
    expect(parseConfigArgs(['validate'])).toEqual({ action: 'validate', format: 'md', nonDefaultOnly: false });
    expect(() => parseConfigArgs(['unknown'])).toThrow(/unknown action/);
    expect(() => parseConfigArgs(['validate', '--format=yaml'])).toThrow(/invalid --format/);
    expect(() => parseConfigArgs(['validate', '--non-default-only'])).toThrow(/only supported by show/);
  });

  it('writes JSON and exits 0 when the supplied dotenv file is valid', async () => {
    const dotenv = path.join(tempDir, '.env');
    await fsp.writeFile(dotenv, [
      'EMBEDDING_PROVIDER=fake',
      'KB_RERANK=on',
      'KB_RERANK_MODEL=Xenova/ms-marco-MiniLM-L-6-v2',
      'KB_RERANK_TOP_N=7',
      'MCP_TRANSPORT=http',
      `MCP_AUTH_TOKEN=${'a'.repeat(32)}`,
    ].join('\n'));

    await expect(runConfig(['validate', `--file=${dotenv}`, '--format=json'])).resolves.toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({
      schema_version: 'kb.config-validate.v1',
      status: 'ok',
      source: dotenv,
      counts: { error: 0 },
    });
    expect(stderr).toBe('');
  });

  it('maps validation errors to exit code 1', async () => {
    process.env.KB_RERANK = 'maybe';

    await expect(runConfig(['validate', '--format=json'])).resolves.toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.status).toBe('error');
    expect(parsed.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'KB_RERANK', status: 'error' }),
    ]));
  });

  it('is reachable through the top-level kb dispatcher', async () => {
    const help = spawnSync('node', [cliPath, 'config', '--help'], {
      env: { PATH: ORIGINAL_ENV.PATH ?? '', KB_LOG_FORMAT: 'text' },
      encoding: 'utf-8',
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('kb config validate');
    expect(help.stdout).toContain('kb config show');

    const result = spawnSync('node', [cliPath, 'config', 'validate', '--format=json'], {
      env: { PATH: ORIGINAL_ENV.PATH ?? '', KB_LOG_FORMAT: 'text', KB_RERANK: 'maybe' },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      schema_version: 'kb.config-validate.v1',
      status: 'error',
    });
    expect(parsed.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'KB_RERANK', status: 'error' }),
    ]));
  });

  it('renders markdown with per-variable verdicts', () => {
    const markdown = formatConfigValidateMarkdown({
      schema_version: 'kb.config-validate.v1',
      status: 'warn',
      source: 'process.env',
      checked_at: '2026-05-21T00:00:00.000Z',
      counts: { ok: 1, warn: 1, error: 0 },
      findings: [
        {
          name: 'KB_RELEVANCE_GATE',
          status: 'warn',
          kind: 'dependency',
          source: 'process.env',
          value: 'on',
          message: 'KB_RELEVANCE_GATE=on has no judge endpoint configured',
        },
      ],
    });

    expect(markdown).toContain('status: warn');
    expect(markdown).toContain('| KB_RELEVANCE_GATE | warn | dependency | on |');
  });
});

describe('kb config show (#545)', () => {
  it('parses the show action and supported flags', () => {
    expect(parseConfigArgs(['show'])).toEqual({
      action: 'show',
      format: 'md',
      nonDefaultOnly: false,
    });
    expect(parseConfigArgs(['show', '--format=json', '--non-default-only'])).toEqual({
      action: 'show',
      format: 'json',
      nonDefaultOnly: true,
    });
    expect(() => parseConfigArgs(['show', '--format=text'])).toThrow(/invalid --format/);
    expect(() => parseConfigArgs(['show', '--file=.env'])).toThrow(/only supported by validate/);
  });

  it('writes JSON with resolved values, sources, and redacted secrets', async () => {
    process.env = {
      PATH: ORIGINAL_ENV.PATH ?? '',
      KNOWLEDGE_BASES_ROOT_DIR: '/tmp/kbs',
      KB_RELEVANCE_GATE: 'on',
      OPENAI_API_KEY: 'sk-proj-test-secret',
      MCP_AUTH_TOKEN: 'a'.repeat(32),
    };

    await expect(runConfig(['show', '--format=json'])).resolves.toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.schema_version).toBe('kb.config-show.v1');
    expect(parsed.entries).toEqual(expect.arrayContaining([
      {
        name: 'KNOWLEDGE_BASES_ROOT_DIR',
        kind: 'path',
        value: '/tmp/kbs',
        source: 'env',
        redacted: false,
      },
      {
        name: 'FAISS_INDEX_PATH',
        kind: 'path',
        value: '/tmp/kbs/.faiss',
        source: 'default',
        redacted: false,
      },
      {
        name: 'KB_RELEVANCE_GATE',
        kind: 'boolean',
        value: 'on',
        source: 'env',
        redacted: false,
      },
      {
        name: 'OPENAI_API_KEY',
        kind: 'secret',
        value: '<redacted>',
        source: 'env',
        redacted: true,
      },
      {
        name: 'MCP_AUTH_TOKEN',
        kind: 'secret',
        value: '<redacted>',
        source: 'env',
        redacted: true,
      },
    ]));
    expect(stderr).toBe('');
  });

  it('is reachable through the top-level kb dispatcher', () => {
    const result = spawnSync('node', [cliPath, 'config', 'show', '--format=json', '--non-default-only'], {
      env: { PATH: ORIGINAL_ENV.PATH ?? '', KB_LOG_FORMAT: 'text', KB_RELEVANCE_GATE: 'on' },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      schema_version: 'kb.config-show.v1',
    });
    expect(parsed.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'KB_RELEVANCE_GATE',
        kind: 'boolean',
        value: 'on',
        source: 'env',
        redacted: false,
      }),
    ]));
  });

  it('filters JSON output to env-sourced values with --non-default-only', async () => {
    process.env = {
      PATH: ORIGINAL_ENV.PATH ?? '',
      KB_RELEVANCE_GATE: 'on',
    };

    await expect(runConfig(['show', '--format=json', '--non-default-only'])).resolves.toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.entries).toEqual([
      {
        name: 'KB_RELEVANCE_GATE',
        kind: 'boolean',
        value: 'on',
        source: 'env',
        redacted: false,
      },
    ]);
  });

  it('renders deterministic markdown entries', () => {
    const markdown = formatConfigShowMarkdown({
      schema_version: 'kb.config-show.v1',
      entries: [
        {
          name: 'KB_RELEVANCE_GATE',
          kind: 'boolean',
          value: 'on',
          source: 'env',
          redacted: false,
        },
      ],
    });

    expect(markdown).toBe([
      '# kb config show',
      '',
      '| Variable | Source | Kind | Value |',
      '| --- | --- | --- | --- |',
      '| KB_RELEVANCE_GATE | env | boolean | on |',
      '',
    ].join('\n'));
  });
});
