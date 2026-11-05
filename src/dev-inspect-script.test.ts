import { afterEach, describe, expect, it } from '@jest/globals';
import { type ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = process.cwd();

function readJson<T = unknown>(relPath: string): T {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf-8')) as T;
}

const pkg = readJson<{ scripts: Record<string, string> }>('package.json');
const DEV_INSPECT = pkg.scripts['dev:inspect'] ?? '';

/** The inspector port the script binds (`--inspect-brk` with no value defaults to 9229). */
function inspectPortFromScript(script: string): number {
  const match = /--inspect-brk(?:=(?:.*:)?(\d+))?/.exec(script);
  if (!match) throw new Error(`no --inspect-brk in script: ${script}`);
  return match[1] ? Number(match[1]) : 9229;
}

/**
 * Turn the real `dev:inspect` script into an argv for `spawn`, rewriting only the
 * inspector port to an ephemeral one (:0) so parallel jest workers never collide on
 * the default 9229. Every other flag (source maps, the tsx loader, the entry point)
 * is exercised exactly as the committed script declares it — so editing the script
 * out from under this test is caught here, not masked by a hand-copied argv.
 */
function spawnArgvFromScript(script: string): string[] {
  const tokens = script.trim().split(/\s+/);
  expect(tokens[0]).toBe('node');
  return tokens
    .slice(1)
    .map((tok) => (tok.startsWith('--inspect-brk') ? '--inspect-brk=127.0.0.1:0' : tok));
}

describe('dev:inspect debugger surface', () => {
  describe('package.json dev:inspect script', () => {
    it('breaks on the Node inspector on the same tsx entry point as `dev`', () => {
      // Anchored so flags in a comment/echo or a second stray path can't satisfy it:
      // node --inspect-brk ... --import tsx src/index.ts (source maps anywhere between).
      expect(DEV_INSPECT).toMatch(
        /^node --inspect-brk\b.*\B--enable-source-maps\b.*\B--import tsx src\/index\.ts$/,
      );
    });
  });

  describe('.vscode/launch.json', () => {
    // Strict JSON (no comments) so it parses without a JSONC pass.
    const launch = readJson<{
      version: string;
      configurations: Array<Record<string, unknown>>;
    }>('.vscode/launch.json');

    it('is a valid launch.json document', () => {
      expect(launch.version).toBe('0.2.0');
      expect(Array.isArray(launch.configurations)).toBe(true);
      expect(launch.configurations.length).toBeGreaterThanOrEqual(2);
    });

    it('provides an attach config bound to the port dev:inspect actually binds', () => {
      const attach = launch.configurations.find((c) => c.request === 'attach');
      expect(attach).toBeDefined();
      expect(attach?.type).toBe('node');
      // Cross-check against the script rather than hard-coding 9229, so the two
      // can't silently drift apart.
      expect(attach?.port).toBe(inspectPortFromScript(DEV_INSPECT));
    });

    it('provides a launch config that runs a kb CLI command under the debugger', () => {
      const cli = launch.configurations.find(
        (c) => c.request === 'launch' && typeof c.program === 'string',
      );
      expect(cli).toBeDefined();
      // Reuses the dev:cli wrapper, which must exist, so the debugged command gets
      // the same dev env/model setup as `npm run dev:cli`.
      expect(cli?.program).toContain('dev-cli.mjs');
      expect(fs.existsSync(path.join(REPO_ROOT, 'scripts', 'dev-cli.mjs'))).toBe(true);
      expect(Array.isArray(cli?.args)).toBe(true);
      // The tsx loader must be registered as an ordered `--import tsx` pair.
      const runtimeArgs = cli?.runtimeArgs as unknown[];
      expect(Array.isArray(runtimeArgs)).toBe(true);
      const importIdx = runtimeArgs.indexOf('--import');
      expect(importIdx).toBeGreaterThanOrEqual(0);
      expect(runtimeArgs[importIdx + 1]).toBe('tsx');
    });
  });

  describe('CONTRIBUTING.md', () => {
    const contributing = fs.readFileSync(path.join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf-8');

    it('documents how to attach a debugger in a dedicated Debugging section', () => {
      // Scope the assertions to the ## Debugging section so the guidance can't pass
      // by appearing somewhere unrelated.
      const start = contributing.indexOf('## Debugging');
      expect(start).toBeGreaterThanOrEqual(0);
      const rest = contributing.slice(start + '## Debugging'.length);
      const end = rest.indexOf('\n## ');
      const section = end >= 0 ? rest.slice(0, end) : rest;
      expect(section).toContain('npm run dev:inspect');
      expect(section).toContain('.vscode/launch.json');
      // Mentions attaching (the whole point of the inspector surface).
      expect(section.toLowerCase()).toContain('attach');
    });
  });

  describe('running the inspector (behavioral)', () => {
    let child: ChildProcess | undefined;
    let tmpDir: string | undefined;

    afterEach(async () => {
      if (child) {
        if (child.exitCode === null && child.signalCode === null) {
          const dead = new Promise<void>((resolve) => child?.once('exit', () => resolve()));
          child.kill('SIGKILL');
          let timer: NodeJS.Timeout | undefined;
          const guard = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 2000);
          });
          await Promise.race([dead, guard]);
          if (timer) clearTimeout(timer);
        }
        child.stderr?.destroy();
        child.unref();
      }
      child = undefined;
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = undefined;
      }
    });

    it('binds the inspector and halts before running any app code', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `kb-dev-inspect-${process.pid}-`));
      // Isolate storage so that, even if app code were (incorrectly) to run, it can
      // never touch the developer's real knowledge base or FAISS index.
      const env = {
        ...process.env,
        HOME: tmpDir,
        KNOWLEDGE_BASES_ROOT_DIR: path.join(tmpDir, 'kbs'),
        FAISS_INDEX_PATH: path.join(tmpDir, 'faiss'),
      };

      // Only stderr is piped: the Node inspector banner and the logger's startup
      // markers both go to fd 2, and ignoring stdin/stdout avoids leaking pipes.
      const proc = spawn(process.execPath, spawnArgvFromScript(DEV_INSPECT), {
        cwd: REPO_ROOT,
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child = proc;

      let stderr = '';
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });
      let exited = false;
      proc.on('exit', () => {
        exited = true;
      });

      // Wait for the inspector banner, polling stderr with a hard deadline.
      const deadline = Date.now() + 15_000;
      while (!/Debugger listening on ws:\/\//.test(stderr) && !exited && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(stderr).toMatch(/Debugger listening on ws:\/\//);

      // Give app code a generous window to start if it were going to. `--inspect-brk`
      // halts before the first line of src/index.ts, so KnowledgeBaseServer must never
      // initialize. This is what distinguishes --inspect-brk from a plain --inspect
      // (which would run the server and emit the startup log below).
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(exited).toBe(false);
      expect(proc.exitCode).toBeNull();
      expect(stderr).not.toContain('Initializing KnowledgeBaseServer');
      expect(stderr).not.toContain('running on stdio');
    }, 25_000);
  });
});
