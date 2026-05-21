#!/usr/bin/env node
import http from 'node:http';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_PORT = 18080;
const DEFAULT_BIND = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;

const HELP = `npm run dev:mockllm — run a deterministic OpenAI-compatible fake LLM

Usage:
  npm run dev:mockllm -- [--bind=<host>] [--port=<int>] [--rules=<path>] [--help]

Starts a tiny localhost server for offline LLM-dependent development. It
implements GET /health and POST /v1/chat/completions. The chat route uses the
same deterministic fake responder as KB_LLM_FAKE=on.

Options:
  --bind=<host>         Bind address (default: ${DEFAULT_BIND}).
  --port=<int>          Port 1-65535 (default: ${DEFAULT_PORT}).
  --rules=<path>        Optional JSON rules file, same schema as KB_LLM_FAKE_RULES.
  --help, -h            Show this help.
`;

function parseArgs(argv) {
  const out = { bind: DEFAULT_BIND, port: DEFAULT_PORT, rules: null, help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg.startsWith('--bind=')) {
      const value = arg.slice('--bind='.length).trim();
      if (!value) throw new Error('--bind requires a non-empty host');
      out.bind = value;
    } else if (arg.startsWith('--port=')) {
      const raw = arg.slice('--port='.length);
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        throw new Error(`--port must be an integer from 1 to 65535, got: ${raw}`);
      }
      out.port = value;
    } else if (arg.startsWith('--rules=')) {
      const value = arg.slice('--rules='.length).trim();
      if (!value) throw new Error('--rules requires a non-empty path');
      out.rules = path.resolve(value);
    } else {
      throw new Error(`unknown argument: ${arg} (use --help to see options)`);
    }
  }
  return out;
}

async function run(argv, deps = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`dev:mockllm: ${err.message}\n`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const fakeModuleUrl = new URL('../src/llm-fake-stub.ts', import.meta.url);
  const { fakeOpenAiChatCompletionResponse } = await import(fakeModuleUrl.href);
  const rules = args.rules === null
    ? {}
    : JSON.parse(await fsp.readFile(args.rules, 'utf-8'));

  const server = (deps.createServer ?? http.createServer)((req, res) => {
    void handleRequest(req, res, fakeOpenAiChatCompletionResponse, rules);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(args.port, args.bind, resolve);
  });

  const endpoint = `http://${formatHost(args.bind)}:${args.port}/v1/chat/completions`;
  process.stdout.write([
    '',
    'Fake LLM server ready.',
    `  endpoint: ${endpoint}`,
    `  health:   http://${formatHost(args.bind)}:${args.port}/health`,
    args.rules ? `  rules:    ${args.rules}` : '  rules:    defaults',
    '',
    'Use it with:',
    `  KB_LLM_ENDPOINT=${endpoint} kb ask 'What changed?'`,
    `  KB_LLM_ENDPOINT=${endpoint} KB_RELEVANCE_GATE=on kb search 'rollback' --gate --task-context='answer an operations question'`,
    '',
  ].join('\n'));
  return new Promise(() => {});
}

async function handleRequest(req, res, fakeOpenAiChatCompletionResponse, rules) {
  if (req.method === 'GET' && req.url === '/health') {
    writeJson(res, 200, { status: 'ok', provider: 'fake' });
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    writeJson(res, 404, { error: { message: 'not found' } });
    return;
  }

  let body;
  try {
    body = await readRequestBody(req, MAX_BODY_BYTES);
  } catch (err) {
    writeJson(res, 413, { error: { message: err.message } });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    writeJson(res, 400, { error: { message: 'request body must be JSON' } });
    return;
  }

  writeJson(res, 200, fakeOpenAiChatCompletionResponse(parsed, rules));
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function formatHost(host) {
  return host.includes(':') ? `[${host}]` : host;
}

const isDirectInvocation = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (isDirectInvocation) {
  try {
    const result = await run(process.argv.slice(2));
    if (typeof result === 'number') process.exitCode = result;
  } catch (err) {
    const msg = err instanceof Error && err.stack ? err.stack : String(err);
    process.stderr.write(`dev:mockllm: fatal: ${msg}\n`);
    process.exitCode = 1;
  }
}

export { HELP, DEFAULT_PORT, parseArgs, run };
