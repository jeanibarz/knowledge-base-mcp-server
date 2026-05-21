import { describe, expect, it } from '@jest/globals';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import * as net from 'net';
import * as path from 'path';

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'dev-mockllm.mjs');

function runScript(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    ['--enable-source-maps', '--import', 'tsx', SCRIPT_PATH, ...args],
    { encoding: 'utf-8', env: process.env },
  );
}

describe('npm run dev:mockllm script', () => {
  it('prints help without starting a server', () => {
    const result = runScript(['--help']);
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('npm run dev:mockllm');
    expect(result.stdout).toContain('/v1/chat/completions');
    expect(result.stdout).toContain('--rules=<path>');
  });

  it('exposes the help path through the package script', () => {
    const result = spawnSync('npm', ['run', 'dev:mockllm', '--', '--help'], {
      encoding: 'utf-8',
      env: process.env,
    });
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('npm run dev:mockllm');
    expect(result.stdout).toContain('/v1/chat/completions');
  });

  it('rejects invalid options', () => {
    const badPort = runScript(['--port=70000']);
    if (badPort.error) throw badPort.error;
    expect(badPort.status).toBe(2);
    expect(badPort.stderr).toContain('--port must be an integer');

    const badFlag = runScript(['--nope']);
    if (badFlag.error) throw badFlag.error;
    expect(badFlag.status).toBe(2);
    expect(badFlag.stderr).toContain('unknown argument');
  });

  it('serves health and OpenAI-compatible chat responses', async () => {
    const port = await getFreePort();
    const child = spawn(
      process.execPath,
      ['--enable-source-maps', '--import', 'tsx', SCRIPT_PATH, `--port=${port}`],
      { env: process.env },
    );
    try {
      await waitForReady(child);
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toMatchObject({ status: 'ok', provider: 'fake' });

      const chat = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: 'Reply with exactly: ok' },
            { role: 'user', content: 'health check' },
          ],
        }),
      });
      expect(chat.status).toBe(200);
      const payload = await chat.json() as { choices: Array<{ message: { content: string } }> };
      expect(payload.choices[0].message.content).toBe('ok');
    } finally {
      child.kill('SIGTERM');
    }
  }, 15_000);
});

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate a TCP port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      reject(new Error(`dev:mockllm did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 10_000);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('Fake LLM server ready.')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('exit', (code) => {
      if (!stdout.includes('Fake LLM server ready.')) {
        clearTimeout(timeout);
        reject(new Error(`dev:mockllm exited before ready with ${code}\nstderr:\n${stderr}`));
      }
    });
  });
}
