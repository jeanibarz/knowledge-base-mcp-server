// src/e2e/npm-pack-smoke.e2e.test.ts
//
// Issue #413 — npm package smoke tests for the packed `kb` and MCP binaries.
//
// Every other binary-spawning test in the repo (`src/cli*.test.ts`,
// `src/e2e/mcp-binary.e2e.test.ts`) runs `build/cli.js` / `build/index.js`
// straight out of the checkout. That misses an entire class of release
// regressions: the published npm tarball is NOT the checkout. It is the
// subset of files picked by `package.json` `files`, with `bin` targets
// that production users reach through `npm install -g` symlinks. A source
// checkout can be perfectly healthy while the packed tarball ships missing
// bins, a dropped `chmod +x`, or a runtime file left outside `build/`.
//
// This suite closes that gap with a release-shaped smoke test:
//   1. `npm pack` the repo into a temp dir — the exact bytes `npm publish`
//      would upload.
//   2. Extract the tarball (`tar -xzp`, preserving stored file modes) so
//      the `package/` tree is what `npm install` would place under
//      `node_modules/@jeanibarz/knowledge-base-mcp-server/`.
//   3. Make the package's runtime dependencies resolvable by symlinking
//      the repo's already-installed `node_modules` into the extracted
//      tree. Re-installing the full dependency graph (native `faiss-node`
//      included) would make the test slow and network-bound; #413's gap
//      is the tarball's OWN packed contents (bins, permissions, `files`
//      allowlist) — not third-party deps — so the deps are borrowed
//      rather than reinstalled.
//   4. Drive both declared bins — `kb` and `knowledge-base-mcp-server` —
//      the way a user would: `kb` directly through its shebang, the MCP
//      server over stdio through the real `@modelcontextprotocol/sdk`
//      client.
//
// Like the issue #222 e2e suite, this is gated behind `KB_RUN_E2E=1` (and
// `jest.config.js` excludes `src/e2e/` from the default `npm test`): the
// `npm pack` + extract round-trip adds seconds a fast inner loop should
// not pay. A maintainer runs `KB_RUN_E2E=1 npm test` before cutting a
// release. The suite `describe.skip`s when the gate is off so narrowing to
// this file without the env var shows a clean "skipped" line.
//
// Pre-condition: `npm run build` must have run — `npm pack` tarballs
// whatever is in `build/`. The suite asserts the build exists and fails
// with a "build first" message otherwise.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'child_process';
import { constants as fsConstants } from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { parseToolJsonText } from './test-fixtures.js';

const RUN_E2E = process.env.KB_RUN_E2E === '1';
const REPO_ROOT = path.resolve(process.cwd());

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Resolved state produced once in `beforeAll` and shared by every test. */
interface PackedPackage {
  /** Temp dir holding the tarball, the extracted `package/` tree, and KB fixtures. */
  workDir: string;
  /** Extracted tarball root (`<workDir>/package`). */
  packageDir: string;
  /** Top-level entries inside the extracted tarball, before deps are linked in. */
  shippedEntries: string[];
  /** Absolute path of the packed `kb` bin. */
  kbBin: string;
  /** Absolute path of the packed MCP-server bin. */
  mcpBin: string;
  /** Seeded read-only knowledge-base root used by `list` / `search` / MCP tests. */
  kbRoot: string;
  /** Throwaway FAISS index path — none of the smoke paths build an index. */
  faissRoot: string;
  /** Sterile temp HOME so the bins never read the developer's machine profile. */
  homeDir: string;
  /** `version` declared by the packed `package.json`. */
  packagedVersion: string;
}

let pkg: PackedPackage;

async function assertBuilt(): Promise<void> {
  for (const rel of ['build/cli.js', 'build/index.js']) {
    try {
      await fsp.access(path.join(REPO_ROOT, rel));
    } catch {
      throw new Error(
        `npm-pack smoke test cannot find ${rel}. Run \`npm run build\` before ` +
          `\`KB_RUN_E2E=1 npm test\` — \`npm pack\` tarballs whatever is in build/.`,
      );
    }
  }
}

function run(command: string, args: string[], cwd: string): RunResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * `npm pack`s the repo, extracts the tarball, and links the repo's
 * dependencies into the extracted tree so the packed bins are runnable.
 */
async function packAndExtract(): Promise<PackedPackage> {
  await assertBuilt();

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-npm-pack-'));

  const pack = run('npm', ['pack', '--pack-destination', workDir], REPO_ROOT);
  if (pack.code !== 0) {
    throw new Error(`\`npm pack\` failed (exit ${pack.code}):\n${pack.stderr}`);
  }
  const tarballs = (await fsp.readdir(workDir)).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1) {
    throw new Error(`expected exactly one .tgz in ${workDir}, found: ${tarballs.join(', ')}`);
  }
  const tarball = path.join(workDir, tarballs[0]);

  // `-p` preserves the file modes stored in the tarball so the executable
  // bit set by the `build` script's `chmod +x` survives extraction — the
  // bins-are-executable assertion below depends on it.
  const extract = run('tar', ['-xzpf', tarball, '-C', workDir], workDir);
  if (extract.code !== 0) {
    throw new Error(`extracting ${tarball} failed (exit ${extract.code}):\n${extract.stderr}`);
  }

  const packageDir = path.join(workDir, 'package');
  const shippedEntries = (await fsp.readdir(packageDir)).sort();

  // Borrow the repo's installed dependencies. The packed tree ships no
  // node_modules; symlinking the real one lets Node's module resolution
  // satisfy bare imports (`zod`, `@modelcontextprotocol/sdk`, …) without a
  // slow, network-bound reinstall. `realpath` collapses the worktree's own
  // `node_modules` symlink so the link points at a concrete directory.
  const realNodeModules = await fsp.realpath(path.join(REPO_ROOT, 'node_modules'));
  await fsp.symlink(realNodeModules, path.join(packageDir, 'node_modules'), 'dir');

  const manifest = JSON.parse(
    await fsp.readFile(path.join(packageDir, 'package.json'), 'utf-8'),
  ) as { version?: string; bin?: Record<string, string> };

  const kbRoot = path.join(workDir, 'knowledge-bases');
  const faissRoot = path.join(workDir, 'faiss');
  const homeDir = path.join(workDir, 'home');
  await fsp.mkdir(path.join(kbRoot, 'alpha'), { recursive: true });
  await fsp.mkdir(homeDir, { recursive: true });
  await fsp.writeFile(
    path.join(kbRoot, 'alpha', 'note.md'),
    '# Alpha\n\nA stable smoke-test note without external references.\n',
    'utf-8',
  );

  return {
    workDir,
    packageDir,
    shippedEntries,
    kbBin: path.join(packageDir, 'build', 'cli.js'),
    mcpBin: path.join(packageDir, 'build', 'index.js'),
    kbRoot,
    faissRoot,
    homeDir,
    packagedVersion: manifest.version ?? '',
  };
}

/**
 * Runs the packed `kb` bin through its own shebang (no `node` prefix) so a
 * dropped `chmod +x` or a broken `#!/usr/bin/env node` line surfaces here.
 */
function runKb(args: string[], extraEnv: Record<string, string> = {}): RunResult {
  const result = spawnSync(pkg.kbBin, args, {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: pkg.homeDir,
      KB_LOG_FORMAT: 'text',
      ...extraEnv,
    },
    encoding: 'utf-8',
    timeout: 20_000,
  });
  if (result.error) throw result.error;
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

(RUN_E2E ? describe : describe.skip)('npm-pack smoke (packed kb + MCP binaries)', () => {
  jest.setTimeout(180_000);

  beforeAll(async () => {
    pkg = await packAndExtract();
  });

  afterAll(async () => {
    if (pkg?.workDir) {
      await fsp.rm(pkg.workDir, { recursive: true, force: true });
    }
  });

  it('ships only the allowlisted files and both declared bins as executables', async () => {
    // `package.json` `files` is `["build/", "UNLICENSE"]`; npm always adds
    // `package.json` and `README*`. A widened allowlist (src/, tests, a
    // stray node_modules) is a real packaging regression — pin the set.
    expect(pkg.shippedEntries).toEqual(['README.md', 'UNLICENSE', 'build', 'package.json']);

    const manifest = JSON.parse(
      await fsp.readFile(path.join(pkg.packageDir, 'package.json'), 'utf-8'),
    ) as { bin?: Record<string, string> };
    expect(manifest.bin).toEqual({
      kb: 'build/cli.js',
      'knowledge-base-mcp-server': 'build/index.js',
    });

    for (const bin of [pkg.kbBin, pkg.mcpBin]) {
      const stat = await fsp.stat(bin);
      expect(stat.isFile()).toBe(true);
      // The bit npm relies on when it creates the install-time bin shim,
      // and the bit a direct shebang invocation needs.
      expect(stat.mode & 0o111).not.toBe(0);
      await expect(fsp.access(bin, fsConstants.X_OK)).resolves.toBeUndefined();
    }
  });

  it('kb --version prints the packaged version', () => {
    const result = runKb(['--version']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    // Proves the bin can read the tarball's package.json at runtime — the
    // one file `kb` loads from outside build/.
    expect(result.stdout.trim()).toBe(pkg.packagedVersion);
    expect(pkg.packagedVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('kb --help prints top-level usage', () => {
    const result = runKb(['--help']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('kb — knowledge-base CLI');
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('Available commands:');
  });

  it('kb list runs the no-backend list path against a temp KB root', () => {
    const result = runKb(['list', '--format=json'], {
      KNOWLEDGE_BASES_ROOT_DIR: pkg.kbRoot,
      FAISS_INDEX_PATH: pkg.faissRoot,
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual([{ name: 'alpha' }]);
  });

  it('kb search returns the structured no-model error without a backend', () => {
    const result = runKb(['search', 'alpha', '--format=json'], {
      KNOWLEDGE_BASES_ROOT_DIR: pkg.kbRoot,
      FAISS_INDEX_PATH: pkg.faissRoot,
      EMBEDDING_PROVIDER: 'ollama',
      OLLAMA_MODEL: 'nomic-embed-text',
    });

    // Exit 2 + a structured configuration error is the contract for a
    // no-model invocation — it must hold for the packed bin too.
    expect(result.code).toBe(2);
    const body = JSON.parse(result.stdout) as {
      error?: { code?: string; category?: string };
    };
    expect(body.error).toMatchObject({
      code: 'ACTIVE_MODEL_UNRESOLVED',
      category: 'configuration',
    });
  });

  it('knowledge-base-mcp-server boots over stdio and serves a no-backend tool call', async () => {
    // Spawn the packed MCP bin directly (shebang) and connect with the
    // real SDK client — `client.connect` performs the `initialize`
    // handshake, so a successful connect proves the packed bin starts and
    // every runtime file it imports made it into the tarball.
    const transport = new StdioClientTransport({
      command: pkg.mcpBin,
      args: [],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: pkg.homeDir,
        KNOWLEDGE_BASES_ROOT_DIR: pkg.kbRoot,
        FAISS_INDEX_PATH: pkg.faissRoot,
        REINDEX_TRIGGER_POLL_MS: '0',
      },
      stderr: 'inherit',
    });
    const client = new Client({ name: 'kb-npm-pack-smoke', version: '0.0.0-test' });

    try {
      await client.connect(transport);

      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools.length).toBeGreaterThan(0);
      expect(tools).toEqual(
        expect.arrayContaining(['list_knowledge_bases', 'retrieve_knowledge', 'kb_stats']),
      );

      // A no-backend tool call exercised through the packed bin end to end.
      const listResult = await client.callTool({
        name: 'list_knowledge_bases',
        arguments: {},
      });
      expect(listResult.isError).toBeFalsy();
      const payload = parseToolJsonText(
        listResult as Parameters<typeof parseToolJsonText>[0],
      );
      expect(payload).toEqual(['alpha']);
    } finally {
      await client.close();
    }
  });
});
