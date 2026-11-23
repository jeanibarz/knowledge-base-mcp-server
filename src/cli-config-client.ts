import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { showConfigEnv, type ConfigShowEntry } from './config/schema.js';
import { getProjectConfig, projectConfigAppliedSources } from './config/project-config.js';
import { parseModelId } from './model-id.js';
import { resolveActiveModel } from './model-resolution.js';
import { readStoredModelName } from './model-storage-layout.js';

// Help text lives in CONFIG_HELP (src/cli-config.ts): the kb dispatcher prints
// it for `kb config client --help` and its typo guard reads flags from it.

export const SUPPORTED_CLIENTS = [
  'claude-desktop',
  'cursor',
  'windsurf',
  'cline',
  'vscode',
  'claude-code',
  'codex',
] as const;

export type ClientName = (typeof SUPPORTED_CLIENTS)[number];

export const SERVER_NAME = 'knowledge-base';
export const PACKAGE_SPEC = '@jeanibarz/knowledge-base-mcp-server@latest';
export const SERVER_BIN = 'knowledge-base-mcp-server';

export interface ConfigClientArgs {
  client: ClientName;
  format: 'md' | 'json';
  command: 'npx' | 'global';
}

export interface ConfigClientReport {
  schema_version: 'kb.config-client.v1';
  client: ClientName;
  shape: 'mcpServers' | 'servers' | 'shell' | 'toml';
  command_mode: 'npx' | 'global';
  config_file: string | null;
  active_model: string | null;
  config_locations: string[];
  command: string;
  args: string[];
  env: Record<string, string>;
  placeholders: string[];
  snippet: string;
}

interface ClientInfo {
  shape: ConfigClientReport['shape'];
  locations: string[];
}

const CLIENTS: Record<ClientName, ClientInfo> = {
  'claude-desktop': {
    shape: 'mcpServers',
    locations: [
      'macOS: ~/Library/Application Support/Claude/claude_desktop_config.json',
      'Windows: %APPDATA%\\Claude\\claude_desktop_config.json',
    ],
  },
  cursor: {
    shape: 'mcpServers',
    locations: ['Global: ~/.cursor/mcp.json', 'Per project: <project>/.cursor/mcp.json'],
  },
  windsurf: {
    shape: 'mcpServers',
    locations: [
      'macOS / Linux: ~/.codeium/windsurf/mcp_config.json',
      'Windows: %USERPROFILE%\\.codeium\\windsurf\\mcp_config.json',
    ],
  },
  cline: {
    shape: 'mcpServers',
    locations: ['cline_mcp_settings.json (open it from Cline with "MCP: Edit Settings")'],
  },
  vscode: {
    shape: 'servers',
    locations: [
      'Project: .vscode/mcp.json',
      'User settings.json: nest the "servers" object under a top-level "mcp" key',
    ],
  },
  'claude-code': {
    shape: 'shell',
    locations: ['Run the command in a shell; -s user makes the server available in every project'],
  },
  codex: {
    shape: 'toml',
    locations: [
      'macOS / Linux: ~/.codex/config.toml ($CODEX_HOME/config.toml when CODEX_HOME is set)',
      'Windows: %USERPROFILE%\\.codex\\config.toml',
    ],
  },
};

// Variables emitted for each embedding provider, in output order.
// `always` vars appear even when unset (a placeholder for secrets, the
// effective default otherwise); `ifSet` vars only when env or the project
// config supplies them, so the snippet stays short for default setups.
const PROVIDER_VARS: Record<string, { model?: string; always: string[]; ifSet: string[] }> = {
  huggingface: {
    model: 'HUGGINGFACE_MODEL_NAME',
    always: ['HUGGINGFACE_API_KEY', 'HUGGINGFACE_MODEL_NAME'],
    ifSet: ['HUGGINGFACE_PROVIDER', 'HUGGINGFACE_ENDPOINT_URL'],
  },
  ollama: {
    model: 'OLLAMA_MODEL',
    always: ['OLLAMA_BASE_URL', 'OLLAMA_MODEL'],
    ifSet: [],
  },
  openai: {
    model: 'OPENAI_MODEL_NAME',
    always: ['OPENAI_API_KEY', 'OPENAI_MODEL_NAME'],
    ifSet: ['OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID'],
  },
  fake: {
    always: [],
    ifSet: ['KB_FAKE_DIM'],
  },
};

export interface ActiveModelInfo {
  id: string;
  provider: string;
  modelName: string | null;
}

export interface RunConfigClientOptions {
  /** Resolves the absolute server bin path for --command=global; null when absent. */
  resolveServerBin?: () => string | null;
  /** Resolves the registered active model; null when none resolves. */
  resolveActive?: () => Promise<ActiveModelInfo | null>;
}

/**
 * The server embeds with the active model (KB_ACTIVE_MODEL > active.txt >
 * env-derived id), not with EMBEDDING_PROVIDER alone, so the snippet must
 * carry that model's provider settings. Read-only: never registers a model.
 * Resolution errors (no model registered yet, stale active.txt) return null
 * and the snippet falls back to the env-derived first-run model.
 */
export async function resolveActiveModelInfo(): Promise<ActiveModelInfo | null> {
  try {
    const id = await resolveActiveModel();
    return { id, provider: parseModelId(id).provider, modelName: await readStoredModelName(id) };
  } catch {
    return null;
  }
}

export async function runConfigClient(
  rest: readonly string[],
  options: RunConfigClientOptions = {},
): Promise<number> {
  let parsed: ConfigClientArgs;
  try {
    parsed = parseConfigClientArgs(rest);
  } catch (err) {
    process.stderr.write(`kb config client: ${(err as Error).message}\n`);
    return 2;
  }

  let projectConfig: ReturnType<typeof getProjectConfig>;
  try {
    projectConfig = getProjectConfig();
  } catch (err) {
    process.stderr.write(`kb config client: ${(err as Error).message}\n`);
    return 2;
  }

  let launch: { command: string; args: string[] };
  if (parsed.command === 'global') {
    const bin = (options.resolveServerBin ?? (() => findOnPath(SERVER_BIN)))();
    if (bin === null) {
      process.stderr.write(
        `kb config client: ${SERVER_BIN} not found on PATH; install it with `
        + '`npm install -g @jeanibarz/knowledge-base-mcp-server@latest` or use --command=npx\n',
      );
      return 2;
    }
    launch = { command: bin, args: [] };
  } else {
    launch = { command: 'npx', args: ['-y', PACKAGE_SPEC] };
  }

  const report = showConfigEnv(process.env, {
    configFile: projectConfig.path,
    sources: projectConfigAppliedSources(projectConfig),
  });
  const active = await (options.resolveActive ?? resolveActiveModelInfo)();
  let env: { env: Record<string, string>; placeholders: string[] };
  try {
    env = buildClientEnv(report.entries, active);
  } catch (err) {
    process.stderr.write(`kb config client: ${(err as Error).message}\n`);
    return 2;
  }

  const out = buildClientReport(parsed, launch, env, projectConfig.path, active?.id ?? null);
  if (parsed.format === 'json') {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    process.stdout.write(formatConfigClientMarkdown(out));
  }
  return 0;
}

export function parseConfigClientArgs(rest: readonly string[]): ConfigClientArgs {
  let client: string | undefined;
  let format: ConfigClientArgs['format'] = 'md';
  let command: ConfigClientArgs['command'] = 'npx';
  for (const raw of rest) {
    if (raw === '--format=json' || raw === '--format=md') {
      format = raw === '--format=json' ? 'json' : 'md';
      continue;
    }
    if (raw.startsWith('--format=')) throw new Error(`invalid --format: ${raw}`);
    if (raw === '--command=npx' || raw === '--command=global') {
      command = raw === '--command=npx' ? 'npx' : 'global';
      continue;
    }
    if (raw.startsWith('--command=')) throw new Error(`invalid --command: ${raw} (expected npx or global)`);
    if (raw.startsWith('-')) throw new Error(`unknown flag: ${raw}`);
    if (client !== undefined) throw new Error(`unexpected argument: ${raw}`);
    client = raw;
  }
  const supported = `supported clients: ${SUPPORTED_CLIENTS.join(', ')}`;
  if (client === undefined) throw new Error(`expected a client name; ${supported}`);
  if (!(SUPPORTED_CLIENTS as readonly string[]).includes(client)) {
    throw new Error(`unknown client: ${client}; ${supported}`);
  }
  return { client: client as ClientName, format, command };
}

/**
 * Picks the env vars a client needs from `kb config show` entries. Values the
 * schema redacts (API keys, tokens) become `<NAME>` placeholders, so a secret
 * never reaches the output whether or not it is set.
 */
export function buildClientEnv(
  entries: readonly ConfigShowEntry[],
  active: ActiveModelInfo | null = null,
): { env: Record<string, string>; placeholders: string[] } {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const provider = active?.provider ?? byName.get('EMBEDDING_PROVIDER')?.value ?? 'huggingface';
  const vars = PROVIDER_VARS[provider];
  if (vars === undefined) {
    throw new Error(
      `unsupported EMBEDDING_PROVIDER=${JSON.stringify(provider)} `
      + `(expected one of: ${Object.keys(PROVIDER_VARS).join(', ')}); run \`kb config validate\``,
    );
  }

  const env: Record<string, string> = {};
  const placeholders: string[] = [];
  const emit = (name: string, onlyIfSet: boolean): void => {
    const entry = byName.get(name);
    if (entry === undefined) return;
    if (onlyIfSet && entry.source === 'default') return;
    if (entry.redacted || entry.kind === 'secret') {
      env[name] = `<${name}>`;
      placeholders.push(name);
      return;
    }
    if (entry.value === null) return;
    if (name === vars.model && active !== null && active.modelName !== null) {
      env[name] = active.modelName;
      return;
    }
    if (entry.kind === 'path' && entry.value !== '') {
      // The client spawns the server from its own cwd (often / or $HOME).
      env[name] = absolutePath(entry.value);
      return;
    }
    if (entry.kind === 'url' && urlCarriesCredentials(entry.value)) {
      env[name] = `<${name}>`;
      placeholders.push(name);
      return;
    }
    env[name] = entry.value;
  };

  emit('KNOWLEDGE_BASES_ROOT_DIR', false);
  emit('FAISS_INDEX_PATH', true);
  env.EMBEDDING_PROVIDER = provider;
  for (const name of vars.always) emit(name, false);
  for (const name of vars.ifSet) emit(name, true);
  emit('KB_ACTIVE_MODEL', true);
  return { env, placeholders };
}

export function buildClientReport(
  args: ConfigClientArgs,
  launch: { command: string; args: string[] },
  env: { env: Record<string, string>; placeholders: string[] },
  configFile: string | null,
  activeModel: string | null = null,
): ConfigClientReport {
  const info = CLIENTS[args.client];
  return {
    schema_version: 'kb.config-client.v1',
    client: args.client,
    shape: info.shape,
    command_mode: args.command,
    config_file: configFile,
    active_model: activeModel,
    config_locations: info.locations,
    command: launch.command,
    args: launch.args,
    env: env.env,
    placeholders: env.placeholders,
    snippet: renderSnippet(info.shape, launch, env.env),
  };
}

function renderSnippet(
  shape: ConfigClientReport['shape'],
  launch: { command: string; args: string[] },
  env: Record<string, string>,
): string {
  if (shape === 'shell') {
    const parts = [`claude mcp add ${SERVER_NAME} -s user`];
    for (const [name, value] of Object.entries(env)) parts.push(`-e ${shellQuote(`${name}=${value}`)}`);
    parts.push(['--', launch.command, ...launch.args].map(shellQuote).join(' '));
    return parts.join(' \\\n  ');
  }
  if (shape === 'toml') {
    const table = `mcp_servers.${tomlKey(SERVER_NAME)}`;
    const lines = [
      `[${table}]`,
      `command = ${tomlString(launch.command)}`,
      `args = [${launch.args.map(tomlString).join(', ')}]`,
      '',
      `[${table}.env]`,
      ...Object.entries(env).map(([name, value]) => `${tomlKey(name)} = ${tomlString(value)}`),
    ];
    return lines.join('\n');
  }
  const server = {
    ...(shape === 'servers' ? { type: 'stdio' } : {}),
    command: launch.command,
    args: launch.args,
    env,
  };
  return JSON.stringify({ [shape]: { [SERVER_NAME]: server } }, null, 2);
}

/**
 * A TOML basic string (`"..."`). TOML requires escaping the quote, the
 * backslash and every control character except tab (U+0000-U+001F, U+007F);
 * Windows paths are full of backslashes, so this is not optional.
 */
export function tomlString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '"') out += '\\"';
    else if (char === '\\') out += '\\\\';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (char === '\b') out += '\\b';
    else if (char === '\f') out += '\\f';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += char;
  }
  return `${out}"`;
}

/** A TOML key: bare when it only uses A-Z a-z 0-9 _ -, quoted otherwise. */
export function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/** POSIX single-quote a word unless it is made only of shell-safe characters. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function formatConfigClientMarkdown(report: ConfigClientReport): string {
  const lang = report.shape === 'shell' ? 'bash' : report.shape === 'toml' ? 'toml' : 'json';
  const lines = [
    `# kb config client ${report.client}`,
    '',
    `config_file: ${report.config_file ?? '(none)'}`,
    `active_model: ${report.active_model ?? '(none registered; the server registers the env-derived model on first run)'}`,
    '',
    report.shape === 'shell' ? 'Where:' : 'Paste into:',
    ...report.config_locations.map((loc) => `- ${loc}`),
    '',
    `\`\`\`${lang}`,
    report.snippet,
    '```',
  ];
  if (report.placeholders.length > 0) {
    lines.push('', `Replace these placeholders before use: ${report.placeholders.map((n) => `<${n}>`).join(', ')}`);
  }
  if (report.shape === 'toml') {
    lines.push('', 'Codex CLI rereads config.toml each time it starts, so no restart is needed.');
  } else if (report.shape !== 'shell') {
    lines.push('', 'Restart the client after editing its config file.');
  }
  return `${lines.join('\n')}\n`;
}

function absolutePath(value: string): string {
  if (value === '~' || value.startsWith('~/')) return path.join(os.homedir(), value.slice(1));
  return path.resolve(value);
}

/** True when a URL embeds userinfo or a query string, which may hold a key. */
function urlCarriesCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return url.username !== '' || url.password !== '' || url.search !== '';
  } catch {
    return false;
  }
}

/**
 * Absolute path of the first executable named `name` on PATH, or null.
 * Skips npx caches and node_modules/.bin, which are prepended to PATH by
 * `npx`/npm scripts and would bake a temporary path into a client config.
 */
export function findOnPath(
  name: string,
  envPath: string | undefined = process.env.PATH,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const candidates = platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  for (const dir of (envPath ?? '').split(path.delimiter)) {
    if (dir === '' || /[\\/]_npx[\\/]|[\\/]node_modules[\\/]\.bin[\\/]?$/.test(dir)) continue;
    for (const candidate of candidates) {
      const full = path.resolve(dir, candidate);
      try {
        fs.accessSync(full, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        if (fs.statSync(full).isFile()) return full;
      } catch {
        // not here; keep looking
      }
    }
  }
  return null;
}
