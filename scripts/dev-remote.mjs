#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const KB_NAME = 'dev-fixture';
const OWNERSHIP_MARKER = '.kb-dev-remote-owned';

const INITIALIZE_PAYLOAD = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'kb-dev-remote', version: '0.0.0' },
  },
});

const PROFILES = {
  small: { files: 3, targetChunksPerFile: 2 },
  medium: { files: 8, targetChunksPerFile: 4 },
};

const HELP = `npm run dev:remote — run a disposable HTTP/SSE MCP server

Usage:
  npm run dev:remote -- [--transport=http|sse] [--port=<int>] [--bind=<addr>]
                         [--out=<dir>] [--seed=<int>] [--profile=small|medium]
                         [--token=<32+ chars>] [--print-env] [--keep] [--help]

Generates a deterministic scratch knowledge base, a scratch FAISS index path,
a bearer token, and a loopback MCP transport configuration. By default it then
starts the TypeScript MCP server against only that scratch state. The
contributor's real KNOWLEDGE_BASES_ROOT_DIR and FAISS_INDEX_PATH are never
touched.

Options:
  --transport=http|sse  Remote MCP transport to start (default: http).
  --port=<int>          Port to use. Omit or pass 0 to pick a free loopback port.
  --bind=<addr>         Bind address (default: 127.0.0.1).
  --out=<dir>           Scratch root (default: fresh /tmp/kb-dev-remote-<ts>).
  --seed=<int>          Mulberry32 seed for deterministic content (default: 1).
  --profile=small|medium
                        Corpus size profile (default: small).
                        small  = ${PROFILES.small.files} files, ~${PROFILES.small.targetChunksPerFile} chunks/file
                        medium = ${PROFILES.medium.files} files, ~${PROFILES.medium.targetChunksPerFile} chunks/file
  --token=<32+ chars>   Bearer token. Default: generated random token.
  --print-env           Print the scratch env and examples, then exit.
  --keep                Keep the scratch root after exit.
  --help, -h            Show this help.
`;

function parseArgs(argv) {
  const out = {
    bind: '127.0.0.1',
    help: false,
    keep: false,
    out: null,
    port: 0,
    printEnv: false,
    profile: 'small',
    seed: 1,
    token: null,
    transport: 'http',
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--keep') {
      out.keep = true;
    } else if (arg === '--print-env') {
      out.printEnv = true;
    } else if (arg.startsWith('--transport=')) {
      const value = arg.slice('--transport='.length);
      if (value !== 'http' && value !== 'sse') {
        throw new Error('--transport must be one of: http, sse');
      }
      out.transport = value;
    } else if (arg.startsWith('--port=')) {
      const raw = arg.slice('--port='.length);
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Error(`--port must be an integer in [0, 65535], got: ${raw}`);
      }
      out.port = value;
    } else if (arg.startsWith('--bind=')) {
      const value = arg.slice('--bind='.length);
      if (!value) throw new Error('--bind requires a non-empty address');
      out.bind = value;
    } else if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length);
      if (!value) throw new Error('--out requires a non-empty path');
      out.out = value;
    } else if (arg.startsWith('--seed=')) {
      const raw = arg.slice('--seed='.length);
      const value = Number(raw);
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        throw new Error(`--seed must be an integer, got: ${raw}`);
      }
      out.seed = value;
    } else if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length);
      if (!Object.prototype.hasOwnProperty.call(PROFILES, value)) {
        throw new Error(`--profile must be one of: ${Object.keys(PROFILES).join(', ')}`);
      }
      out.profile = value;
    } else if (arg.startsWith('--token=')) {
      const value = arg.slice('--token='.length);
      if (value.length < 32) {
        throw new Error('--token must be at least 32 characters');
      }
      out.token = value;
    } else {
      throw new Error(`unknown argument: ${arg} (use --help to see options)`);
    }
  }

  return out;
}

async function prepareRemoteEnvironment(args) {
  const outRoot = args.out
    ? path.resolve(args.out)
    : path.join(os.tmpdir(), `kb-dev-remote-${Date.now()}-${process.pid}`);
  const rootDir = path.join(outRoot, 'knowledge_bases');
  const faissDir = path.join(outRoot, 'faiss');
  const fixtureFile = path.join(outRoot, 'retrieval-eval.yml');
  const port = args.port === 0 ? await chooseFreePort(args.bind) : args.port;
  const token = args.token ?? randomBytes(32).toString('base64url');

  await claimScratchRoot(outRoot);
  await fsp.mkdir(rootDir, { recursive: true });
  await fsp.mkdir(faissDir, { recursive: true });

  const generatorUrl = new URL('../benchmarks/fixtures/generator.ts', import.meta.url);
  const { generateKnowledgeBaseFixture } = await import(generatorUrl.href);
  const profileCfg = PROFILES[args.profile];
  const fixture = await generateKnowledgeBaseFixture({
    files: profileCfg.files,
    knowledgeBaseName: KB_NAME,
    rootDir,
    seed: args.seed,
    targetChunksPerFile: profileCfg.targetChunksPerFile,
  });

  await fsp.writeFile(
    fixtureFile,
    [
      '# Generated by scripts/dev-remote.mjs',
      `# seed=${args.seed} profile=${args.profile} files=${fixture.files} chunks=${fixture.chunkCount}`,
      'gate: false',
      'cases:',
      '  - name: dev-remote seeded query',
      `    query: ${quoteYamlScalar(fixture.query)}`,
      `    kb: ${KB_NAME}`,
      '    required_sources:',
      `      - ${KB_NAME}/doc-001.md`,
      '    stale_policy: allow_stale',
      '',
    ].join('\n'),
    'utf-8',
  );

  return {
    bind: args.bind,
    faissDir,
    fixture,
    fixtureFile,
    outRoot,
    port,
    rootDir,
    token,
    transport: args.transport,
  };
}

async function run(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`dev:remote: ${err.message}\n`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const env = await prepareRemoteEnvironment(args);
  process.stdout.write(formatEnvironment(env, { keep: args.keep, printEnv: args.printEnv }));

  if (args.printEnv) {
    if (!args.keep) {
      await cleanupScratch(env.outRoot);
    }
    return 0;
  }

  const childEnv = {
    ...process.env,
    FAISS_INDEX_PATH: env.faissDir,
    KNOWLEDGE_BASES_ROOT_DIR: env.rootDir,
    MCP_AUTH_TOKEN: env.token,
    MCP_BIND_ADDR: env.bind,
    MCP_PORT: String(env.port),
    MCP_TRANSPORT: env.transport,
  };

  const child = spawn(
    process.execPath,
    ['--enable-source-maps', '--import', 'tsx', path.join(REPO_ROOT, 'src', 'index.ts')],
    { cwd: REPO_ROOT, env: childEnv, stdio: 'inherit' },
  );

  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once('SIGINT', forwardSignal);
  process.once('SIGTERM', forwardSignal);

  return await new Promise((resolve) => {
    child.on('exit', async (code, signal) => {
      process.removeListener('SIGINT', forwardSignal);
      process.removeListener('SIGTERM', forwardSignal);
      if (!args.keep) {
        await cleanupScratch(env.outRoot);
      }
      if (signal) {
        process.stderr.write(`dev:remote: server exited from ${signal}\n`);
        resolve(130);
      } else {
        resolve(code ?? 1);
      }
    });
    child.on('error', async (err) => {
      process.removeListener('SIGINT', forwardSignal);
      process.removeListener('SIGTERM', forwardSignal);
      if (!args.keep) {
        await cleanupScratch(env.outRoot);
      }
      process.stderr.write(`dev:remote: failed to start server: ${err.message}\n`);
      resolve(1);
    });
  });
}

function formatEnvironment(env, options) {
  const baseUrl = `http://${formatHostForUrl(env.bind)}:${env.port}`;
  const shellEnv = [
    `KNOWLEDGE_BASES_ROOT_DIR=${quoteShell(env.rootDir)}`,
    `FAISS_INDEX_PATH=${quoteShell(env.faissDir)}`,
    `MCP_TRANSPORT=${quoteShell(env.transport)}`,
    `MCP_AUTH_TOKEN=${quoteShell(env.token)}`,
    `MCP_PORT=${env.port}`,
    `MCP_BIND_ADDR=${quoteShell(env.bind)}`,
  ].join(' ');

  const transportExamples = env.transport === 'http'
    ? [
        `  curl -i ${quoteShell(`${baseUrl}/health`)}`,
        `  curl -i -X POST ${quoteShell(`${baseUrl}/mcp`)} \\`,
        `    -H ${quoteShell(`Authorization: Bearer ${env.token}`)} \\`,
        `    -H ${quoteShell('Content-Type: application/json')} \\`,
        `    -H ${quoteShell('Accept: application/json, text/event-stream')} \\`,
        `    --data ${quoteShell(INITIALIZE_PAYLOAD)}`,
      ]
    : [
        `  curl -i ${quoteShell(`${baseUrl}/health`)}`,
        `  curl -N ${quoteShell(`${baseUrl}/sse`)} \\`,
        `    -H ${quoteShell(`Authorization: Bearer ${env.token}`)}`,
        `  # Copy the sessionId from the SSE endpoint event, then POST JSON-RPC to:`,
        `  # ${baseUrl}/messages?sessionId=<sessionId>`,
      ];

  return [
    '',
    'Disposable remote MCP environment ready.',
    `  out:                       ${env.outRoot}`,
    `  KNOWLEDGE_BASES_ROOT_DIR:  ${env.rootDir}`,
    `  FAISS_INDEX_PATH:          ${env.faissDir}`,
    `  MCP_TRANSPORT:             ${env.transport}`,
    `  MCP_AUTH_TOKEN:            ${env.token}`,
    `  MCP_PORT:                  ${env.port}`,
    `  MCP_BIND_ADDR:             ${env.bind}`,
    `  knowledge base:            ${KB_NAME} (${env.fixture.files} file(s), ~${env.fixture.chunkCount} chunk(s))`,
    `  retrieval-eval fixture:    ${env.fixtureFile}`,
    '',
    options.printEnv ? 'Shell env:' : 'Server env:',
    `  ${shellEnv}`,
    '',
    'Try these commands in another terminal:',
    ...transportExamples,
    '',
    options.keep
      ? `--keep set. Remove later with: rm -rf ${quoteShell(env.outRoot)}`
      : options.printEnv
        ? 'Scratch dir will be removed before exit. Re-run with --keep to reuse these paths.'
        : 'Scratch dir will be removed when the dev server exits.',
    '',
  ].join('\n');
}

function chooseFreePort(bind) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, bind, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('could not choose a free port'));
        }
      });
    });
  });
}

async function cleanupScratch(outRoot) {
  const markerPath = path.join(outRoot, OWNERSHIP_MARKER);
  try {
    const marker = await fsp.readFile(markerPath, 'utf-8');
    if (!marker.startsWith('kb-dev-remote\n')) {
      throw new Error('unexpected marker contents');
    }
  } catch (err) {
    process.stderr.write(
      `dev:remote: refusing to remove ${outRoot}; ownership marker missing or invalid (${err.message})\n`,
    );
    return;
  }
  await fsp.rm(outRoot, { recursive: true, force: true });
}

async function claimScratchRoot(outRoot) {
  let entries = null;
  try {
    entries = await fsp.readdir(outRoot);
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
  if (entries && entries.length > 0) {
    throw new Error(`--out must point to a new or empty directory: ${outRoot}`);
  }
  await fsp.mkdir(outRoot, { recursive: true });
  await fsp.writeFile(
    path.join(outRoot, OWNERSHIP_MARKER),
    `kb-dev-remote\npid=${process.pid}\ncreated=${new Date().toISOString()}\n`,
    { flag: 'wx' },
  );
}

function formatHostForUrl(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function quoteYamlScalar(text) {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function quoteShell(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

const isDirectInvocation = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (isDirectInvocation) {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error && err.stack ? err.stack : String(err);
    process.stderr.write(`dev:remote: fatal: ${msg}\n`);
    process.exitCode = 1;
  }
}
