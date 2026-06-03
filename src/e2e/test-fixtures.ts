// src/e2e/test-fixtures.ts
//
// Issue #222 — spawn-the-binary MCP-client end-to-end test harness.
//
// Boots the built MCP server (`build/index.js`) as a child process, hands
// callers an `@modelcontextprotocol/sdk` `Client` connected via
// `StdioClientTransport`, and tears the child down deterministically on
// shutdown. Production clients (Claude Desktop, Codex, Cursor, Continue,
// Cline) all launch this exact entrypoint over stdio — these helpers let
// Jest exercise the same surface.
//
// By default the harness remains embedder-free for lightweight tool tests.
// Retrieval tests can opt into a temp active model registration plus the fake
// provider so embedder-dependent handlers run without network or user state.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(process.cwd());
const SERVER_BINARY = path.join(REPO_ROOT, 'build', 'index.js');

export interface KnowledgeBaseSpec {
  /** Files to seed, keyed by KB-relative path. Values are UTF-8 file contents. */
  files: Record<string, string>;
}

export interface ActiveModelSpec {
  /** Registered model_id, e.g. "fake__parity-32d". */
  modelId: string;
  /** Contents of models/<modelId>/model_name.txt. */
  modelName: string;
}

export interface StartHarnessOptions {
  /**
   * Knowledge bases to materialise under the temp `KNOWLEDGE_BASES_ROOT_DIR`.
   * Each top-level key becomes a KB name (a subdirectory); values describe
   * the files to write inside that KB.
   */
  knowledgeBases?: Record<string, KnowledgeBaseSpec>;
  /**
   * Optional active model registration written before the binary starts.
   * Retrieval E2E tests use this with the fake provider so both CLI and MCP
   * resolve the same deterministic model from active.txt without network.
   */
  activeModel?: ActiveModelSpec;
  /**
   * Extra environment variables passed to the spawned binary. Override or
   * augment the harness defaults; if absent, the child runs with a
   * sterile temp env that touches no shared user state.
   */
  extraEnv?: Record<string, string>;
  /**
   * Per-call hard cap on individual MCP request wall-time. Defaults to
   * 10s — listTools/listKnowledgeBases on a stub tree complete in single
   * digits of milliseconds locally; a 10s ceiling absorbs cold-start
   * variance (FAISS layout migration on first boot) without letting a
   * stuck child hang the suite indefinitely.
   */
  requestTimeoutMs?: number;
}

export interface E2eHarness {
  /** A connected MCP `Client` ready to issue `listTools` / `callTool`. */
  client: Client;
  /** Absolute path of the temp `KNOWLEDGE_BASES_ROOT_DIR` seeded for the harness. */
  knowledgeBasesRootDir: string;
  /** Absolute path of the temp `FAISS_INDEX_PATH` for the harness. */
  faissIndexPath: string;
  /**
   * Closes the MCP client (which SIGTERMs the spawned binary) and removes
   * the harness's temp tree. Idempotent — safe to call from afterEach
   * even if the test already shut down the harness inside its body.
   */
  shutdown(): Promise<void>;
}

async function writeKnowledgeBases(
  rootDir: string,
  knowledgeBases: Record<string, KnowledgeBaseSpec> | undefined,
): Promise<void> {
  if (!knowledgeBases) return;
  for (const [kbName, spec] of Object.entries(knowledgeBases)) {
    const kbDir = path.join(rootDir, kbName);
    await fsp.mkdir(kbDir, { recursive: true });
    for (const [relPath, content] of Object.entries(spec.files)) {
      const absPath = path.join(kbDir, relPath);
      await fsp.mkdir(path.dirname(absPath), { recursive: true });
      await fsp.writeFile(absPath, content, 'utf-8');
    }
  }
}

async function writeActiveModel(
  faissIndexPath: string,
  activeModel: ActiveModelSpec | undefined,
): Promise<void> {
  if (!activeModel) return;
  const modelDir = path.join(faissIndexPath, 'models', activeModel.modelId);
  await fsp.mkdir(modelDir, { recursive: true });
  await fsp.writeFile(path.join(modelDir, 'model_name.txt'), activeModel.modelName, 'utf-8');
  await fsp.writeFile(path.join(faissIndexPath, 'active.txt'), activeModel.modelId, 'utf-8');
}

function buildChildEnv(
  knowledgeBasesRootDir: string,
  faissIndexPath: string,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  // Inherit only the variables a Node child genuinely needs (PATH, HOME,
  // NODE_*) and then layer the harness's temp paths on top. We avoid
  // forwarding the parent's HUGGINGFACE_API_KEY / OPENAI_API_KEY / etc.
  // so a missing-key test produces the same failure shape regardless of
  // the developer's shell.
  const safeKeys = ['PATH', 'HOME', 'NODE_PATH', 'NODE_OPTIONS', 'TMPDIR', 'TEMP', 'TMP'];
  const inherited: Record<string, string> = {};
  for (const key of safeKeys) {
    const value = process.env[key];
    if (value !== undefined) inherited[key] = value;
  }
  return {
    ...inherited,
    KNOWLEDGE_BASES_ROOT_DIR: knowledgeBasesRootDir,
    FAISS_INDEX_PATH: faissIndexPath,
    // The trigger watcher polls disk on a timer and is irrelevant to wire
    // tests. Disabling it removes one source of background load + log
    // noise for the harness's lifetime.
    REINDEX_TRIGGER_POLL_MS: '0',
    ...(extra ?? {}),
  };
}

/**
 * Boots `build/index.js` as a child process and returns a connected MCP
 * `Client`. Caller must `await harness.shutdown()` (typically from
 * `afterEach`) to terminate the child and remove the temp tree.
 *
 * Pre-condition: the project has been built (`npm run build`); the
 * harness asserts this and throws a descriptive error if `build/index.js`
 * is missing so a contributor running tests from a fresh checkout sees
 * a clear "build first" message rather than an opaque ENOENT from spawn.
 */
export async function startMcpBinaryHarness(
  opts: StartHarnessOptions = {},
): Promise<E2eHarness> {
  await assertServerBinaryBuilt();

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-e2e-'));
  const knowledgeBasesRootDir = path.join(tmpRoot, 'kb');
  const faissIndexPath = path.join(tmpRoot, 'faiss');
  await fsp.mkdir(knowledgeBasesRootDir, { recursive: true });
  await fsp.mkdir(faissIndexPath, { recursive: true });
  await writeKnowledgeBases(knowledgeBasesRootDir, opts.knowledgeBases);
  await writeActiveModel(faissIndexPath, opts.activeModel);

  const env = buildChildEnv(knowledgeBasesRootDir, faissIndexPath, opts.extraEnv);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_BINARY],
    env,
    // Drain the child's stderr into the parent process's stderr — the
    // server emits structured logs there (logger.ts pins stderr-only).
    // If a test fails, the test runner's captured stderr already shows
    // the server-side trace without bespoke plumbing.
    stderr: 'inherit',
  });

  const client = new Client({
    name: 'kb-e2e-test-client',
    version: '0.0.0-test',
  });

  await client.connect(transport);

  let shutdownCompleted = false;
  const shutdown = async (): Promise<void> => {
    if (shutdownCompleted) return;
    shutdownCompleted = true;
    try {
      await client.close();
    } catch {
      // Closing a Client that already saw its transport go away can
      // surface as an EPIPE / "Transport not started"; either way the
      // child is gone and we're moving on to filesystem cleanup.
    }
    try {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; the OS will reap /tmp eventually.
    }
  };

  return {
    client,
    knowledgeBasesRootDir,
    faissIndexPath,
    shutdown,
  };
}

async function assertServerBinaryBuilt(): Promise<void> {
  try {
    await fsp.access(SERVER_BINARY);
  } catch {
    throw new Error(
      `E2E harness cannot find ${SERVER_BINARY}. Run \`npm run build\` before \`npm test\` so the harness has a binary to spawn.`,
    );
  }
}

/**
 * Convenience helper: parses the JSON text payload returned by tools that
 * serialise their result as `content: [{ type: 'text', text: JSON }]`
 * (`list_knowledge_bases`, `list_models`, `kb_stats`, …). Centralised here
 * so individual tests stay focused on the property under test rather than
 * MCP envelope plumbing.
 */
export function parseToolJsonText(result: {
  content: Array<{ type: string; text?: string }>;
}): unknown {
  const first = result.content[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(
      `Expected first content block to be a text JSON payload, got: ${JSON.stringify(result)}`,
    );
  }
  return JSON.parse(first.text);
}
