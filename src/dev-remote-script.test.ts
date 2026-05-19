import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import yaml from 'js-yaml';

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'dev-remote.mjs');
const VALID_TOKEN = 'dev-remote-token-0123456789abcdef0123456789abcdef';

function tempOutDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kb-dev-remote-${label}-${process.pid}-`));
}

function runScript(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    ['--enable-source-maps', '--import', 'tsx', SCRIPT_PATH, ...args],
    { encoding: 'utf-8', env: process.env },
  );
}

describe('npm run dev:remote script', () => {
  it('prints help with --help without writing any files', () => {
    const outDir = path.join(os.tmpdir(), `kb-dev-remote-help-${process.pid}-${Date.now()}`);
    const result = runScript(['--help', '--out=' + outDir]);
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('npm run dev:remote');
    expect(result.stdout).toContain('--transport=http|sse');
    expect(result.stdout).toContain('--print-env');
    expect(result.stdout).toContain('--token=<32+ chars>');
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it('rejects invalid remote debugging options', () => {
    const badTransport = runScript(['--transport=stdio']);
    if (badTransport.error) throw badTransport.error;
    expect(badTransport.status).toBe(2);
    expect(badTransport.stderr).toContain('--transport must be one of');

    const badPort = runScript(['--port=70000']);
    if (badPort.error) throw badPort.error;
    expect(badPort.status).toBe(2);
    expect(badPort.stderr).toContain('--port must be an integer');

    const badToken = runScript(['--token=short']);
    if (badToken.error) throw badToken.error;
    expect(badToken.status).toBe(2);
    expect(badToken.stderr).toContain('--token must be at least 32 characters');
  });

  it('prints a deterministic disposable SSE environment when requested', () => {
    const outDir = tempOutDir('sse');
    try {
      const result = runScript([
        '--print-env',
        '--keep',
        '--transport=sse',
        '--out=' + outDir,
        '--seed=11',
        '--profile=small',
        '--port=45678',
        '--token=' + VALID_TOKEN,
      ]);
      if (result.error) throw result.error;
      expect(result.status).toBe(0);

      const rootDir = path.join(outDir, 'knowledge_bases');
      const faissDir = path.join(outDir, 'faiss');
      const fixturePath = path.join(outDir, 'retrieval-eval.yml');

      expect(fs.statSync(path.join(rootDir, 'dev-fixture')).isDirectory()).toBe(true);
      expect(fs.statSync(faissDir).isDirectory()).toBe(true);
      expect(fs.statSync(fixturePath).isFile()).toBe(true);

      const parsed = yaml.load(fs.readFileSync(fixturePath, 'utf-8')) as {
        gate: boolean;
        cases: Array<{ kb: string; required_sources: string[]; stale_policy: string }>;
      };
      expect(parsed.gate).toBe(false);
      expect(parsed.cases).toHaveLength(1);
      expect(parsed.cases[0].kb).toBe('dev-fixture');
      expect(parsed.cases[0].required_sources).toEqual(['dev-fixture/doc-001.md']);
      expect(parsed.cases[0].stale_policy).toBe('allow_stale');

      expect(result.stdout).toContain('Disposable remote MCP environment ready.');
      expect(result.stdout).toContain(`KNOWLEDGE_BASES_ROOT_DIR:  ${rootDir}`);
      expect(result.stdout).toContain(`FAISS_INDEX_PATH:          ${faissDir}`);
      expect(result.stdout).toContain('MCP_TRANSPORT:             sse');
      expect(result.stdout).toContain(`MCP_AUTH_TOKEN:            ${VALID_TOKEN}`);
      expect(result.stdout).toContain('MCP_PORT:                  45678');
      expect(result.stdout).toContain('curl -N');
      expect(result.stdout).toContain('/sse');
      expect(result.stdout).toContain('/messages?sessionId=<sessionId>');
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('prints streamable HTTP examples by default and cleans scratch state without --keep', () => {
    const outDir = tempOutDir('http');
    const result = runScript([
      '--print-env',
      '--out=' + outDir,
      '--port=45679',
      '--token=' + VALID_TOKEN,
    ]);
    if (result.error) throw result.error;

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('MCP_TRANSPORT:             http');
    expect(result.stdout).toContain('/mcp');
    expect(result.stdout).toContain('Authorization: Bearer ' + VALID_TOKEN);
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it('refuses to clean up a non-empty caller-provided output directory', () => {
    const outDir = tempOutDir('non-empty');
    const sentinelPath = path.join(outDir, 'sentinel.txt');
    fs.writeFileSync(sentinelPath, 'keep me', 'utf-8');
    try {
      const result = runScript([
        '--print-env',
        '--out=' + outDir,
        '--token=' + VALID_TOKEN,
      ]);
      if (result.error) throw result.error;

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--out must point to a new or empty directory');
      expect(fs.readFileSync(sentinelPath, 'utf-8')).toBe('keep me');
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('brackets IPv6 bind addresses in printed curl examples', () => {
    const outDir = tempOutDir('ipv6');
    try {
      const result = runScript([
        '--print-env',
        '--keep',
        '--bind=::1',
        '--out=' + outDir,
        '--port=45680',
        '--token=' + VALID_TOKEN,
      ]);
      if (result.error) throw result.error;

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("curl -i 'http://[::1]:45680/health'");
      expect(result.stdout).toContain("curl -i -X POST 'http://[::1]:45680/mcp'");
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
