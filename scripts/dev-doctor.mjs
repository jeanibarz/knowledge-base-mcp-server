#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const KB_NAME = 'dev-fixture';
const OWNERSHIP_MARKER = '.kb-dev-doctor-owned';
const PROFILES = {
  small: { files: 3, targetChunksPerFile: 2 },
  medium: { files: 8, targetChunksPerFile: 4 },
};

const HELP = `npm run dev:doctor — check a disposable contributor bootstrap flow

Usage:
  npm run dev:doctor -- [--out=<dir>] [--seed=<int>] [--profile=small|medium]
                         [--dense=auto|skip|required] [--skip-build]
                         [--keep] [--help]

Builds the checkout, creates a deterministic scratch knowledge base, verifies
the local built CLI, imports the native FAISS module, runs kb list, runs a
lexical search, and attempts dense search when the embedding provider is
reachable. The contributor's real KNOWLEDGE_BASES_ROOT_DIR and FAISS_INDEX_PATH
are never touched.

Options:
  --out=<dir>           Scratch root (default: fresh /tmp/kb-dev-doctor-<ts>).
  --seed=<int>          Mulberry32 seed for deterministic content (default: 1).
  --profile=small|medium
                        Corpus size profile (default: small).
  --dense=auto|skip|required
                        Dense provider check mode (default: auto).
                        auto skips provider config/reachability failures.
  --skip-build          Reuse the existing build/ output.
  --keep                Keep the scratch root after exit.
  --help, -h            Show this help.
`;

function parseArgs(argv) {
  const out = {
    dense: 'auto',
    help: false,
    keep: false,
    out: null,
    profile: 'small',
    seed: 1,
    skipBuild: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--keep') {
      out.keep = true;
    } else if (arg === '--skip-build') {
      out.skipBuild = true;
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
    } else if (arg.startsWith('--dense=')) {
      const value = arg.slice('--dense='.length);
      if (value !== 'auto' && value !== 'skip' && value !== 'required') {
        throw new Error('--dense must be one of: auto, skip, required');
      }
      out.dense = value;
    } else {
      throw new Error(`unknown argument: ${arg} (use --help to see options)`);
    }
  }

  return out;
}

async function run(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`dev:doctor: ${err.message}\n`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const report = [];
  let env = null;

  try {
    env = await prepareEnvironment(args);

    if (args.skipBuild) {
      report.push(skip('build', '--skip-build set; reusing existing build/ output'));
    } else {
      report.push(commandStep('build', npmCommand(), ['run', 'build'], { env: process.env }));
    }

    report.push(commandStep(
      'faiss',
      process.execPath,
      ['--input-type=module', '-e', "await import('faiss-node')"],
      { env: process.env },
    ));

    report.push(await fixtureStep(env));
    report.push(commandStep('local cli', process.execPath, [path.join(REPO_ROOT, 'build', 'cli.js'), '--version'], {
      env: process.env,
    }));
    report.push(linkedCliStep());
    report.push(kbListStep(env));
    report.push(searchStep('lexical search', env, ['--mode=lexical']));
    report.push(await denseStep(env, args.dense));

    process.stdout.write(formatReport(env, report));
    return report.some((entry) => entry.status === 'fail') ? 1 : 0;
  } finally {
    if (env && !args.keep) {
      await cleanupScratch(env.outRoot);
    }
  }
}

async function prepareEnvironment(args) {
  const outRoot = args.out
    ? path.resolve(args.out)
    : path.join(os.tmpdir(), `kb-dev-doctor-${Date.now()}-${process.pid}`);
  const rootDir = path.join(outRoot, 'knowledge_bases');
  const faissDir = path.join(outRoot, 'faiss');
  const fixtureFile = path.join(outRoot, 'retrieval-eval.yml');

  await claimScratchRoot(outRoot);
  await fsp.mkdir(rootDir, { recursive: true });
  await fsp.mkdir(faissDir, { recursive: true });

  return {
    faissDir,
    fixture: null,
    fixtureFile,
    outRoot,
    rootDir,
    seed: args.seed,
    profile: args.profile,
  };
}

async function fixtureStep(env) {
  try {
    const generatorUrl = new URL('../benchmarks/fixtures/generator.ts', import.meta.url);
    const { generateKnowledgeBaseFixture } = await import(generatorUrl.href);
    const profileCfg = PROFILES[env.profile];
    const fixture = await generateKnowledgeBaseFixture({
      files: profileCfg.files,
      knowledgeBaseName: KB_NAME,
      rootDir: env.rootDir,
      seed: env.seed,
      targetChunksPerFile: profileCfg.targetChunksPerFile,
    });
    env.fixture = fixture;

    await fsp.writeFile(
      env.fixtureFile,
      [
        '# Generated by scripts/dev-doctor.mjs',
        `# seed=${env.seed} profile=${env.profile} files=${fixture.files} chunks=${fixture.chunkCount}`,
        'gate: false',
        'cases:',
        '  - name: dev-doctor seeded query',
        `    query: ${quoteYamlScalar(fixture.query)}`,
        `    kb: ${KB_NAME}`,
        '    required_sources:',
        `      - ${KB_NAME}/doc-001.md`,
        '    stale_policy: allow_stale',
        '',
      ].join('\n'),
      'utf-8',
    );

    return pass('fixture', `${fixture.files} file(s), ~${fixture.chunkCount} chunk(s)`);
  } catch (err) {
    return fail('fixture', errorMessage(err));
  }
}

function kbListStep(env) {
  const result = runCommand(process.execPath, [path.join(REPO_ROOT, 'build', 'cli.js'), 'list'], {
    env: scratchEnv(env),
  });
  if (result.status !== 0) {
    return fail('kb list', summarizeCommandFailure(result));
  }
  if (!result.stdout.includes(KB_NAME)) {
    return fail('kb list', `expected ${KB_NAME} in output`);
  }
  return pass('kb list', `listed ${KB_NAME}`);
}

function searchStep(name, env, extraArgs) {
  const query = fixtureQuery(env);
  const result = runCommand(
    process.execPath,
    [
      path.join(REPO_ROOT, 'build', 'cli.js'),
      'search',
      query,
      `--kb=${KB_NAME}`,
      '--k=1',
      '--format=json',
      '--no-freshness',
      ...extraArgs,
    ],
    { env: scratchEnv(env) },
  );
  if (result.status !== 0) {
    return fail(name, summarizeCommandFailure(result));
  }
  const parsed = parseJsonOutput(result.stdout);
  if (!parsed || !Array.isArray(parsed.results) || parsed.results.length === 0) {
    return fail(name, 'expected at least one JSON result');
  }
  return pass(name, `returned ${parsed.results.length} result(s)`);
}

async function denseStep(env, mode) {
  if (mode === 'skip') {
    return skip('dense search', '--dense=skip set');
  }

  const modelSpec = await resolveDenseModelSpec();
  const registerResult = runCommand(
    process.execPath,
    [
      path.join(REPO_ROOT, 'build', 'cli.js'),
      'models',
      'add',
      modelSpec.provider,
      modelSpec.modelName,
      '--yes',
    ],
    { env: scratchEnv(env) },
  );
  if (registerResult.status !== 0) {
    const summary = summarizeCommandFailure(registerResult);
    if (mode === 'auto' && isProviderReachabilityFailure(summary)) {
      return skip('dense search', `provider unavailable or unconfigured while registering ${modelSpec.modelId}: ${summary}`);
    }
    return fail('dense search', summary);
  }

  const query = fixtureQuery(env);
  const result = runCommand(
    process.execPath,
    [
      path.join(REPO_ROOT, 'build', 'cli.js'),
      'search',
      query,
      `--kb=${KB_NAME}`,
      '--k=1',
      '--format=json',
      '--no-freshness',
      '--refresh',
    ],
    { env: scratchEnv(env) },
  );
  if (result.status === 0) {
    const parsed = parseJsonOutput(result.stdout);
    if (!parsed || !Array.isArray(parsed.results) || parsed.results.length === 0) {
      return fail('dense search', 'expected at least one JSON result');
    }
    return pass('dense search', `returned ${parsed.results.length} result(s)`);
  }

  const summary = summarizeCommandFailure(result);
  if (mode === 'auto' && isProviderReachabilityFailure(summary)) {
    return skip('dense search', `provider unavailable or unconfigured: ${summary}`);
  }
  return fail('dense search', summary);
}

async function resolveDenseModelSpec() {
  const { computeLegacyEnvModelSpec, deriveModelId } = await import('../src/active-model.ts');
  const spec = computeLegacyEnvModelSpec();
  return {
    modelId: deriveModelId(spec.provider, spec.modelName),
    modelName: spec.modelName,
    provider: spec.provider,
  };
}

function linkedCliStep() {
  const expected = path.join(REPO_ROOT, 'build', 'cli.js');
  const found = findExecutable('kb');
  if (!found) {
    return skip('linked cli', '`kb` was not found on PATH; run npm run dev:setup to link it');
  }

  let resolved;
  try {
    resolved = fs.realpathSync(found);
  } catch (err) {
    return skip('linked cli', `could not resolve ${found}: ${errorMessage(err)}`);
  }

  let expectedResolved;
  try {
    expectedResolved = fs.realpathSync(expected);
  } catch (err) {
    return fail('linked cli', `local build/cli.js is missing: ${errorMessage(err)}`);
  }

  if (resolved !== expectedResolved) {
    return skip('linked cli', `PATH kb points to ${resolved}, not this checkout`);
  }

  const result = runCommand('kb', ['--version'], { env: process.env });
  if (result.status !== 0) {
    return fail('linked cli', summarizeCommandFailure(result));
  }
  return pass('linked cli', `kb --version => ${result.stdout.trim()}`);
}

function commandStep(name, command, args, options) {
  const result = runCommand(command, args, options);
  if (result.status !== 0) {
    return fail(name, summarizeCommandFailure(result));
  }
  return pass(name, result.stdout.trim().split('\n').filter(Boolean).at(-1) ?? 'ok');
}

function runCommand(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: options.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    return {
      status: 1,
      stdout: result.stdout ?? '',
      stderr: `${result.stderr ?? ''}${result.error.message}`,
    };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function scratchEnv(env) {
  return {
    ...process.env,
    FAISS_INDEX_PATH: env.faissDir,
    KNOWLEDGE_BASES_ROOT_DIR: env.rootDir,
    LOG_FILE: '',
  };
}

function fixtureQuery(env) {
  if (env.fixture?.query) return env.fixture.query;
  const parsed = yaml.load(fs.readFileSync(env.fixtureFile, 'utf-8'));
  return parsed.cases[0].query;
}

function parseJsonOutput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(stdout.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function summarizeCommandFailure(result) {
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  const firstUsefulLine = combined
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstUsefulLine
    ? `exit ${result.status}: ${firstUsefulLine}`
    : `exit ${result.status}`;
}

function isProviderReachabilityFailure(summary) {
  return [
    'ACTIVE_MODEL_UNRESOLVED',
    'ECONNREFUSED',
    'HUGGINGFACE_API_KEY',
    'OPENAI_API_KEY',
    'PROVIDER_AUTH',
    'PROVIDER_TIMEOUT',
    'PROVIDER_UNAVAILABLE',
    'fetch failed',
    'ollama',
    'provider',
  ].some((needle) => summary.toLowerCase().includes(needle.toLowerCase()));
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
    `kb-dev-doctor\npid=${process.pid}\ncreated=${new Date().toISOString()}\n`,
    { flag: 'wx' },
  );
}

async function cleanupScratch(outRoot) {
  const markerPath = path.join(outRoot, OWNERSHIP_MARKER);
  try {
    const marker = await fsp.readFile(markerPath, 'utf-8');
    if (!marker.startsWith('kb-dev-doctor\n')) {
      throw new Error('unexpected marker contents');
    }
  } catch (err) {
    process.stderr.write(
      `dev:doctor: refusing to remove ${outRoot}; ownership marker missing or invalid (${errorMessage(err)})\n`,
    );
    return;
  }
  await fsp.rm(outRoot, { recursive: true, force: true });
}

function findExecutable(command) {
  const pathValue = process.env.PATH ?? '';
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, `${command}${ext.toLowerCase()}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Try the next PATH candidate.
      }
    }
  }
  return null;
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function formatReport(env, report) {
  const counts = {
    fail: report.filter((entry) => entry.status === 'fail').length,
    pass: report.filter((entry) => entry.status === 'pass').length,
    skip: report.filter((entry) => entry.status === 'skip').length,
  };
  const lines = [
    '',
    'dev:doctor report',
    `scratch: ${env.outRoot}`,
    `KNOWLEDGE_BASES_ROOT_DIR=${env.rootDir}`,
    `FAISS_INDEX_PATH=${env.faissDir}`,
    '',
    ...report.map((entry) => `[${entry.status}] ${entry.name}: ${entry.detail}`),
    '',
    `summary: ${counts.pass} passed, ${counts.skip} skipped, ${counts.fail} failed`,
    '',
  ];
  return lines.join('\n');
}

function pass(name, detail) {
  return { status: 'pass', name, detail: detail || 'ok' };
}

function skip(name, detail) {
  return { status: 'skip', name, detail };
}

function fail(name, detail) {
  return { status: 'fail', name, detail };
}

function quoteYamlScalar(text) {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

const isDirectInvocation = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (isDirectInvocation) {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error && err.stack ? err.stack : String(err);
    process.stderr.write(`dev:doctor: fatal: ${msg}\n`);
    process.exitCode = 1;
  }
}

export { parseArgs, run, HELP };
